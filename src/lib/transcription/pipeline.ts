/**
 * Main-thread orchestration of the audio → notes pipeline:
 *   validate → decode/resample (22.05 kHz mono)
 *   → [optional source separation (SCNet, in the browser or stems from the processing server)]
 *   → neural pitch/onset estimation in a worker → note extraction → cleanup → hands
 *   → tempo/beat tracking → key detection.
 *
 * With separation the accompaniment stem (bass + other: no drums, no vocals) is transcribed with
 * the user's detection parameters. The drums stem is reduced to an onset envelope
 * (separation/dsp.ts) that is stored with the posteriors for a drum-hit false-note filter
 * (music/cleanup.ts suppressDrumHits; measured, currently off: see DrumHitRule).
 * When the vocal stem actually contains singing, the vocal stem is transcribed with
 * VOCAL_EXTRACTION and reduced to a single melody line (music/melody.ts) that goes on the right
 * hand (role 'melody').
 */
import type { ExtractionParams, KeyInfo, Note, TempoInfo, TranscriptionInfo } from '../music/types';
import { BP_FPS, BP_MIDI_OFFSET, BP_N_PITCHES, BP_SAMPLE_RATE, frameToTime, timeToFrame } from './constants';
import type { NoteExtractionOptions, RawNoteEvent } from './noteExtraction';
import type { TranscriptionStage, WorkerRequest, WorkerResponse } from './workerProtocol';
import { analyzeLevel, decodeToRate, mixToMono } from './decode';
import { DRUM_HIT_RULE, RESTRIKE, mergeContinuations, mergeFragments, newNoteId, removeShortQuiet, sortNotes, suppressDrumHits, suppressHarmonics } from '../music/cleanup';
import { assignHands } from '../music/hands';
import { estimateTempo } from '../music/beats';
import { detectKey } from '../music/theory';
import { extractMelodyLine, mergeMelody } from '../music/melody';
import type { StoredPosteriors } from './posteriors';
import { isMemoryConstrained, pageDeviceInfo } from './backendChoice';
import { DRUM_ENV_FPS, longReason, separateStems, separationSupport, stemsFromBlobs, type SeparationResult } from '../separation';

/**
 * Piano register curve: the top and bottom octaves get lower thresholds (Basic Pitch's posteriors
 * are weaker there), shorter minimum notes at the top. Recovers C6 recall .22 -> .41 and C7
 * .06 -> .24 on MAESTRO at unchanged precision.
 */
const PIANO_REGISTER: NonNullable<ExtractionParams['register']> = { lowMidi: 48, lowFrame: 0.5, lowOnset: 0.6, highMidi: 76, highFrame: 0.3, highMinFrames: 0.4 };

/**
 * Detection presets. "piano" and "sensitive" were tuned on 5 MAESTRO pieces with exact MIDI
 * (tests/accuracy/sweep_extraction.mjs), with Liszt held out and the synthetic e2e gate enforced
 * (tests/e2e); the register curve recovers the top and bottom octaves. The melodia trick
 * (designed for voice-like continuous pitch) and a low frame threshold mostly add re-detections of
 * ringing piano strings, so they are off/raised for "piano". Onset F1@50 (mean of 5 pieces):
 * piano 0.824 -> 0.836, sensitive 0.794 -> 0.824 vs the previous values.
 */
export const EXTRACTION_PRESETS: Record<'piano' | 'mix' | 'sensitive', ExtractionParams> = {
  piano: {
    onsetThreshold: 0.55,
    frameThreshold: 0.4,
    minNoteMs: 60,
    minMidi: 21,
    maxMidi: 108,
    melodiaTrick: false,
    suppressHarmonics: true,
    inferOnsets: false,
    continuationOnset: 0.7,
    register: PIANO_REGISTER,
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
    onsetThreshold: 0.55,
    frameThreshold: 0.25,
    minNoteMs: 50,
    minMidi: 21,
    maxMidi: 108,
    melodiaTrick: false,
    suppressHarmonics: true,
    inferOnsets: true,
    continuationOnset: 0.5,
    register: PIANO_REGISTER,
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
  // the chopped-note join costs the sung line a little (5 songs: line raw pitch accuracy
  // 0.561 → 0.559, vocal-5 0.462 → 0.454); it runs on the accompaniment only
  joinRepeats: false,
};

/** Fewer melody notes than this over a whole song: treat the vocal stem as noise, not a melody. */
const MIN_MELODY_NOTES = 8;

/**
 * Systematic delay between a piano hammer strike and the model's onset frame. Measured on MAESTRO:
 * Basic Pitch onset frames already align with the hammer strike to within 1 ms (median bias
 * +0.4 ms at 0; it was -6.5 ms at the earlier 0.007).
 */
const ONSET_LATENCY = 0;

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
  /**
   * Posteriors of the audio the main notes came from (the accompaniment stem when separated),
   * plus the drum onset envelope when separated in the browser.
   */
  posteriors: StoredPosteriors;
  info: TranscriptionInfo;
  /**
   * Set when separation was asked for but did not run: 'memory' (it ran out of memory, or the
   * worker died, which on a big song almost always means the same), 'error' (anything else),
   * 'too-long' (the recording is longer than this device should separate in the browser).
   */
  separationFailure?: 'memory' | 'error' | 'too-long';
}

export interface TranscribeOptions {
  /** Separate vocals and drums in the browser (SCNet) before transcribing. */
  separate?: boolean;
  /**
   * Stems that were already separated (processing server); used instead of `separate`.
   * `serverMs`: the server's separation time, when it reported one.
   */
  stems?: { vocals: Blob; accomp: Blob; serverMs?: number };
  /**
   * An in-page separation result of this same audio (tests, accuracy harness); used instead of
   * both. Not consumed: its arrays are copied, so the same result can be passed to several calls.
   */
  separation?: SeparationResult;
}

/**
 * Tempo of a transcription: beats from the cleaned accompaniment notes (before the melody is merged
 * in), because vocal onsets are rhythmically loose. Shared by import and re-detection so the two
 * cannot drift apart.
 */
function transcriptionTempo(accomp: Note[], merged: Note[], duration: number): TempoInfo {
  return estimateTempo(accomp.length ? accomp : merged, duration);
}

/** Errors that mean the browser ran out of memory (onnxruntime, Emscripten, V8), or a worker that died without a message. */
const MEMORY_ERROR = /bad_alloc|out of memory|\bOOM\b|allocation failed|could not allocate|ERROR_CODE: 6\b|RangeError|WebAssembly\.Memory|worker failed/i;

/** The warning for a separation that failed (memory errors get advice instead of the raw engine message). */
export function separationFailureWarning(err: unknown): { kind: 'memory' | 'error'; warning: string } {
  const e = err as Error | undefined;
  const raw = `${e?.name ?? ''} ${e?.message ?? String(err)}`.trim();
  if (MEMORY_ERROR.test(raw)) {
    const detail = (e?.message ?? String(err)).replace(/\s+/g, ' ').slice(0, 80);
    return {
      kind: 'memory',
      warning:
        'Separating vocals & drums ran out of memory on this device, so the full mix was transcribed and the right hand does not follow the singer. ' +
        `Close other tabs and try again, or use a processing server with separation (Settings → Processing server). (${detail})`,
    };
  }
  return { kind: 'error', warning: `Separating vocals and drums failed (${e?.message ?? err}); the full mix was transcribed instead.` };
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
    ...(p.register ? { register: p.register } : {}),
    ...(p.joinRepeats === false ? { joinRepeats: null } : {}),
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

  /**
   * Stop the worker when no job is running. Its WebAssembly memory (~110 MB once Basic Pitch has run)
   * can only grow, never shrink: on phones it would otherwise sit under the Studio's piano samples.
   * The next job starts a fresh worker (re-extraction needs no model; an import reloads it).
   */
  releaseIfIdle(): boolean {
    if (!this.worker || this.handlers.size) return false;
    this.worker.terminate();
    this.worker = null;
    return true;
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

/**
 * Model evidence beyond the note events that cleanNotes() can use. All optional: without it the
 * corresponding tests are skipped (older stored songs, unit tests).
 */
export interface CleanContext {
  /** frame posteriors the events were extracted from (nFrames x 88; 8-bit stored or float) */
  frames?: Uint8Array | Float32Array;
  nFrames?: number;
  /** onset strength of the separated drums stem (8-bit, DRUM_ENV_FPS): drops drum-hit false low notes */
  drums?: Uint8Array;
}

/** Strongest drum onset (8-bit) of an envelope at DRUM_ENV_FPS in [t0, t1] seconds. */
export function drumOnsetMax(drums: Uint8Array, t0: number, t1: number): number {
  const a = Math.max(0, Math.round(t0 * DRUM_ENV_FPS));
  const b = Math.min(drums.length - 1, Math.round(t1 * DRUM_ENV_FPS));
  let m = 0;
  for (let i = a; i <= b; i++) if (drums[i] > m) m = drums[i];
  return m;
}

/**
 * Rise of the frame activation of `midi` at `startFrame`: peak over the next 4 frames minus the
 * minimum over the 3 frames before (≈ 35-45 ms each side). Large for a re-struck note, ~0 for a
 * model re-detection inside a ringing note (see music/cleanup.ts RestrikeRule).
 */
export function frameRise(frames: Uint8Array | Float32Array, nFrames: number, startFrame: number, midi: number): number {
  const f = midi - BP_MIDI_OFFSET;
  if (f < 0 || f >= BP_N_PITCHES) return 0;
  const scale = frames instanceof Uint8Array ? 1 / 255 : 1;
  let dip = Infinity;
  for (let t = startFrame - 3; t <= startFrame; t++) dip = Math.min(dip, t >= 0 && t < nFrames ? frames[t * BP_N_PITCHES + f] : 0);
  let peak = 0;
  for (let t = startFrame; t <= Math.min(nFrames - 1, startFrame + 4); t++) peak = Math.max(peak, frames[t * BP_N_PITCHES + f]);
  return Math.max(0, peak - dip) * scale;
}

/**
 * Frame evidence of a cleaned note: mean activation of its pitch over the note, and the
 * strongest neighbouring-semitone (±1, ±2) activation over its first 3 frames relative to its own
 * there (a broadband drum thump lights a cluster of low pitches; a bass note lights one).
 */
export function noteActivation(frames: Uint8Array | Float32Array, nFrames: number, n: Note): { mean: number; spread: number } {
  const f = n.midi - BP_MIDI_OFFSET;
  if (f < 0 || f >= BP_N_PITCHES || nFrames < 1) return { mean: 0, spread: 0 };
  const P = BP_N_PITCHES;
  const s0 = Math.min(nFrames - 1, timeToFrame(n.start));
  const s1 = Math.min(nFrames - 1, Math.max(s0, timeToFrame(n.start + n.dur)));
  let sum = 0;
  for (let t = s0; t <= s1; t++) sum += frames[t * P + f];
  let own = 0;
  let nb = 0;
  const e = Math.min(nFrames - 1, s0 + 2);
  for (let t = s0; t <= e; t++) {
    own += frames[t * P + f];
    for (const d of [-2, -1, 1, 2]) if (f + d >= 0 && f + d < P) nb = Math.max(nb, frames[t * P + f + d]);
  }
  own /= e - s0 + 1;
  const scale = frames instanceof Uint8Array ? 1 / 255 : 1;
  return { mean: (sum / (s1 - s0 + 1)) * scale, spread: own > 0 ? nb / own : nb > 0 ? Infinity : 0 };
}

/** Turn raw model note events into cleaned, hand-assigned notes. */
export function postProcess(raw: RawNoteEvent[], rms: Float32Array, params: ExtractionParams, duration: number, ctx: CleanContext = {}): Note[] {
  return assignHands(cleanNotes(raw, rms, params, duration, ctx), duration);
}

/** Raw model note events → cleaned notes (velocity, fragment/continuation merge, harmonics), no hands. */
export function cleanNotes(raw: RawNoteEvent[], rms: Float32Array, params: ExtractionParams, duration: number, ctx: CleanContext = {}): Note[] {
  // loudness reference: 95th percentile of the RMS envelope
  const sortedRms = Array.from(rms).filter((v) => v > 1e-5).sort((a, b) => a - b);
  const ref = sortedRms[Math.floor(sortedRms.length * 0.95)] || 1;
  const amplitude = new Map<number, number>();
  const onsetStrength = new Map<number, number>();
  // re-strike test (music/cleanup.ts RestrikeRule): needs the frame posteriors, and only for presets with a strict continuation fold
  const rise = ctx.frames && ctx.nFrames && (params.continuationOnset ?? 0) >= RESTRIKE.minContinuation ? new Map<number, number>() : undefined;
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
    if (rise) rise.set(id, frameRise(ctx.frames!, ctx.nFrames!, r.startFrame, r.midi));
    return { id, midi: r.midi, start, dur: Math.max(0.03, end - start), vel, hand: 'R' as const };
  });
  notes = mergeFragments(notes, 0.03, onsetStrength, { rise });
  if (params.continuationOnset) notes = mergeContinuations(notes, onsetStrength, params.continuationOnset, 0.3, { rise });
  if (params.suppressHarmonics) notes = suppressHarmonics(notes, amplitude);
  const drums = ctx.drums;
  if (drums?.length && DRUM_HIT_RULE.enabled) {
    const w = DRUM_HIT_RULE.window;
    notes = suppressDrumHits(notes, (n) => ({
      hit: drumOnsetMax(drums, n.start - w, n.start + w),
      onset: onsetStrength.get(n.id) ?? 1,
      ...(ctx.frames && ctx.nFrames ? noteActivation(ctx.frames, ctx.nFrames, n) : {}),
    }));
  }
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
    { type: 'transcribe', audio, modelUrl: modelUrl(), options: toWorkerOptions(params), device: pageDeviceInfo() },
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

const toStored = (r: ModelRun, drums?: Uint8Array): StoredPosteriors => ({
  nFrames: r.nFrames,
  frames: r.frames,
  onsets: r.onsets,
  rms: r.rms,
  ...(drums ? { drums } : {}),
});

export async function transcribeAudio(
  blob: Blob,
  params: ExtractionParams,
  onProgress: (e: ProgressEvent) => void,
  signal?: AbortSignal,
  opts: TranscribeOptions = {},
): Promise<TranscriptionResult> {
  try {
    return await transcribeAudioOnce(blob, params, onProgress, signal, opts);
  } finally {
    // phones and small-memory devices: give the model's memory back once the import is done
    const device = pageDeviceInfo();
    if (device && isMemoryConstrained(device)) transcriber.releaseIfIdle();
  }
}

async function transcribeAudioOnce(
  blob: Blob,
  params: ExtractionParams,
  onProgress: (e: ProgressEvent) => void,
  signal: AbortSignal | undefined,
  opts: TranscribeOptions,
): Promise<TranscriptionResult> {
  const t0 = performance.now();
  onProgress({ stage: 'decoding', progress: null, detail: 'Decoding and resampling audio' });
  // (the decoded AudioBuffer is not kept: separation decodes again at 44.1 kHz and memory is tight)
  let { audio, duration } = await decodeMono(blob);
  if (signal?.aborted) throw aborted();
  const warnings: string[] = [];
  let separationFailure: TranscriptionResult['separationFailure'];
  const level = analyzeLevel(audio);
  if (level.peak < 0.01) throw new Error('The audio is (nearly) silent — nothing to transcribe.');
  if (level.rms < 0.01) warnings.push('The recording is very quiet; quiet notes may be missed.');

  // ---- optional source separation
  // a reused in-page result is copied: its arrays are normalised in place and transferred below
  let sep: SeparationResult | null = opts.separation ? { ...opts.separation, accomp: opts.separation.accomp.slice(), vocals: opts.separation.vocals.slice() } : null;
  const support = !sep && !opts.stems && opts.separate ? separationSupport(duration) : null;
  if (support && support.ok && duration > support.maxSeconds) {
    warnings.push(
      `${longReason(duration)} It was skipped, so the full mix was transcribed and the right hand does not follow the singer; a processing server with separation can handle long recordings.`,
    );
    separationFailure = 'too-long';
  } else if (!sep && (opts.stems || opts.separate)) {
    try {
      if (opts.stems) {
        onProgress({ stage: 'separating', progress: null, detail: 'Reading the separated stems' });
        sep = await stemsFromBlobs(opts.stems.vocals, opts.stems.accomp, duration, opts.stems.serverMs);
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
      const f = separationFailureWarning(err);
      warnings.push(f.warning);
      separationFailure = f.kind;
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
  const drums = sep?.drumOnsets;
  const accompNotes = cleanNotes(result.notes, result.rms, params, duration, { frames: result.frames, nFrames: result.nFrames, drums });
  const melody = vocal ? melodyFromRaw(vocal.notes, vocal.rms, duration) : [];
  const notes = mergeMelody(accompNotes, melody, duration);
  if (result.backend === 'cpu') {
    warnings.push('Ran on the CPU fallback backend (no WebGL/WASM available); transcription was slower than usual.');
  }
  if (vocal && !melody.length) warnings.push('Singing was detected but no clear melody line could be extracted from it.');
  if (notes.length === 0) warnings.push('No notes were detected. Try the "Sensitive" detection preset.');
  const tempo = transcriptionTempo(accompNotes, notes, duration);
  if (tempo.confidence < 0.15) warnings.push('Tempo could not be detected reliably; the beat grid and quantisation may be off.');
  const meanConf = result.notes.length ? result.notes.reduce((s, n) => s + n.amplitude, 0) / result.notes.length : 0;
  return {
    notes,
    duration,
    tempo,
    key: detectKey(notes),
    posteriors: toStored(result, drums?.length ? drums : undefined),
    info: {
      method: 'basic-pitch',
      estimated: true,
      params,
      backend: result.backend,
      processingMs: Math.round(performance.now() - t0),
      ...(sep ? { separated: true, separation: { engine: sep.engine, vocals: melody.length > 0, ms: Math.round(sep.ms), ...(sep.threads ? { threads: sep.threads } : {}) } } : {}),
      warnings,
      confidence: Math.round(meanConf * 100) / 100,
    },
    ...(separationFailure ? { separationFailure } : {}),
  };
}

/** Decode at the model rate and mix down; only the mono samples and the duration are kept. */
async function decodeMono(blob: Blob): Promise<{ audio: Float32Array; duration: number }> {
  const buffer = await decodeToRate(blob, BP_SAMPLE_RATE);
  return { audio: mixToMono(buffer), duration: buffer.duration };
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
  /** The song's current melody notes (role 'melody'), kept as they are and merged back on the right hand. */
  melody?: Note[];
}

/**
 * Re-run note extraction on stored posteriors with new parameters (no model inference).
 * For a separated song `post` holds the accompaniment (and the drum onset envelope); the melody
 * line is kept from `melody` and merged back on the right hand.
 */
export async function reextractNotes(
  post: StoredPosteriors,
  params: ExtractionParams,
  duration: number,
  opts: ReextractOptions = {},
): Promise<Note[]> {
  return (await reextract(post, params, duration, opts)).notes;
}

/** reextractNotes plus the tempo estimated exactly as an import does (from the accompaniment only). */
export async function redetectNotes(
  post: StoredPosteriors,
  params: ExtractionParams,
  duration: number,
  opts: ReextractOptions = {},
): Promise<{ notes: Note[]; tempo: TempoInfo }> {
  const { accomp, notes } = await reextract(post, params, duration, opts);
  return { notes, tempo: transcriptionTempo(accomp, notes, duration) };
}

async function reextract(post: StoredPosteriors, params: ExtractionParams, duration: number, opts: ReextractOptions): Promise<{ accomp: Note[]; notes: Note[] }> {
  const raw = await extractRaw(post, params);
  const accomp = cleanNotes(raw, post.rms, params, duration, { frames: post.frames, nFrames: post.nFrames, drums: post.drums });
  const melody = (opts.melody ?? []).filter((n) => n.role === 'melody').map((n) => ({ ...n, hand: 'R' as const }));
  return { accomp, notes: mergeMelody(accomp, melody, duration) };
}
