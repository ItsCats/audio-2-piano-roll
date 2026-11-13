/**
 * Monophonic vocal pitch tracking with CREPE "tiny" (Kim et al. 2018; MIT weights via torchcrepe,
 * see public/models/crepe/README.md) on onnxruntime-web, for the sung melody line.
 *
 * trackVocalPitch() takes the separated vocal stem (mono 22.05 kHz, the timebase of the rest of
 * the pipeline) and returns
 *   f0           Hz per 10 ms frame, 0 where the frame is unvoiced (periodicity gate + loudness gate)
 *   periodicity  CREPE confidence at the decoded pitch (0..1, 0 for frames too quiet to analyse)
 *   notes        note candidates (role 'melody', hand 'R', vel = mean periodicity) for
 *                music/melody.ts extractMelodyLine()
 *   hop          seconds per frame
 * The input array is copied, never modified or detached. Runs in a fresh worker that is
 * terminated afterwards (also on abort).
 */
import type { Note } from '../music/types';
import { CREPE_RATE, medianFilter } from './crepe';
import type { TrackStats, WorkerResponse } from './protocol';
import { DEFAULT_SEGMENT, f0ToNotes, type SegmentOptions } from './segment';
import { watchWorker } from '../newVersion';

export { f0ToNotes, DEFAULT_SEGMENT } from './segment';
export type { SegmentOptions } from './segment';

export const CREPE_MODEL_PATH = 'models/crepe/crepe-tiny.onnx';
export const CREPE_MODEL_SHA256 = '4d10f6f519aa15936c8b179e8a6c1f6ce3ea3683ddeea7ee6e3ee5549de7242f';
export const CREPE_MODEL_BYTES = 1_962_678;
/** input sample rate of trackVocalPitch (the pipeline's rate) */
export const PITCH_INPUT_RATE = 22050;

export interface PitchOptions {
  /** hop in ms (10 = CREPE's usual; 20 halves the work) */
  hopMs: number;
  /** sung range (Hz): bins outside are excluded from decoding */
  fmin: number;
  fmax: number;
  /** a frame is voiced when its median-filtered (3 frames) periodicity reaches this */
  voicingThreshold: number;
  /** ...and its RMS is within this many dB of the stem's 95th-percentile frame RMS */
  loudnessDb: number;
  /** frames quieter than this (dB re the same reference) skip the network (they cannot be voiced) */
  skipDb: number;
  /** frames per network call */
  batch: number;
  segment: Partial<SegmentOptions>;
  /** for tests / harnesses */
  modelUrl?: string;
  sampleRate?: number;
}

export const DEFAULT_PITCH: PitchOptions = {
  hopMs: 10,
  fmin: 65,
  fmax: 1100,
  voicingThreshold: 0.5,
  loudnessDb: -35,
  skipDb: -40,
  batch: 128,
  segment: {},
};

export interface PitchTrack {
  notes: Note[];
  f0: Float32Array;
  periodicity: Float32Array;
  hop: number;
}

export interface PitchTrackDetail extends PitchTrack {
  /** f0 of every analysed frame before the voicing gate */
  rawF0: Float32Array;
  rms: Float32Array;
  stats: TrackStats & { totalMs: number };
}

const abortError = () => new DOMException('Pitch tracking cancelled', 'AbortError');

/** Voicing gate: median-filtered periodicity >= threshold and RMS within `loudnessDb` of the 95th percentile. */
export function voicingMask(periodicity: Float32Array, rms: Float32Array, threshold: number, loudnessDb: number): Uint8Array {
  const per = medianFilter(periodicity, 3);
  const sorted = Array.from(rms).filter((v) => v > 1e-7).sort((a, b) => a - b);
  const ref = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(0.95 * sorted.length))] : 0;
  const gate = ref * 10 ** (loudnessDb / 20);
  const out = new Uint8Array(periodicity.length);
  for (let i = 0; i < out.length; i++) out[i] = ref > 0 && per[i] >= threshold && rms[i] >= gate ? 1 : 0;
  return out;
}

/** Full result including the raw track and timings (harnesses); trackVocalPitch() is the app API. */
export function trackVocalPitchDetailed(
  vocals22k: Float32Array,
  onProgress?: (fraction: number, detail?: string) => void,
  signal?: AbortSignal,
  options: Partial<PitchOptions> = {},
): Promise<PitchTrackDetail> {
  const o = { ...DEFAULT_PITCH, ...options, segment: { ...DEFAULT_SEGMENT, ...options.segment } };
  if (signal?.aborted) return Promise.reject(abortError());
  const t0 = performance.now();
  const hopSamples = Math.round((o.hopMs / 1000) * CREPE_RATE);
  const hop = hopSamples / CREPE_RATE;
  const modelUrl = new URL(o.modelUrl ?? `${import.meta.env.BASE_URL}${CREPE_MODEL_PATH}?v=${CREPE_MODEL_SHA256.slice(0, 8)}`, location.href).href;
  const audio = vocals22k.slice();
  return new Promise<PitchTrackDetail>((resolve, reject) => {
    const worker = watchWorker(new Worker(new URL('./crepe.worker.ts', import.meta.url), { type: 'module', name: 'crepe-pitch' }));
    let settled = false;
    const finish = () => {
      settled = true;
      worker.terminate();
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      finish();
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const m = e.data;
      if (settled) return;
      if (m.type === 'progress') {
        if (m.phase === 'load') onProgress?.(m.done ? 0.05 : 0, m.done ? 'Vocal pitch model ready' : 'Loading the vocal pitch model');
        else onProgress?.(0.05 + 0.93 * (m.done / Math.max(1, m.total)), 'Tracking the vocal pitch');
        return;
      }
      finish();
      if (m.type === 'error') {
        reject(new Error(m.message));
        return;
      }
      const voiced = voicingMask(m.periodicity, m.rms, o.voicingThreshold, o.loudnessDb);
      const f0 = new Float32Array(m.f0.length);
      for (let i = 0; i < f0.length; i++) f0[i] = voiced[i] ? m.f0[i] : 0;
      const notes = f0ToNotes(f0, m.periodicity, hop, o.segment);
      onProgress?.(1, 'Vocal pitch tracked');
      resolve({ notes, f0, periodicity: m.periodicity, hop, rawF0: m.f0, rms: m.rms, stats: { ...m.stats, totalMs: performance.now() - t0 } });
    };
    worker.onerror = (e) => {
      if (settled) return;
      finish();
      reject(new Error(`The pitch tracking worker failed${e.message ? `: ${e.message}` : ''}.`));
    };
    worker.postMessage(
      {
        type: 'track',
        audio,
        sampleRate: o.sampleRate ?? PITCH_INPUT_RATE,
        modelUrl,
        hop: hopSamples,
        fmin: o.fmin,
        fmax: o.fmax,
        skipDb: Math.min(o.skipDb, o.loudnessDb),
        batch: o.batch,
      },
      [audio.buffer],
    );
  });
}

/**
 * Track the sung pitch of a separated vocal stem (mono 22.05 kHz). Progress fractions are real
 * work (model load, then frames analysed). Rejects with an AbortError when `signal` aborts.
 */
export async function trackVocalPitch(
  vocals22k: Float32Array,
  onProgress?: (fraction: number, detail?: string) => void,
  signal?: AbortSignal,
  options: Partial<PitchOptions> = {},
): Promise<PitchTrack> {
  const r = await trackVocalPitchDetailed(vocals22k, onProgress, signal, options);
  return { notes: r.notes, f0: r.f0, periodicity: r.periodicity, hop: r.hop };
}
