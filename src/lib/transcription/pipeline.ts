/**
 * Main-thread orchestration of the audio → notes pipeline:
 *   validate → decode/resample (22.05 kHz mono)
 *   → [optional source separation (SCNet, in the browser or stems from the processing server)]
 *   → neural pitch/onset estimation in a worker → note extraction → cleanup → hands
 *   → tempo/beat tracking → key detection.
 *
 * With separation the accompaniment stem (bass + other: no drums, no vocals) is transcribed with
 * the user's detection parameters — this alone removes the false low notes drum hits produce —
 * and, when the vocal stem actually contains singing, the vocal stem is transcribed with
 * VOCAL_EXTRACTION and reduced to a single melody line (music/melody.ts) that goes on the right
 * hand (role 'melody').
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
import { extractMelodyLine, mergeMelody } from '../music/melody';
import type { StoredPosteriors } from './posteriors';
import { separateStems, stemsFromBlobs, type SeparationResult } from '../separation';

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

/**
 * Detection parameters for the separated VOCAL stem (not a user preset). A sung line is
 * continuous pitch with soft, legato attacks, so the melodia trick and inferred onsets are on;
 * same-pitch re-detections inside held notes are folded (continuationOnset) and harmonics
 * suppressed. The range covers bass to soprano; extractMelodyLine() narrows it further.
 * Tuned on SCNet vocal stems of 5 songs against pitch-tracked vocal references (melody line raw
 * pitch accuracy 0.50 → 0.54 vs frameThreshold 0.3 / minNoteMs 80; lower frame thresholds add
 * more false voicing than they recover).
 */
export const VOCAL_EXTRACTION: ExtractionParams = {
  onsetThreshold: 0.4,
  frameThreshold: 0.25,
  minNoteMs: 50,
  minMidi: 36,
  maxMidi: 88,
  melodiaTrick: true,
  suppressHarmonics: true,
  inferOnsets: true,
  continuationOnset: 0.5,
};

/** Fewer melody notes than this over a whole song: treat the vocal stem as noise, not a melody. */
const MIN_MELODY_NOTES = 8;

/** Systematic delay between a piano hammer strike and the model's onset frame (measured). */
const ONSET_LATENCY = 0.007;

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
  /** Posteriors of the audio the main notes came from (the accompaniment stem when separated). */
  posteriors: StoredPosteriors;
  /** Posteriors of the vocal stem (only when a melody line was extracted from it). */
  melodyPosteriors?: StoredPosteriors;
  info: TranscriptionInfo;
}

export interface TranscribeOptions {
  /** Separate vocals and drums in the browser (SCNet) before transcribing. */
  separate?: boolean;
  /** Stems that were already separated (processing server); used instead of `separate`. */
  stems?: { vocals: Blob; accomp: Blob };
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

type WithoutJob<T> = T extends unknown ? Omit<T, 'jobId'> : never;

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
        // a crashed worker (e.g. out of memory) is not reused: the next job starts a fresh one
        this.worker?.terminate();
        this.worker = null;
      };
    }
    return this.worker;
  }

  run<T extends WorkerResponse['type']>(
    req: WithoutJob<Extract<WorkerRequest, { type: 'transcribe' | 'extract' }>>,
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
  return assignHands(cleanNotes(raw, rms, params, duration), duration);
}

/** Raw model note events → cleaned notes (velocity, fragment/continuation merge, harmonics), no hands. */
export function cleanNotes(raw: RawNoteEvent[], rms: Float32Array, params: ExtractionParams, duration: number): Note[] {
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
  return sortNotes(notes);
}

/** Vocal-stem note events → the right-hand melody line. */
export function melodyFromRaw(raw: RawNoteEvent[], rms: Float32Array, duration: number): Note[] {
  const line = extractMelodyLine(cleanNotes(raw, rms, VOCAL_EXTRACTION, duration));
  return line.length >= MIN_MELODY_NOTES ? line : [];
}

const aborted = () => new DOMException('Transcription cancelled', 'AbortError');

/** Peak-normalise in place so detection thresholds behave the same for quiet and loud input. */
function normalise(audio: Float32Array): void {
  const level = analyzeLevel(audio);
  if (level.peak <= 1e-6) return;
  const gain = Math.min(8, 0.9 / level.peak);
  if (gain > 1.05) for (let i = 0; i < audio.length; i++) audio[i] *= gain;
}

type ModelRun = Extract<WorkerResponse, { type: 'transcribed' }>;

async function runModel(
  audio: Float32Array,
  params: ExtractionParams,
  onProgress: (e: ProgressEvent) => void,
  signal: AbortSignal | undefined,
  what: string,
): Promise<ModelRun> {
  let backend = '';
  return transcriber.run(
    { type: 'transcribe', audio, modelUrl: modelUrl(), options: toWorkerOptions(params) },
    [audio.buffer],
    (e) => {
      if (e.backend) backend = e.backend;
      onProgress({
        stage: e.stage,
        progress: e.progress,
        detail: e.stage === 'analyzing' ? `${what}${backend ? ` (${backend.toUpperCase()})` : ''}` : undefined,
      });
    },
    signal,
    'transcribed',
  );
}

const toStored = (r: ModelRun): StoredPosteriors => ({ nFrames: r.nFrames, frames: r.frames, onsets: r.onsets, rms: r.rms });

export async function transcribeAudio(
  blob: Blob,
  params: ExtractionParams,
  onProgress: (e: ProgressEvent) => void,
  signal?: AbortSignal,
  opts: TranscribeOptions = {},
): Promise<TranscriptionResult> {
  const t0 = performance.now();
  onProgress({ stage: 'decoding', progress: null, detail: 'Decoding and resampling audio' });
  const buffer = await decodeToRate(blob, BP_SAMPLE_RATE);
  if (signal?.aborted) throw aborted();
  let audio = mixToMono(buffer);
  const duration = buffer.duration;
  const warnings: string[] = [];
  const level = analyzeLevel(audio);
  if (level.peak < 0.01) throw new Error('The audio is (nearly) silent — nothing to transcribe.');
  if (level.rms < 0.01) warnings.push('The recording is very quiet; quiet notes may be missed.');

  // ---- optional source separation
  let sep: SeparationResult | null = null;
  if (opts.stems || opts.separate) {
    try {
      if (opts.stems) {
        onProgress({ stage: 'separating', progress: null, detail: 'Reading the separated stems' });
        sep = await stemsFromBlobs(opts.stems.vocals, opts.stems.accomp, duration);
      } else {
        onProgress({ stage: 'separating', progress: 0, detail: 'Separating vocals and drums' });
        sep = await separateStems(
          blob,
          (fraction, detail) => onProgress({ stage: 'separating', progress: fraction, detail: detail ?? 'Separating vocals and drums' }),
          signal,
        );
      }
    } catch (err) {
      if (signal?.aborted || (err as Error)?.name === 'AbortError') throw aborted();
      warnings.push(`Separating vocals and drums failed (${(err as Error)?.message ?? err}); the full mix was transcribed instead.`);
      sep = null;
    }
    if (signal?.aborted) throw aborted();
  }
  const withVocals = !!sep && sep.vocalPresence.present;
  if (sep) {
    audio = sep.accomp;
    if (sep.sampleRate !== BP_SAMPLE_RATE) throw new Error(`Separated stems have an unexpected sample rate (${sep.sampleRate} Hz).`);
  }
  normalise(audio);

  // ---- accompaniment (or the full mix)
  const what = sep ? (withVocals ? 'Neural pitch detection — accompaniment (1 of 2)' : 'Neural pitch detection — accompaniment') : 'Neural pitch detection';
  const result = await runModel(audio, params, onProgress, signal, what);

  // ---- vocal melody
  let vocal: ModelRun | null = null;
  if (sep && withVocals) {
    const v = sep.vocals;
    normalise(v);
    vocal = await runModel(v, VOCAL_EXTRACTION, onProgress, signal, 'Neural pitch detection — vocal melody (2 of 2)');
  }

  onProgress({ stage: 'arranging', progress: null, detail: vocal ? 'Extracting the vocal melody, assigning hands, tracking beats' : 'Cleaning notes, assigning hands, tracking beats' });
  const accompNotes = cleanNotes(result.notes, result.rms, params, duration);
  const melody = vocal ? melodyFromRaw(vocal.notes, vocal.rms, duration) : [];
  const notes = mergeMelody(accompNotes, melody, duration);
  if (result.backend === 'cpu') {
    warnings.push('Ran on the CPU fallback backend (no WebGL/WASM available); transcription was slower than usual.');
  }
  if (vocal && !melody.length) warnings.push('Singing was detected but no clear melody line could be extracted from it.');
  if (notes.length === 0) warnings.push('No notes were detected. Try the "Sensitive" detection preset.');
  // beats from the accompaniment: vocal onsets are rhythmically loose
  const tempo = estimateTempo(accompNotes.length ? accompNotes : notes, duration);
  if (tempo.confidence < 0.15) warnings.push('Tempo could not be detected reliably; the beat grid and quantisation may be off.');
  const meanConf = result.notes.length ? result.notes.reduce((s, n) => s + n.amplitude, 0) / result.notes.length : 0;
  return {
    notes,
    duration,
    tempo,
    key: detectKey(notes),
    posteriors: toStored(result),
    melodyPosteriors: vocal && melody.length ? toStored(vocal) : undefined,
    info: {
      method: 'basic-pitch',
      estimated: true,
      params,
      backend: result.backend,
      processingMs: Math.round(performance.now() - t0),
      ...(sep ? { separated: true, separation: { engine: sep.engine, vocals: melody.length > 0, ms: Math.round(sep.ms) } } : {}),
      warnings,
      confidence: Math.round(meanConf * 100) / 100,
    },
  };
}

async function extractRaw(post: StoredPosteriors, params: ExtractionParams): Promise<RawNoteEvent[]> {
  const frames = post.frames.slice();
  const onsets = post.onsets.slice();
  const res = await transcriber.run(
    { type: 'extract', frames, onsets, nFrames: post.nFrames, options: toWorkerOptions(params) },
    [frames.buffer, onsets.buffer],
    () => {},
    undefined,
    'extracted',
  );
  return res.notes;
}

export interface ReextractOptions {
  /** Vocal-stem posteriors: the melody line is re-extracted from them (VOCAL_EXTRACTION). */
  melodyPosteriors?: StoredPosteriors;
  /** The song's current melody notes (role 'melody'), kept as they are when no melodyPosteriors are given. */
  melody?: Note[];
}

/**
 * Re-run note extraction on stored posteriors with new parameters (no model inference).
 * For a separated song `post` holds the accompaniment; the melody line is kept (re-extracted
 * from `melodyPosteriors`, or taken from `melody`) and merged back on the right hand.
 */
export async function reextractNotes(
  post: StoredPosteriors,
  params: ExtractionParams,
  duration: number,
  opts: ReextractOptions = {},
): Promise<Note[]> {
  const raw = await extractRaw(post, params);
  const accomp = cleanNotes(raw, post.rms, params, duration);
  let melody: Note[] = [];
  if (opts.melodyPosteriors) {
    melody = melodyFromRaw(await extractRaw(opts.melodyPosteriors, VOCAL_EXTRACTION), opts.melodyPosteriors.rms, duration);
  } else if (opts.melody?.length) {
    melody = opts.melody.filter((n) => n.role === 'melody').map((n) => ({ ...n, hand: 'R' as const }));
  }
  return mergeMelody(accomp, melody, duration);
}
