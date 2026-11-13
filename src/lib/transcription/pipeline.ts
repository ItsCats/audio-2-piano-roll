/**
 * Main-thread orchestration of the audio → notes pipeline:
 *   validate → decode/resample (22.05 kHz mono)
 *   → [optional source separation (SCNet, in the browser or stems from the processing server)]
 *   → neural pitch/onset estimation in a worker → note extraction → cleanup → hands
 *   → tempo/beat tracking → key detection.
 *
 * With separation the accompaniment stem (bass + other: no drums, no vocals) is transcribed with
 * the user's detection parameters; when the vocal stem holds no singing it is added back in
 * (addVocalsInto: the mix minus the drums). The drums stem is reduced to an onset envelope
 * (separation/dsp.ts) that is stored with the posteriors for a drum-hit false-note filter
 * (music/cleanup.ts suppressDrumHits; measured, currently off: see DrumHitRule).
 * When the vocal stem actually contains singing, the vocal stem is transcribed with
 * VOCAL_EXTRACTION and reduced to a single melody line (music/melody.ts) that goes on the right
 * hand (role 'melody').
 *
 * Engine 'piano-specialist' (solo piano, opt-in): decode at 16 kHz → the ByteDance piano
 * transcription model (lib/pianoSpecialist, in its own worker) → its regression post-processor
 * (pianoSpecialist/postprocess.ts) → hands → tempo/beats → key. No separation and none of the
 * Basic Pitch cleanup (see specialistNotes).
 */
import type { ExtractionParams, KeyInfo, Note, TempoInfo, TranscriptionInfo } from '../music/types';
import { BP_FPS, BP_MIDI_OFFSET, BP_N_PITCHES, BP_SAMPLE_RATE, frameToTime, timeToFrame } from './constants';
import type { NoteExtractionOptions, RawNoteEvent } from './noteExtraction';
import type { TranscriptionStage, WorkerRequest, WorkerResponse } from './workerProtocol';
import { analyzeLevel, decodeToRate, mixToMono } from './decode';
import { BASS_FOLD, DRUM_HIT_RULE, RESTRIKE, TAIL_GATE, mergeContinuations, mergeFragments, newNoteId, removeShortQuiet, removeTailGhosts, sortNotes, suppressDrumHits, suppressHarmonics, foldBassRestrikes } from '../music/cleanup';
import { assignHands } from '../music/hands';
import { estimateTempo } from '../music/beats';
import { detectKey } from '../music/theory';
import { extractMelodyLine, mergeMelody } from '../music/melody';
import { recoverLead } from '../music/leadRecovery';
import { sustainTuneLine } from '../music/sustain';
import type { StoredPosteriors } from './posteriors';
import { BASS_BAND_PITCHES, BASS_LINE, bassBand, decodeBassLine, mergeBassLine, type BassPosteriors } from './bassLine';
import { gapCue, pitchContinues, pitchHeldEnd, storedPitch, type StoredPitch } from './stemPitch';
import { isMemoryConstrained, pageDeviceInfo } from './backendChoice';
import { BROWSER_SEPARATION_MAX_SECONDS, DRUM_ENV_FPS, longReason, separateStems, separationSupport, stemsFromBlobs, type SeparationResult } from '../separation';
import { regressionToNotes, type RegressionOutputs } from '../pianoSpecialist/postprocess';
// (protocol.ts is pure: the specialist's runtime itself is only loaded when it is used)

/**
 * Which model turns the audio into notes: Spotify's Basic Pitch (default, any recording) or the
 * piano specialist (Kong et al. 2021; solo piano only, slower, downloads its model once).
 */
export type TranscriptionEngine = 'basic-pitch' | 'piano-specialist';

/** Sample rate the piano specialist's model takes. */
export const SPECIALIST_SAMPLE_RATE = 16000;

/**
 * Piano register curve: the top and bottom octaves get lower thresholds (Basic Pitch's posteriors
 * are weaker there), shorter minimum notes at the top. Recovers C6 recall .22 -> .41 and C7
 * .06 -> .24 on MAESTRO at unchanged precision.
 */
const PIANO_REGISTER: NonNullable<ExtractionParams['register']> = { lowMidi: 48, lowFrame: 0.5, lowOnset: 0.6, highMidi: 76, highFrame: 0.3, highMinFrames: 0.4 };

/**
 * The "Full song" preset's lead-line recovery pass (music/leadRecovery.ts): Sensitive-like
 * thresholds in the lead's register, on the same posteriors; its notes are only candidates, kept
 * where the instruments' tune line goes through them. The melodia trick stays on (a held lead note
 * whose onset is soft never starts an event without it: Sensitive's largest loss on the solo).
 *
 * Measured on band-instrumental-1 against an estimated lead reference (a vote of Melodia, pYIN,
 * CREPE and a multi-instrument transcriber; no human transcription exists), Hard, lead-note onset
 * recall at the exact pitch (±80 ms), offline on the stored posteriors, without → with the pass:
 *   full mix        solo 20 → 71 %, ending 49 → 71 %, whole song 42 → 63 %; 1556 → 1801 notes
 *   separated       solo 39 → 80 %, ending 60 → 69 %, whole song 47 → 63 %; 1676 → 1887 notes
 *   ("Sensitive" for comparison: solo 64 / 82 %, whole song 57 / 64 %, 2122 / 2172 notes)
 * Notes matching no lead note +0.5 / s (Sensitive +1.9 / s). Swept (frame 0.2-0.35, 40-70 ms,
 * register curve on/off, melodia on/off, lowest pitch 55-72, activation floor 0-0.35, density cap
 * 1-100 / s): frame 0.2 recovers less (longer events merge into the main notes), the density cap
 * binds below ~2.5 / s on the solo. The recovered notes are Hard-only (role 'lead'; see
 * accompFromRaw).
 *
 * Caveat: these settings were chosen on the same song and the same estimated reference they are
 * scored against (no second instrumental with a lead reference was available). Against references
 * that share nothing with the tuning (pYIN on a Demucs 'other' stem alone; the top line of a
 * multi-instrument transcriber) the whole-song gain is about half as large (+10..+14 points); the
 * solo gain holds (pYIN 38 -> 74 %); the 0:30-0:38 gain is not confirmed.
 *
 * The pass is read at run time (leadPassParams), not stored with a song, so re-detection always
 * uses the current settings.
 */
export const LEAD_PASS: Omit<ExtractionParams, 'leadPass'> = {
  onsetThreshold: 0.5,
  frameThreshold: 0.3,
  minNoteMs: 50,
  minMidi: 60,
  maxMidi: 100,
  melodiaTrick: true,
  suppressHarmonics: false,
  inferOnsets: true,
  continuationOnset: 0.5,
  register: { lowMidi: 21, highMidi: 76, highFrame: 0.3, highMinFrames: 0.4 },
};

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
    leadPass: true,
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
  // the ghost-note gate (music/cleanup.ts TAIL_GATE) also removed quiet bleed notes from the vocal
  // stem while nobody sings (vocal-1: 8 of 327 line notes, the line's voicing-counted accuracy
  // 0.686 → 0.709), but those stretches then became instrumental gaps that Easy fills with the
  // instruments' tune (Easy voicing-counted accuracy vs the singer 0.518 → 0.474): off here
  tailGate: false,
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
   * plus the drum onset envelope when separated in the browser. Absent for the piano specialist
   * (its outputs are not Basic Pitch posteriors, so they cannot be re-detected from).
   */
  posteriors?: StoredPosteriors;
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
  /**
   * Transcription model (default 'basic-pitch'). 'piano-specialist' ignores the separation
   * options (it is for solo piano) and returns no posteriors.
   */
  engine?: TranscriptionEngine;
}

/**
 * Tempo of a transcription: beats from the cleaned accompaniment notes (before the melody is merged
 * in and before lead-line recovery), because vocal onsets are rhythmically loose and the recovered
 * lead notes would move the beat grid Easy and Medium are quantised to. Shared by import and re-detection so the two
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
  /** onset posteriors of the same model run (same layout as `frames`): lead recovery's attack test */
  onsets?: Uint8Array | Float32Array;
  nFrames?: number;
  /** onset strength of the separated drums stem (8-bit, DRUM_ENV_FPS): drops drum-hit false low notes */
  drums?: Uint8Array;
  /**
   * Posteriors of the separated bass stem's own pass (browser separation, bass stem not silent):
   * the low notes it explains are replaced by one bass line (transcription/bassLine.ts).
   */
  bass?: BassPosteriors;
  /** pitch track of the lead-bearing stem (separated songs): the tune cue (transcription/stemPitch.ts) */
  leadPitch?: StoredPitch;
  /** the song was separated (any engine): with no sung line, LEAD_EVERY_LEVEL applies */
  separated?: boolean;
}

/**
 * Separated (CleanContext.separated) with no sung line: the recovered lead notes are the
 * instruments' tune for every level, not Hard-only (see accompFromRaw).
 */
export const LEAD_EVERY_LEVEL = { instrumental: true };

/**
 * Run the pitch tracker on the other stem (browser separation of an instrumental, "Full song"
 * preset): the track holds tune notes and closes short gaps in the tune line (music/sustain.ts).
 * Using it to pick the tune line or to move its octave slips did not hold up on the Slakh band set
 * (CREPE-tiny on the mixed stem follows the loudest pitched part, and often reports the octave below).
 */
export const STEM_PITCH = { track: true };

/**
 * The bass stem's own pass and the stem pitch track are extra full-length passes: skipped on
 * memory-constrained devices (phones, tablets, small-memory machines) and above this length.
 */
export const EXTRA_STEM_PASS_MAX_SECONDS = BROWSER_SEPARATION_MAX_SECONDS;

/** Whether the optional stem passes (bass line, stem pitch track) run for a `duration` s import here. */
export function extraStemPasses(params: ExtractionParams, duration: number, constrained: boolean): boolean {
  return !!params.leadPass && !constrained && duration <= EXTRA_STEM_PASS_MAX_SECONDS;
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

/**
 * Strongest onset posterior of a note's pitch from 2 frames before to 5 frames after its start
 * (≈ -25..+60 ms): how clearly the model heard a new attack there.
 */
export function onsetPeak(onsets: Uint8Array | Float32Array, nFrames: number, n: Note): number {
  const f = n.midi - BP_MIDI_OFFSET;
  if (f < 0 || f >= BP_N_PITCHES || nFrames < 1) return 0;
  const s0 = Math.min(nFrames - 1, timeToFrame(n.start));
  let m = 0;
  for (let t = Math.max(0, s0 - 2); t <= Math.min(nFrames - 1, s0 + 5); t++) m = Math.max(m, onsets[t * BP_N_PITCHES + f]);
  return onsets instanceof Uint8Array ? m / 255 : m;
}

/** Posterior thresholds of heldEnd (music/sustain.ts): the "off" level and a new attack's onset. */
export const HOLD = { low: 0.2, restrike: 0.75 };

/**
 * End (s) of a note held while its pitch's frame posterior (median of 5 frames) stays at `low` or
 * above, scanning from its detected end to at most `limit`; a new attack of the pitch (onset
 * posterior at `restrike` or above, past the first 2 frames) stops it. The note's own end when it
 * is not held.
 */
export function heldEnd(
  frames: Uint8Array | Float32Array,
  onsets: Uint8Array | Float32Array | undefined,
  nFrames: number,
  n: Note,
  limit: number,
  rule = HOLD,
): number {
  const f = n.midi - BP_MIDI_OFFSET;
  const end = n.start + n.dur;
  if (f < 0 || f >= BP_N_PITCHES || nFrames < 1) return end;
  const P = BP_N_PITCHES;
  const fs = frames instanceof Uint8Array ? 255 : 1;
  const os = onsets instanceof Uint8Array ? 255 : 1;
  const low = rule.low * fs;
  const at = (t: number) => frames[Math.max(0, Math.min(nFrames - 1, t)) * P + f];
  const med = (t: number) => {
    const w = [at(t - 2), at(t - 1), at(t), at(t + 1), at(t + 2)].sort((a, b) => a - b);
    return w[2];
  };
  const t0 = Math.min(nFrames - 1, timeToFrame(end + ONSET_LATENCY));
  const tMax = Math.min(nFrames - 1, timeToFrame(limit + ONSET_LATENCY));
  let t = t0;
  while (t < tMax && med(t) >= low && !(onsets && t > t0 + 2 && onsets[t * P + f] >= rule.restrike * os)) t++;
  return t > t0 ? Math.min(limit, frameToTime(t) - ONSET_LATENCY) : end;
}

/**
 * The lead-recovery pass of detection parameters with ExtractionParams.leadPass set: LEAD_PASS,
 * unless the main pass is already at least as sensitive (frame threshold and minimum note length
 * at or below the pass's: then it would find nothing the main pass does not).
 */
export function leadPassParams(p: ExtractionParams): Omit<ExtractionParams, 'leadPass'> | undefined {
  if (!p.leadPass) return undefined;
  if (p.frameThreshold <= LEAD_PASS.frameThreshold && p.minNoteMs <= LEAD_PASS.minNoteMs) return undefined;
  return LEAD_PASS;
}

/** The worker options of the lead-recovery pass (leadPassParams), if there is one. */
export function leadWorkerOptions(p: ExtractionParams): NoteExtractionOptions | undefined {
  const lp = leadPassParams(p);
  return lp ? toWorkerOptions(lp) : undefined;
}

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]))
      : v;
const sameParams = (a: object, b: object) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * Stored detection parameters as re-detection should use them: songs imported with the "Full song"
 * preset before lead-line recovery existed carry its parameters without the flag; they get it, so
 * re-detecting such a song gives what a new import would. Anything else is returned unchanged.
 */
export function withLeadPass(p: ExtractionParams): ExtractionParams {
  if (p.leadPass !== undefined) return p;
  const { leadPass: _flag, ...mix } = EXTRACTION_PRESETS.mix;
  void _flag;
  return sameParams(p, mix) ? { ...p, leadPass: true } : p;
}

/** Sung phrases (melody notes, `margin` s either side) as time ranges. */
export function sungRanges(melody: Note[], margin = 0.5): [number, number][] {
  const out: [number, number][] = [];
  for (const n of sortNotes(melody)) {
    const a = n.start - margin;
    const b = n.start + n.dur + margin;
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export interface LeadContext {
  /** the sung melody line (separated songs with singing): nothing is recovered inside its phrases */
  melody?: Note[];
}

/**
 * The accompaniment (or full-mix) notes of a transcription: the main events cleaned (`main`), plus
 * the lead line recovered from the lead pass's events (ExtractionParams.leadPass;
 * music/leadRecovery.ts) in `notes`. Shared by import and re-detection.
 *
 * The recovered notes are Hard-only (role 'lead': Easy and Medium are built without them) unless
 * the song was separated (CleanContext.separated) and has no sung line (LEAD_EVERY_LEVEL): then the
 * tune they complete is the song's only tune and every level gets them, except those struck with a
 * main note an octave away (an octave doubling: Easy and Medium keep the main pass's note).
 * (A main note of the tune line the lead pass shows re-struck is split in two; those pieces are main
 * notes, so all levels get them: music/leadRecovery.ts splitRestrikes.)
 * Letting Easy and Medium use them everywhere was measured and is not worth it: without separation
 * it filled the singer's pauses of the 5 sung test songs (Easy voicing-counted accuracy 0.533 ->
 * 0.491, Easy LH bass 0.648 -> 0.639); with singing it doubled the instrumental-gap tune (vocal-1
 * 62 -> 112 notes) and lowered Easy's voicing-counted accuracy (vocal-1 0.518 -> 0.470). For a
 * separated instrumental it pays: band-instrumental-1 Medium lead-note recall 41 -> 54 % (the two
 * leave-one-source-out references 46 -> 59 %, 42 -> 55 %; pYIN on a separated stem, Medium RCA
 * 0.456 -> 0.506, Easy 0.456 -> 0.495). On the Slakh band set (19 synthesised tracks, exact notes)
 * it is smaller and mixed on Easy: lead recall exact / octaves forgiven Medium 27.9 -> 28.8 % /
 * 37.9 -> 39.5 %, Easy 21.8 -> 21.5 % / 30.6 -> 31.6 %; time the Medium top note is the lead
 * 30.0 -> 29.1 %.
 */
export function accompFromRaw(
  raw: RawNoteEvent[],
  leadRaw: RawNoteEvent[] | undefined,
  rms: Float32Array,
  params: ExtractionParams,
  duration: number,
  ctx: CleanContext = {},
  lead: LeadContext = {},
): { notes: Note[]; main: Note[] } {
  const melody = lead.melody ?? [];
  let main = cleanNotes(raw, rms, params, duration, ctx);
  // the notes the beat is tracked on (the returned `main`): from before the bass-line swap below,
  // so the tempo and beat grid stay as without it (on vocal-3 the cleaner bass line moved the
  // estimate to double time, 85.7 -> 171.4 BPM)
  const tempoNotes = main;
  // everything below (and the bass line) is the "Full song" preset's (ExtractionParams.leadPass); it does not depend on
  // the extra pass having run (a re-detection with a more sensitive main pass has none)
  if (!params.leadPass) return { notes: main, main: tempoNotes };
  // the bass stem read as one bass line in place of the low notes it explains (bassLine.ts)
  const bassLine = ctx.bass ? decodeBassLine(ctx.bass) : [];
  if (ctx.bass && bassLine.length) main = mergeBassLine(main, bassLine, ctx.bass);
  const { frames, onsets, nFrames } = ctx;
  const rise = frames && nFrames ? (n: Note) => frameRise(frames, nFrames, timeToFrame(n.start + ONSET_LATENCY), n.midi) : undefined;
  // one bass note the kick drum chopped into several (music/cleanup.ts foldBassRestrikes)
  // (not needed with the bass line: it has one note at a time and splits only at clear attacks)
  let notes = rise && BASS_FOLD.enabled && !bassLine.length ? foldBassRestrikes(main, rise) : main;
  const leadParams = leadPassParams(params);
  if (leadParams && leadRaw?.length) {
    const candidates = cleanNotes(leadRaw, rms, leadParams, duration, ctx);
    notes = recoverLead(notes, candidates, duration, {
      ...(frames && nFrames && rise
        ? {
            evidence: (n: Note) => ({
              ...noteActivation(frames, nFrames, n),
              rise: rise(n),
              ...(onsets ? { onset: onsetPeak(onsets, nFrames, n) } : {}),
            }),
          }
        : {}),
      ...(melody.length ? { exclude: sungRanges(melody) } : {}),
      ...(LEAD_EVERY_LEVEL.instrumental && ctx.separated && !melody.length ? { doublesHardOnly: true } : { hardOnly: true }),
    });
  }
  // With a sung line the singer carries the tune: nothing is held (holding the instruments' tune in
  // the singer's pauses lowered the 5 sung test songs' voicing-counted Easy / Medium accuracy).
  // Without separation there is no vocal stem to tell a sung song from an instrumental, so a sung
  // song's instruments are held as well (accepted: on the 5 sung test songs without separation Easy
  // / Medium right-hand chroma accuracy rose, 0.236 -> 0.247 / 0.225 -> 0.242, and the
  // voicing-counted accuracy fell, 0.533 -> 0.526 / 0.571 -> 0.556, held notes running into the
  // singer's rests).
  if (!frames || !nFrames || !rise || melody.length) return { notes, main: tempoNotes };
  // the tune line's notes held while the model still hears them (music/sustain.ts)
  const held = sustainTuneLine(notes, duration, {
    // ...and, on separated songs, while the stem's pitch track stays at their pitch class (stemPitch.ts)
    heldEnd: (n, limit) => {
      const e = heldEnd(frames, onsets, nFrames, n, limit);
      return ctx.leadPitch ? pitchHeldEnd(ctx.leadPitch, e > n.start + n.dur ? { ...n, dur: e - n.start } : n, limit) : e;
    },
    ...(onsets ? { onset: (n: Note) => onsetPeak(onsets, nFrames, n) } : {}),
    rise,
    ...(ctx.leadPitch
      ? {
          gapCue: (midi: number, t0: number, t1: number) => gapCue(ctx.leadPitch!, midi, t0, t1),
          continues: (n: Note, x: Note) => pitchContinues(ctx.leadPitch!, n.midi, x.start, x.midi),
        }
      : {}),
  });
  return { notes: held, main: tempoNotes };
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
  // ghosts in near-silence (reverb tails, fades, a stem's noise floor; music/cleanup.ts TAIL_GATE)
  if (TAIL_GATE.enabled && params.tailGate !== false && sortedRms.length) notes = removeTailGhosts(notes, rms, ref);
  notes = removeShortQuiet(notes, Math.min(0.045, params.minNoteMs / 1000), 0.1);
  // nothing sounds past the end of the audio
  notes = notes.filter((n) => n.start < duration).map((n) => (n.start + n.dur > duration ? { ...n, dur: Math.max(0.03, duration - n.start) } : n));
  return sortNotes(notes);
}

/** Vocal-stem note events → the right-hand melody line. */
export function melodyFromRaw(raw: RawNoteEvent[], rms: Float32Array, duration: number): Note[] {
  const line = extractMelodyLine(cleanNotes(raw, rms, VOCAL_EXTRACTION, duration));
  return line.length >= MIN_MELODY_NOTES ? line : [];
}

const aborted = () => new DOMException('Transcription cancelled', 'AbortError');

/**
 * Whether the separated vocal stem goes back into the audio the accompaniment pass transcribes:
 * when separation found no singing (an instrumental, or vocals under the presence gate), or found
 * singing but no melody line came out of it (melodyFromRaw: too few notes), so that what is in the
 * stem is transcribed with the rest instead of being lost.
 */
export function vocalsIntoAccomp(vocalsPresent: boolean, melodyNotes: number): boolean {
  return !vocalsPresent || melodyNotes === 0;
}

/**
 * Adding the vocal stem back (vocalsIntoAccomp): per block of `block` samples, gain 0 where the
 * stem is more than `offDb` below the accompaniment block's level, 1 where it is within `onDb`,
 * linear in dB between; each block's gain is the largest of the `spread` blocks either side (so the
 * start and end of a phrase are not cut), and it is interpolated linearly sample by sample.
 *
 * Why: SCNet has 4 stems; a lead instrument that is not bass or "other" leaks into "vocals": in
 * band-instrumental-1 the vocal stem holds 35-62 % of the closing lead's energy (the held climax
 * notes, MIDI 84-86, 165-170.7 s; there the stem is 0-5 dB below the accompaniment) and 14-41 % of
 * the phrase at 143-148 s; on the accompaniment alone the final notes' posteriors fell to
 * 0.24-0.30 (0.44-0.63 on the mix). Elsewhere the stem is separator residue 40-50 dB down. Adding
 * that residue changes nothing musically but flips near-threshold notes: with the "Sensitive"
 * preset 3 short lead notes at 31-32 s (residue -42..-44 dB) were lost, 0:30-0:38 lead recall
 * 56 -> 44 %. With the gate the residue stays out.
 */
export const VOCAL_ADDBACK = { block: 2048, offDb: -30, onDb: -20, spread: 5 };

export function addVocalsInto(accomp: Float32Array, vocals: Float32Array, rule = VOCAL_ADDBACK): void {
  const n = Math.min(accomp.length, vocals.length);
  const B = rule.block;
  const nb = Math.ceil(n / B);
  if (!nb) return;
  const raw = new Float32Array(nb);
  for (let b = 0; b < nb; b++) {
    let ea = 0;
    let ev = 0;
    for (let i = b * B, e = Math.min(n, i + B); i < e; i++) {
      ea += accomp[i] * accomp[i];
      ev += vocals[i] * vocals[i];
    }
    if (ev <= 0) continue;
    const db = 10 * Math.log10(ev / Math.max(ea, 1e-20));
    raw[b] = Math.min(1, Math.max(0, (db - rule.offDb) / (rule.onDb - rule.offDb)));
  }
  const gain = new Float32Array(nb);
  for (let b = 0; b < nb; b++) {
    let g = 0;
    for (let k = Math.max(0, b - rule.spread); k <= Math.min(nb - 1, b + rule.spread); k++) g = Math.max(g, raw[k]);
    gain[b] = g;
  }
  for (let i = 0; i < n; i++) {
    // block centres at (b + 0.5) * B
    const x = i / B - 0.5;
    const b0 = Math.max(0, Math.min(nb - 1, Math.floor(x)));
    const b1 = Math.min(nb - 1, b0 + 1);
    const f = Math.max(0, Math.min(1, x - b0));
    const g = gain[b0] + (gain[b1] - gain[b0]) * f;
    if (g > 0) accomp[i] += g * vocals[i];
  }
}

/**
 * CREPE settings for the other stem's pitch track: the instruments' range. fmax stays below the
 * model's top bins (CREPE's Viterbi transition rows are normalised over all 360 bins, so the edge
 * bins keep a larger self-transition; with a 2 kHz ceiling the path stuck at ~1.98 kHz).
 */
export const STEM_PITCH_TRACK = { hopMs: 10, fmin: 65, fmax: 1700 };

/** Level of `stem` against `ref` in dB: 95th-percentile RMS of 2048-sample blocks. */
export function stemLevelDb(stem: Float32Array, ref: Float32Array): number {
  const B = 2048;
  const blocks = (x: Float32Array) => {
    const out: number[] = [];
    for (let i = 0; i + B <= x.length; i += B) {
      let e = 0;
      for (let k = i; k < i + B; k++) e += x[k] * x[k];
      out.push(Math.sqrt(e / B));
    }
    out.sort((a, b) => a - b);
    return out.length ? out[Math.floor(out.length * 0.95)] : 0;
  };
  const a = blocks(stem);
  const b = blocks(ref);
  return a > 0 && b > 0 ? 20 * Math.log10(a / b) : -Infinity;
}

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
    { type: 'transcribe', audio, modelUrl: modelUrl(), options: toWorkerOptions(params), leadOptions: leadWorkerOptions(params), device: pageDeviceInfo() },
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
  if (opts.engine === 'piano-specialist') return transcribeWithSpecialist(blob, onProgress, signal, opts, t0);
  onProgress({ stage: 'decoding', progress: null, detail: 'Decoding and resampling audio' });
  // (the decoded AudioBuffer is not kept: separation decodes again at 44.1 kHz and memory is tight)
  let { audio, duration } = await decodeMono(blob, BP_SAMPLE_RATE);
  if (signal?.aborted) throw aborted();
  const warnings: string[] = [];
  let separationFailure: TranscriptionResult['separationFailure'];
  const level = analyzeLevel(audio);
  if (level.peak < 0.01) throw new Error('The audio is (nearly) silent — nothing to transcribe.');
  if (level.rms < 0.01) warnings.push('The recording is very quiet; quiet notes may be missed.');

  // ---- optional source separation
  // a reused in-page result is copied: its arrays are normalised in place and transferred below
  let sep: SeparationResult | null = opts.separation
    ? { ...opts.separation, accomp: opts.separation.accomp.slice(), vocals: opts.separation.vocals.slice(), ...(opts.separation.bass ? { bass: opts.separation.bass.slice() } : {}) }
    : null;
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
  if (sep && sep.sampleRate !== BP_SAMPLE_RATE) throw new Error(`Separated stems have an unexpected sample rate (${sep.sampleRate} Hz).`);

  // ---- the passes over the stems, numbered for the progress text
  // The bass line and the stem pitch track are the "Full song" preset's (a piano recording's low
  // register lands in the bass stem: read as one line it would lose the left hand's octaves and
  // chords), and are skipped on memory-constrained devices and long recordings (extraStemPasses).
  const device = pageDeviceInfo();
  const extra = !!sep?.bass && extraStemPasses(params, duration, !!device && isMemoryConstrained(device));
  // the bass stem as one bass line (bassLine.ts): browser separation with an audible bass stem
  const bassStem = extra && sep?.bass && stemLevelDb(sep.bass, sep.accomp) >= BASS_LINE.minLevelDb ? sep.bass : undefined;
  // the lead-bearing stem's pitch track (stemPitch.ts): only used without a sung line (decided after the vocal pass)
  const tracksPitch = extra && STEM_PITCH.track;
  const passes = (withVocals ? 1 : 0) + 1 + (bassStem ? 1 : 0);
  let pass = 0;
  const step = (what: string) => (passes > 1 ? `${what} (${++pass} of ${passes})` : what);

  // ---- vocal melody (first: whether a melody line comes out decides what the accompaniment pass hears)
  let vocal: ModelRun | null = null;
  let melody: Note[] = [];
  if (sep && withVocals) {
    // a copy: the stem itself may still be added back into the accompaniment (vocalsIntoAccomp)
    const v = sep.vocals.slice();
    normalise(v);
    vocal = await runModel(v, VOCAL_EXTRACTION, onProgress, signal, step('Neural pitch detection — vocal melody'));
    melody = melodyFromRaw(vocal.notes, vocal.rms, duration);
  }
  const vocalsBack = !!sep && vocalsIntoAccomp(withVocals, melody.length);
  // the other stem (accompaniment minus bass), before the accompaniment is normalised and handed
  // over; with a sung line nothing uses the track (the singer carries the tune), so it is not run
  let other: Float32Array | null = null;
  if (sep && tracksPitch && sep.bass && !melody.length) {
    other = new Float32Array(sep.accomp.length);
    for (let i = 0; i < other.length; i++) other[i] = sep.accomp[i] - (sep.bass[i] ?? 0);
    if (vocalsBack) addVocalsInto(other, sep.vocals);
  }
  if (sep) {
    audio = sep.accomp;
    // no sung line: the vocal stem holds lead-instrument leakage (or singing nothing else will show), so it goes back into what is transcribed
    if (vocalsBack) addVocalsInto(audio, sep.vocals);
  }
  normalise(audio);

  // ---- accompaniment (or the full mix)
  const what = sep ? step('Neural pitch detection — accompaniment') : 'Neural pitch detection';
  const result = await runModel(audio, params, onProgress, signal, what);

  // ---- bass stem: its own pass, read as one line in accompFromRaw (a failure only loses the line)
  let bass: StoredPosteriors['bass'];
  if (bassStem) {
    normalise(bassStem);
    const { leadPass: _lp, ...bassParams } = params;
    void _lp;
    try {
      const b = await runModel(bassStem, bassParams, onProgress, signal, step('Neural pitch detection — bass line'));
      bass = { nFrames: b.nFrames, pitches: BASS_BAND_PITCHES, frames: bassBand(b.frames, b.nFrames), onsets: bassBand(b.onsets, b.nFrames) };
    } catch (err) {
      if (signal?.aborted || (err as Error)?.name === 'AbortError') throw aborted();
      console.warn('[transcription] bass stem pass failed', err);
      warnings.push('The bass line could not be read from its own stem; the low notes come from the accompaniment.');
    }
  }
  // ---- the tune cue: pitch track of the other stem (failures only lose the cue)
  let leadPitch: StoredPitch | undefined;
  if (other) {
    const detail = 'Following the tune in the instruments';
    try {
      const { trackVocalPitchDetailed } = await import('../pitch');
      const t = await trackVocalPitchDetailed(other, (f) => onProgress({ stage: 'analyzing', progress: f, detail }), signal, STEM_PITCH_TRACK);
      leadPitch = storedPitch({ f0: t.rawF0, periodicity: t.periodicity, rms: t.rms, hop: t.hop });
    } catch (err) {
      if (signal?.aborted || (err as Error)?.name === 'AbortError') throw aborted();
      console.warn('[transcription] stem pitch tracking failed', err);
    }
    other = null;
  }
  if (signal?.aborted) throw aborted();

  onProgress({ stage: 'arranging', progress: null, detail: melody.length ? 'Fitting the vocal melody, assigning hands, tracking beats' : 'Cleaning notes, assigning hands, tracking beats' });
  const drums = sep?.drumOnsets;
  const accomp = accompFromRaw(result.notes, result.leadNotes, result.rms, params, duration, { frames: result.frames, onsets: result.onsets, nFrames: result.nFrames, drums, bass, leadPitch, separated: !!sep }, { melody });
  const accompNotes = accomp.notes;
  const notes = mergeMelody(accompNotes, melody, duration);
  if (result.backend === 'cpu') {
    warnings.push('Ran on the CPU fallback backend (no WebGL/WASM available); transcription was slower than usual.');
  }
  if (vocal && !melody.length) warnings.push('Singing was detected but no clear melody line could be extracted from it.');
  if (notes.length === 0) warnings.push('No notes were detected. Try the "Sensitive" detection preset.');
  const tempo = transcriptionTempo(accomp.main, notes, duration);
  if (tempo.confidence < 0.15) warnings.push('Tempo could not be detected reliably; the beat grid and quantisation may be off.');
  const meanConf = result.notes.length ? result.notes.reduce((s, n) => s + n.amplitude, 0) / result.notes.length : 0;
  return {
    notes,
    duration,
    tempo,
    key: detectKey(notes),
    posteriors: { ...toStored(result, drums?.length ? drums : undefined), ...(bass ? { bass } : {}), ...(leadPitch ? { leadPitch } : {}), ...(sep ? { separated: true as const } : {}) },
    info: {
      method: 'basic-pitch',
      estimated: true,
      params,
      backend: result.backend,
      processingMs: Math.round(performance.now() - t0),
      ...(sep
        ? {
            separated: true,
            separation: {
              engine: sep.engine,
              vocals: melody.length > 0,
              ...(vocalsBack ? { vocalsInAccomp: true } : {}),
              ms: Math.round(sep.ms),
              ...(sep.threads ? { threads: sep.threads } : {}),
            },
          }
        : {}),
      warnings,
      confidence: Math.round(meanConf * 100) / 100,
    },
    ...(separationFailure ? { separationFailure } : {}),
  };
}

// ---------------------------------------------------------------- piano specialist

/** What the pipeline uses of lib/pianoSpecialist's result (see pianoSpecialist/protocol.ts). */
type SpecialistRun = RegressionOutputs & { ms: number; threads: number };

/**
 * Specialist notes → the app's notes. None of the Basic Pitch cleanup is applied: its fragment and
 * continuation merges, harmonic suppression and short-quiet filter are fixes for Basic Pitch's
 * posteriors. Measured on the first 90 s of 3 MAESTRO pieces (onset F1@50 ms vs the exact MIDI):
 * none 0.970 / 0.965 / 0.991; the short-quiet filter drops correct soft notes (Mozart 0.991 →
 * 0.936); harmonic suppression changes nothing beyond ±0.001. Only notes past the end are dropped.
 */
export function specialistNotes(run: RegressionOutputs, duration: number): Note[] {
  return regressionToNotes(run).filter((n) => n.start < duration);
}

/** Progress text for the piano specialist: real download bytes, then the 10 s parts done. */
export function specialistDetail(e: { stage: 'loading-model' | 'analyzing'; loaded?: number; total?: number; done?: number; segments?: number }): string {
  if (e.stage === 'loading-model') {
    if (e.total && e.loaded !== undefined && e.loaded < e.total) {
      return `Downloading the piano model, once (${Math.round(e.loaded / 1e6)} of ${Math.round(e.total / 1e6)} MB)`;
    }
    return 'Loading the piano model';
  }
  return e.segments ? `Listening to the piano (part ${Math.min(e.segments, (e.done ?? 0) + 1)} of ${e.segments})` : 'Listening to the piano';
}

/**
 * The error text for a failed piano-specialist run: out-of-memory errors of onnxruntime / Emscripten /
 * V8 (or a worker that died without a message) get plain advice instead of the engine's text; the
 * worker's own download / checksum errors are already plain and are kept.
 */
export function specialistFailureMessage(err: unknown): string {
  const e = err as Error | undefined;
  const msg = e?.message ?? String(err);
  if (MEMORY_ERROR.test(`${e?.name ?? ''} ${msg}`)) {
    return 'The high-accuracy piano model ran out of memory on this device. Close other tabs and try again, or use the normal model.';
  }
  return msg;
}

/** The on-demand load of the specialist's code failed (offline, or a tab left open across an app update). */
export const SPECIALIST_CODE_FAILED =
  'Could not load the piano model’s code. Check your internet connection, reload the page and try again, or use the normal model.';

async function transcribeWithSpecialist(
  blob: Blob,
  onProgress: (e: ProgressEvent) => void,
  signal: AbortSignal | undefined,
  opts: TranscribeOptions,
  t0: number,
): Promise<TranscriptionResult> {
  onProgress({ stage: 'decoding', progress: null, detail: 'Decoding and resampling audio' });
  // only the mono samples and the duration are kept (the AudioBuffer is not)
  let audio: Float32Array | null;
  let duration: number;
  ({ audio, duration } = await decodeMono(blob, SPECIALIST_SAMPLE_RATE));
  if (signal?.aborted) throw aborted();
  const warnings: string[] = [];
  const level = analyzeLevel(audio);
  if (level.peak < 0.01) throw new Error('The audio is (nearly) silent — nothing to transcribe.');
  if (level.rms < 0.01) warnings.push('The recording is very quiet; quiet notes may be missed.');
  if (opts.separate || opts.stems || opts.separation) warnings.push('"Separate vocals & drums" is not used with the high-accuracy piano model.');
  // (not normalised: the model was trained on, and the reference runs on, the recording's own level)

  // Any length runs, also on phones: the checkbox warns that long recordings might not work on phones
  // with little memory (PTI_CONSTRAINED_MAX_SECONDS), and if the tab is killed the interrupted-import
  // notice offers the normal model.

  onProgress({ stage: 'loading-model', progress: null, detail: 'Loading the piano model' });
  // loaded on demand: the model's runtime is only downloaded when someone asks for it
  let runPianoSpecialist: typeof import('../pianoSpecialist').runPianoSpecialist;
  try {
    ({ runPianoSpecialist } = await import('../pianoSpecialist'));
  } catch (err) {
    throw new Error(SPECIALIST_CODE_FAILED, { cause: err });
  }
  if (signal?.aborted) throw aborted();
  let run: SpecialistRun;
  try {
    run = await runPianoSpecialist(
      audio,
      (e) => onProgress({ stage: e.stage, progress: e.progress, detail: specialistDetail(e) }),
      signal,
      // the Studio opens right after: free the model's ~550 MB now instead of keeping the worker warm;
      // the samples are handed to the worker (the pipeline only needs the duration from here on)
      { release: true, transfer: true },
    );
  } catch (err) {
    if ((err as Error)?.name === 'AbortError' || signal?.aborted) throw err;
    console.warn('[transcription] piano model failed', err);
    throw new Error(specialistFailureMessage(err), { cause: err });
  }
  audio = null;
  if (signal?.aborted) throw aborted();

  onProgress({ stage: 'arranging', progress: null, detail: 'Assigning hands, tracking beats' });
  const cleaned = specialistNotes(run, duration);
  const notes = assignHands(cleaned, duration);
  if (notes.length === 0) warnings.push('No notes were detected. Is this a piano recording? Try again with the normal model.');
  const tempo = transcriptionTempo(notes, notes, duration);
  if (tempo.confidence < 0.15) warnings.push('Tempo could not be detected reliably; the beat grid and quantisation may be off.');
  return {
    notes,
    duration,
    tempo,
    key: detectKey(notes),
    info: {
      method: 'piano-specialist',
      estimated: true,
      // (no detection params: Basic Pitch's thresholds do not apply)
      backend: run.threads > 1 ? `wasm (${run.threads} threads)` : 'wasm',
      processingMs: Math.round(performance.now() - t0),
      warnings,
    },
  };
}

/** Decode at a model's rate and mix down; only the mono samples and the duration are kept. */
async function decodeMono(blob: Blob, sampleRate: number): Promise<{ audio: Float32Array; duration: number }> {
  const buffer = await decodeToRate(blob, sampleRate);
  return { audio: mixToMono(buffer), duration: buffer.duration };
}

async function extractRaw(post: StoredPosteriors, params: ExtractionParams): Promise<{ notes: RawNoteEvent[]; leadNotes?: RawNoteEvent[] }> {
  const frames = post.frames.slice();
  const onsets = post.onsets.slice();
  const res = await transcriber.run(
    { type: 'extract', frames, onsets, nFrames: post.nFrames, options: toWorkerOptions(params), leadOptions: leadWorkerOptions(params) },
    [frames.buffer, onsets.buffer],
    () => {},
    undefined,
    'extracted',
  );
  return { notes: res.notes, leadNotes: res.leadNotes };
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
  const { main, notes } = await reextract(post, params, duration, opts);
  return { notes, tempo: transcriptionTempo(main, notes, duration) };
}

/** The clean context of stored posteriors (re-detection): the same evidence an import passes to accompFromRaw. */
export function storedContext(post: StoredPosteriors): CleanContext {
  return { frames: post.frames, onsets: post.onsets, nFrames: post.nFrames, drums: post.drums, bass: post.bass, leadPitch: post.leadPitch, separated: !!post.separated };
}

async function reextract(post: StoredPosteriors, params: ExtractionParams, duration: number, opts: ReextractOptions): Promise<{ main: Note[]; notes: Note[] }> {
  const raw = await extractRaw(post, params);
  const melody = (opts.melody ?? []).filter((n) => n.role === 'melody').map((n) => ({ ...n, hand: 'R' as const }));
  const accomp = accompFromRaw(raw.notes, raw.leadNotes, post.rms, params, duration, storedContext(post), { melody });
  return { main: accomp.main, notes: mergeMelody(accomp.notes, melody, duration) };
}
