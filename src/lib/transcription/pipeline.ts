/**
 * Main-thread orchestration of the audio → notes pipeline:
 *   validate → decode/resample (22.05 kHz mono) → [optional server-side source separation]
 *   → neural pitch/onset estimation in a worker → note extraction → cleanup → hands
 *   → tempo/beat tracking → key detection.
 */
import type { ExtractionParams, KeyInfo, Note, TempoInfo, TranscriptionInfo } from '../music/types';
import { BP_FPS, BP_SAMPLE_RATE, frameToTime } from './constants';
import type { NoteExtractionOptions, RawNoteEvent } from './noteExtraction';
import type { TranscriptionStage, WorkerRequest, WorkerResponse } from './workerProtocol';
import { analyzeLevel, decodeToRate, mixToMono } from './decode';
import { mergeContinuations, mergeFragments, newNoteId, removeShortQuiet, sortNotes, suppressHarmonics } from '../music/cleanup';
import { assignHands } from '../music/hands';
import { estimateTempo } from '../music/beats';
import { detectKey } from '../music/theory';
import type { StoredPosteriors } from './posteriors';

/**
 * Detection presets. "piano" was tuned on rendered piano recordings with known ground truth
 * (tests/e2e): the melodia trick (designed for voice-like continuous pitch) and a low frame
 * threshold mostly add re-detections of ringing piano strings, so they are off/raised here.
 * Note-onset F1 (50 ms): Bach BWV 846 0.77 → 0.92, chord/melody study 0.78 → 0.86 vs stock defaults.
 */
export const EXTRACTION_PRESETS: Record<'piano' | 'mix' | 'sensitive', ExtractionParams> = {
  piano: {
    onsetThreshold: 0.5,
    frameThreshold: 0.4,
    minNoteMs: 70,
    minMidi: 21,
    maxMidi: 108,
    melodiaTrick: false,
    suppressHarmonics: true,
    inferOnsets: false,
    continuationOnset: 0.7,
  },
  mix: {
    onsetThreshold: 0.5,
    frameThreshold: 0.35,
    minNoteMs: 100,
    minMidi: 28,
    maxMidi: 100,
    melodiaTrick: true,
    suppressHarmonics: true,
    inferOnsets: true,
    continuationOnset: 0.6,
  },
  sensitive: {
    onsetThreshold: 0.4,
    frameThreshold: 0.3,
    minNoteMs: 50,
    minMidi: 21,
    maxMidi: 108,
    melodiaTrick: false,
    suppressHarmonics: false,
    inferOnsets: true,
    continuationOnset: 0.5,
  },
};

/** Systematic delay between a piano hammer strike and the model's onset frame (measured). */
const ONSET_LATENCY = 0.019;

export interface ProgressEvent {
  stage: TranscriptionStage;
  /** 0..1 progress within the stage, or null when the stage has no measurable progress. */
  progress: number | null;
  detail?: string;
}

export interface TranscriptionResult {
  notes: Note[];
  duration: number;
  tempo: TempoInfo;
  key?: KeyInfo;
  posteriors: StoredPosteriors;
  info: TranscriptionInfo;
}

export function toWorkerOptions(p: ExtractionParams): NoteExtractionOptions {
  return {
    onsetThreshold: p.onsetThreshold,
    frameThreshold: p.frameThreshold,
    minNoteFrames: Math.max(1, Math.round((p.minNoteMs / 1000) * BP_FPS)),
    inferOnsets: p.inferOnsets ?? true,
    melodiaTrick: p.melodiaTrick,
    energyTolerance: 11,
    minMidi: p.minMidi,
    maxMidi: p.maxMidi,
  };
}

class TranscriberClient {
  private worker: Worker | null = null;
  private jobSeq = 1;
  private handlers = new Map<number, (msg: WorkerResponse) => void>();

  private getWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./inference.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.handlers.get(ev.data.jobId)?.(ev.data);
      this.worker.onerror = (ev) => {
        const err: WorkerResponse = { type: 'error', jobId: -1, message: ev.message || 'Transcription worker crashed' };
        for (const [id, h] of this.handlers) h({ ...err, jobId: id });
      };
    }
    return this.worker;
  }

  run<T extends WorkerResponse['type']>(
    req: Omit<Extract<WorkerRequest, { type: 'transcribe' | 'extract' }>, 'jobId'>,
    transfer: Transferable[],
    onProgress: (e: ProgressEvent & { backend?: string }) => void,
    signal?: AbortSignal,
    expect?: T,
  ): Promise<Extract<WorkerResponse, { type: T }>> {
    const worker = this.getWorker();
    const jobId = this.jobSeq++;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        worker.postMessage({ type: 'cancel', jobId } satisfies WorkerRequest);
        this.handlers.delete(jobId);
        reject(new DOMException('Transcription cancelled', 'AbortError'));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.handlers.set(jobId, (msg) => {
        if (msg.type === 'progress') {
          onProgress({ stage: msg.stage, progress: msg.progress, backend: msg.backend });
          return;
        }
        this.handlers.delete(jobId);
        signal?.removeEventListener('abort', onAbort);
        if (msg.type === 'error') reject(new Error(msg.message));
        else if (!expect || msg.type === expect) resolve(msg as Extract<WorkerResponse, { type: T }>);
      });
      worker.postMessage({ ...req, jobId } as WorkerRequest, transfer);
    });
  }
}

export const transcriber = new TranscriberClient();

function modelUrl(): string {
  return new URL(`${import.meta.env.BASE_URL}models/basic-pitch/model.json`, location.href).href;
}

/** Turn raw model note events into cleaned, hand-assigned notes. */
export function postProcess(raw: RawNoteEvent[], rms: Float32Array, params: ExtractionParams, duration: number): Note[] {
  // loudness reference: 95th percentile of the RMS envelope
  const sortedRms = Array.from(rms).filter((v) => v > 1e-5).sort((a, b) => a - b);
  const ref = sortedRms[Math.floor(sortedRms.length * 0.95)] || 1;
  const amplitude = new Map<number, number>();
  const onsetStrength = new Map<number, number>();
  let notes: Note[] = raw.map((r) => {
    const start = Math.max(0, frameToTime(r.startFrame) - ONSET_LATENCY);
    const end = Math.max(start + 0.03, frameToTime(r.endFrame) - ONSET_LATENCY);
    const ri = Math.min(rms.length - 1, Math.round(start * 100) + 3);
    let loud = 0;
    for (let i = Math.max(0, ri - 3); i <= Math.min(rms.length - 1, ri + 3); i++) loud = Math.max(loud, rms[i]);
    const loudNorm = Math.min(1, loud / ref);
    const ampNorm = Math.max(0, Math.min(1, (r.amplitude - 0.2) / 0.6));
    const vel = Math.max(0.15, Math.min(1, 0.22 + 0.38 * ampNorm + 0.4 * Math.sqrt(loudNorm)));
    const id = newNoteId();
    amplitude.set(id, r.amplitude);
    onsetStrength.set(id, r.onset);
    return { id, midi: r.midi, start, dur: Math.max(0.03, end - start), vel, hand: 'R' as const };
  });
  notes = mergeFragments(notes, 0.03, onsetStrength);
  if (params.continuationOnset) notes = mergeContinuations(notes, onsetStrength, params.continuationOnset);
  if (params.suppressHarmonics) notes = suppressHarmonics(notes, amplitude);
  notes = removeShortQuiet(notes, Math.min(0.045, params.minNoteMs / 1000), 0.1);
  notes = notes.filter((n) => n.start < duration);
  return assignHands(sortNotes(notes), duration);
}

export async function transcribeAudio(
  blob: Blob,
  params: ExtractionParams,
  onProgress: (e: ProgressEvent) => void,
  signal?: AbortSignal,
): Promise<TranscriptionResult> {
  const t0 = performance.now();
  onProgress({ stage: 'decoding', progress: null, detail: 'Decoding and resampling audio' });
  const buffer = await decodeToRate(blob, BP_SAMPLE_RATE);
  if (signal?.aborted) throw new DOMException('Transcription cancelled', 'AbortError');
  const audio = mixToMono(buffer);
  const duration = buffer.duration;
  const warnings: string[] = [];
  const level = analyzeLevel(audio);
  if (level.peak < 0.01) throw new Error('The audio is (nearly) silent — nothing to transcribe.');
  if (level.rms < 0.01) warnings.push('The recording is very quiet; quiet notes may be missed.');
  // normalise level so thresholds behave consistently between quiet and loud recordings
  const gain = Math.min(8, 0.9 / level.peak);
  if (gain > 1.05) for (let i = 0; i < audio.length; i++) audio[i] *= gain;

  let backend = '';
  const result = await transcriber.run(
    { type: 'transcribe', audio, modelUrl: modelUrl(), options: toWorkerOptions(params) },
    [audio.buffer],
    (e) => {
      if (e.backend) backend = e.backend;
      onProgress({
        stage: e.stage,
        progress: e.progress,
        detail: e.stage === 'analyzing' ? `Neural pitch detection${backend ? ` (${backend.toUpperCase()})` : ''}` : undefined,
      });
    },
    signal,
    'transcribed',
  );
  onProgress({ stage: 'arranging', progress: null, detail: 'Cleaning notes, assigning hands, tracking beats' });
  const notes = postProcess(result.notes, result.rms, params, duration);
  if (backend === 'cpu' || result.backend === 'cpu') {
    warnings.push('Ran on the CPU fallback backend (no WebGL/WASM available); transcription was slower than usual.');
  }
  if (notes.length === 0) warnings.push('No notes were detected. Try the "Sensitive" detection preset.');
  const tempo = estimateTempo(notes, duration);
  if (tempo.confidence < 0.15) warnings.push('Tempo could not be detected reliably; the beat grid and quantisation may be off.');
  const meanConf = result.notes.length ? result.notes.reduce((s, n) => s + n.amplitude, 0) / result.notes.length : 0;
  return {
    notes,
    duration,
    tempo,
    key: detectKey(notes),
    posteriors: { nFrames: result.nFrames, frames: result.frames, onsets: result.onsets, rms: result.rms },
    info: {
      method: 'basic-pitch',
      estimated: true,
      params,
      backend: result.backend,
      processingMs: Math.round(performance.now() - t0),
      warnings,
      confidence: Math.round(meanConf * 100) / 100,
    },
  };
}

/** Re-run note extraction on stored posteriors with new parameters (no model inference). */
export async function reextractNotes(
  post: StoredPosteriors,
  params: ExtractionParams,
  duration: number,
): Promise<Note[]> {
  const frames = post.frames.slice();
  const onsets = post.onsets.slice();
  const res = await transcriber.run(
    { type: 'extract', frames, onsets, nFrames: post.nFrames, options: toWorkerOptions(params) },
    [frames.buffer, onsets.buffer],
    () => {},
    undefined,
    'extracted',
  );
  return postProcess(res.notes, post.rms, params, duration);
}
