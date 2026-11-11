/**
 * In-browser source separation with SCNet (MIT, starrytong; int8 ONNX by audiojs) on onnxruntime-web.
 *
 * separateStems() decodes the file at 44.1 kHz stereo, runs SCNet segment by segment in a dedicated
 * module worker and returns, at 22.05 kHz mono on the same timebase as decodeToRate(blob, 22050):
 *   vocals  — stem 3
 *   accomp  — stems 1 + 2 (bass + other: no drums, no vocals)
 * plus a vocal-presence estimate so instrumentals can skip the vocal-melody path.
 */
import { decodeToRate, mixToMono } from '../transcription/decode';
import { DEFAULT_STEP, SCNET_RATE, planSegments, vocalPresence } from './dsp';
import type { WorkerResponse, WorkerStats } from './protocol';

export interface VocalPresence {
  activeFraction: number;
  relDb: number;
  present: boolean;
}

export interface SeparationResult {
  /** always 22050 */
  sampleRate: number;
  /** mono 22.05 kHz, same length/timebase as the mixture decoded at 22.05 kHz */
  vocals: Float32Array;
  /** bass + other (no drums, no vocals), mono 22.05 kHz */
  accomp: Float32Array;
  vocalPresence: VocalPresence;
  engine: 'scnet-browser' | 'scnet-server';
  ms: number;
}

export interface SeparationSupport {
  ok: boolean;
  recommended: boolean;
  reason?: string;
  estSecondsPerMinute: number;
}

export const SEPARATION_RATE = 22050;
export const SCNET_MODEL_PATH = 'models/scnet/scnet.int8.onnx';
export const SCNET_MODEL_SHA256 = '98228931494151762a1c4ab1ec7899a894b1f81fd4a509921a9d2f9bacc50845';
export const SCNET_MODEL_BYTES = 12_900_277;
/**
 * Measured wall time per minute of audio, single-threaded WASM in headless Chromium on a shared
 * 4-core x86 box (tests/e2e/separation.mjs: 127.5 s/min on two 90 s songs, 170 s/min on a 30 s excerpt
 * where model load weighs more). Real desktops are usually faster.
 */
export const EST_SECONDS_PER_MINUTE = 130;

// a tiny module using a v128 instruction: onnxruntime-web 1.31 ships SIMD builds only
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

function isMobileDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (uaData?.mobile) return true;
  const ua = navigator.userAgent || '';
  if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua)) return true;
  // iPadOS reports itself as a Mac
  return /Macintosh/.test(ua) && (navigator.maxTouchPoints ?? 0) > 1;
}

/** Whether in-browser separation can run here, and whether it is a good idea on this device. */
export function separationSupport(): SeparationSupport {
  const est = EST_SECONDS_PER_MINUTE;
  if (typeof WebAssembly !== 'object' || typeof Worker === 'undefined') {
    return { ok: false, recommended: false, reason: 'This browser has no WebAssembly or Web Worker support.', estSecondsPerMinute: est };
  }
  let simd = false;
  try {
    simd = WebAssembly.validate(SIMD_PROBE);
  } catch {
    simd = false;
  }
  if (!simd) {
    return { ok: false, recommended: false, reason: 'This browser does not support WebAssembly SIMD, which the separation model needs.', estSecondsPerMinute: est };
  }
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (isMobileDevice()) {
    return {
      ok: true,
      recommended: false,
      reason: 'Needs about 2.5 GB of memory and several minutes per song.',
      estSecondsPerMinute: est * 2,
    };
  }
  if (typeof mem === 'number' && mem < 4) {
    return {
      ok: true,
      recommended: false,
      reason: `This device reports ${mem} GB of memory; separating vocals & drums needs about 2.5 GB.`,
      estSecondsPerMinute: est,
    };
  }
  return { ok: true, recommended: true, estSecondsPerMinute: est };
}

/** Per-100 ms vocal-stem vs mixture energy gate (both mono, same rate and timebase). */
export function measureVocalPresence(vocals: Float32Array, mix: Float32Array, sampleRate: number): VocalPresence {
  return vocalPresence(vocals, mix, sampleRate);
}

const abortError = () => new DOMException('Separation cancelled', 'AbortError');

export interface RawSeparation {
  vocals: Float32Array;
  accomp: Float32Array;
  mix: Float32Array;
  vocals44?: Float32Array;
  accomp44?: Float32Array;
  stats: WorkerStats;
}

/**
 * Run SCNet on 44.1 kHz stereo in a fresh worker. Progress fraction is real work: model download
 * bytes (0–5%), then one step per 11 s segment (8–98%). The worker is always terminated afterwards.
 * Lower-level than separateStems(); exported for tests.
 */
export function separateStereo44k(
  left: Float32Array,
  right: Float32Array,
  onProgress: (fraction: number, detail?: string) => void,
  signal?: AbortSignal,
  opts: { step?: number; keep44?: boolean; modelUrl?: string } = {},
): Promise<RawSeparation> {
  if (signal?.aborted) return Promise.reject(abortError());
  const modelUrl = new URL(opts.modelUrl ?? `${import.meta.env.BASE_URL}${SCNET_MODEL_PATH}?v=${SCNET_MODEL_SHA256.slice(0, 8)}`, location.href).href;
  const segments = planSegments(left.length, opts.step ?? DEFAULT_STEP).starts.length;
  return new Promise<RawSeparation>((resolve, reject) => {
    const worker = new Worker(new URL('./scnet.worker.ts', import.meta.url), { type: 'module', name: 'scnet-separation' });
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
        if (m.phase === 'download') {
          const f = m.total > 0 ? Math.min(1, m.done / m.total) : 0;
          onProgress(0.05 * f, `Downloading the separation model (${(m.done / 1e6).toFixed(1)} of ${((m.total || SCNET_MODEL_BYTES) / 1e6).toFixed(1)} MB)`);
        } else if (m.phase === 'init') {
          onProgress(0.06, 'Starting the separation model');
        } else {
          onProgress(0.08 + 0.9 * (m.done / m.total), `Separating vocals & drums: part ${Math.min(m.total, m.done + 1)} of ${m.total}`);
        }
      } else if (m.type === 'error') {
        finish();
        reject(new Error(m.message));
      } else {
        finish();
        onProgress(0.99, 'Separation finished');
        resolve({ vocals: m.vocals, accomp: m.accomp, mix: m.mix, vocals44: m.vocals44, accomp44: m.accomp44, stats: m.stats });
      }
    };
    worker.onerror = (e) => {
      if (settled) return;
      finish();
      reject(new Error(`The separation worker failed${e.message ? `: ${e.message}` : ''}.`));
    };
    onProgress(0, `Loading the separation model (${segments} parts to separate)`);
    worker.postMessage(
      { type: 'separate', left, right, modelUrl, modelSha256: SCNET_MODEL_SHA256, step: opts.step, keep44: opts.keep44 },
      [left.buffer, right.buffer],
    );
  });
}

/**
 * Separate a song into vocals and drum-less accompaniment in the browser. Decodes the blob at
 * 44.1 kHz stereo itself; cancellable (the worker is terminated on abort).
 */
export async function separateStems(
  blob: Blob,
  onProgress: (fraction: number, detail?: string) => void,
  signal?: AbortSignal,
): Promise<SeparationResult> {
  const t0 = performance.now();
  onProgress(0, 'Decoding audio for separation');
  let buffer: AudioBuffer | null = await decodeToRate(blob, SCNET_RATE);
  if (signal?.aborted) throw abortError();
  // copies: the worker takes ownership of these
  const left = buffer.getChannelData(0).slice();
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice() : left.slice();
  buffer = null;
  const raw = await separateStereo44k(left, right, onProgress, signal);
  const vocalPresence = measureVocalPresence(raw.vocals, raw.mix, SEPARATION_RATE);
  onProgress(1, 'Separation finished');
  return {
    sampleRate: SEPARATION_RATE,
    vocals: raw.vocals,
    accomp: raw.accomp,
    vocalPresence,
    engine: 'scnet-browser',
    ms: performance.now() - t0,
  };
}

function fitLength(x: Float32Array, n: number): Float32Array {
  if (x.length === n) return x;
  const out = new Float32Array(n);
  out.set(x.subarray(0, Math.min(n, x.length)));
  return out;
}

/**
 * Stems separated by the processing server (SCNet there too). Decoded at 22.05 kHz and fitted to
 * the mixture's length. The presence gate compares against vocals + accompaniment (the server
 * does not return the drums), which is within ~1 dB of the full mix for this purpose.
 */
export async function stemsFromBlobs(vocals: Blob, accomp: Blob, mixDuration: number): Promise<SeparationResult> {
  const t0 = performance.now();
  const n = Math.max(1, Math.round(mixDuration * SEPARATION_RATE));
  const [vb, ab] = await Promise.all([decodeToRate(vocals, SEPARATION_RATE), decodeToRate(accomp, SEPARATION_RATE)]);
  const v = fitLength(mixToMono(vb), n);
  const a = fitLength(mixToMono(ab), n);
  const mix = new Float32Array(n);
  for (let i = 0; i < n; i++) mix[i] = v[i] + a[i];
  return {
    sampleRate: SEPARATION_RATE,
    vocals: v,
    accomp: a,
    vocalPresence: measureVocalPresence(v, mix, SEPARATION_RATE),
    engine: 'scnet-server',
    ms: performance.now() - t0,
  };
}

/** number of 11 s model segments for `seconds` of audio (for time estimates in the UI) */
export function separationSegments(seconds: number): number {
  return planSegments(Math.round(seconds * SCNET_RATE)).starts.length;
}
