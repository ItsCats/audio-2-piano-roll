/**
 * Messages between src/lib/pianoSpecialist/index.ts and worker.ts, plus the model's fixed shapes and
 * the segment maths both sides (and the unit tests) share. Pure: no DOM, no onnxruntime.
 *
 * The model (public/models/piano-specialist/README.md) takes 10 s of 16 kHz mono audio
 * ([1, 160000]) and returns four [1, 1001, 88] float32 maps at 100 frames/s, MIDI 21..108:
 * frame (note-on probability), onset / offset (regressed onset/offset, Kong et al. 2021) and velocity.
 */

/** model input rate */
export const PTI_SAMPLE_RATE = 16000;
/** samples per model call (piano_transcription_inference segment_samples) */
export const PTI_SEGMENT_SAMPLES = 160000;
/** segments overlap by half */
export const PTI_HOP_SAMPLES = PTI_SEGMENT_SAMPLES / 2;
/** output frames per model call (centred STFT: one more than 10 s x 100 fps) */
export const PTI_SEGMENT_FRAMES = 1001;
export const PTI_FPS = 100;
export const PTI_PITCHES = 88;
/** MIDI note of pitch index 0 */
export const PTI_LOWEST_MIDI = 21;
/** model output names, in the order the result carries them */
export const PTI_OUTPUTS = ['frame', 'onset', 'offset', 'velocity'] as const;
export type PtiOutput = (typeof PTI_OUTPUTS)[number];

/**
 * Extra tab memory while the model runs, by recording length. Measured through the real app (Import page →
 * Studio, Mozart K. 280/1, 3:14, 3 threads, 2026-11-12): the whole browser grew by +720 MB RSS / +740 MB PSS.
 * That is ~550 MB for the onnxruntime session (float32 weights after the float16 cast, convolution / GRU
 * workspaces; the same with 1 or 3 threads) plus the model's transient copies, and per second of audio:
 * the four output maps (88 x 100 fps x 4 B x 4 = 0.14 MB/s, built in the worker and transferred), the
 * 16 kHz audio (0.064 MB/s, transferred to the worker) and the decoder's transient buffers. Modelled as
 * 700 MB + 0.25 MB per second (3:14 → 750 MB, 4 min → 760 MB, 20 min → 1000 MB), rounded to 50 MB.
 */
export const PTI_BASE_MB = 700;
export const PTI_MB_PER_SECOND = 0.25;
export function specialistMemoryMB(seconds: number): number {
  return Math.round((PTI_BASE_MB + PTI_MB_PER_SECOND * Math.max(0, seconds)) / 50) * 50;
}
/**
 * Recordings longer than this may not work on memory-constrained devices (phones, tablets, ≤ 4 GB):
 * the checkbox warns about it, but the model still runs. At 6 minutes it needs ~800 MB extra and, on
 * a phone's processor, a long time.
 */
export const PTI_CONSTRAINED_MAX_SECONDS = 6 * 60;

/**
 * The plain-language error for a download that failed on the network (offline, a dropped mobile
 * connection): the browsers' own texts ("Failed to fetch", "Load failed", "NetworkError when attempting
 * to fetch resource.", "network error") tell a non-expert nothing.
 */
export function downloadFailedMessage(expectedBytes: number): string {
  const mb = expectedBytes > 0 ? ` (${Math.round(expectedBytes / 1e6)} MB)` : '';
  return `Could not download the piano model${mb}. Check your internet connection and try again, or use the normal model.`;
}

export interface RunRequest {
  type: 'run';
  jobId: number;
  /** mono 16 kHz audio (transferred) */
  audio16k: Float32Array;
  /** WASM threads wanted (capped to 1 when the worker is not cross-origin isolated) */
  threads?: number;
  /** absolute model URL (index.ts fills it in); with modelParts only the Cache API key */
  modelUrl?: string;
  /** absolute URLs of the model's consecutive pieces, joined in order (the shipped file is split) */
  modelParts?: string[];
  /** model size in bytes, for download progress */
  modelBytes?: number;
  /** expected sha256 of the model file (hex) */
  modelSha256?: string;
  /** release the onnxruntime session after this job (memory-constrained devices; index.ts terminates the worker too) */
  release?: boolean;
}

export type WorkerRequest = RunRequest;

export type ProgressStage = 'loading-model' | 'analyzing';

export interface ProgressMessage {
  type: 'progress';
  jobId: number;
  /** 0..1 within the stage: downloaded bytes, then 0.9..1 while the session compiles; segments done while analysing */
  progress: number;
  stage: ProgressStage;
  /** loading-model: bytes downloaded so far / expected (0 when served from the cache) */
  loaded?: number;
  total?: number;
  /** analyzing: segments done / total */
  done?: number;
  segments?: number;
}

export interface RunStats {
  /** the model came from the Cache API (or the session was reused) */
  fromCache: boolean;
  /** the worker's session from an earlier job was reused (no download, no compile) */
  reusedSession: boolean;
  /** download (or cache read) + sha256 check */
  loadMs: number;
  /** onnxruntime session creation (0 when the worker's session was reused) */
  createMs: number;
  /** model calls */
  inferMs: number;
  segments: number;
}

export interface ResultMessage {
  type: 'result';
  jobId: number;
  nFrames: number;
  fps: typeof PTI_FPS;
  /** each nFrames x 88, frame-major (index t * 88 + pitch), pitch 0 = MIDI 21 */
  frame: Float32Array;
  onset: Float32Array;
  offset: Float32Array;
  velocity: Float32Array;
  /** wall time of the job in the worker */
  ms: number;
  /** WASM threads onnxruntime ran with */
  threads: number;
  stats: RunStats;
}

export interface ErrorMessage {
  type: 'error';
  jobId: number;
  message: string;
}

export type WorkerResponse = ProgressMessage | ResultMessage | ErrorMessage;

// ------------------------------------------------------------------ segment maths (as the Python package)

/**
 * Segment starts for `n` samples, as PianoTranscription.transcribe does it: zero-pad to a multiple of
 * 160000 samples, then 160000-sample windows every 80000 samples. `padded` is the padded length.
 */
export function planSegments(n: number): { starts: number[]; padded: number } {
  const padded = Math.max(1, Math.ceil(n / PTI_SEGMENT_SAMPLES)) * PTI_SEGMENT_SAMPLES;
  const starts: number[] = [];
  for (let p = 0; p + PTI_SEGMENT_SAMPLES <= padded; p += PTI_HOP_SAMPLES) starts.push(p);
  return { starts, padded };
}

/**
 * Output frames after deframing `segments` model calls (PianoTranscription.deframe): one segment
 * keeps all 1001 frames; otherwise each segment's last frame is dropped and the middle halves are
 * concatenated (first segment from frame 0, last one to its end): 500 * (segments + 1).
 * (The package then slices with the SAMPLE count, which never cuts anything, so neither do we.)
 */
export function deframedLength(segments: number): number {
  if (segments <= 1) return PTI_SEGMENT_FRAMES;
  const f = PTI_SEGMENT_FRAMES - 1;
  return f * 0.75 * 2 + (segments - 2) * f * 0.5;
}

/**
 * Which frames of segment `i` (of `segments`) are kept, and where they go in the deframed output:
 * frames [from, to) of the segment's [1001, 88] map land at output frame `dest`.
 */
export function keptFrames(i: number, segments: number): { from: number; to: number; dest: number } {
  if (segments <= 1) return { from: 0, to: PTI_SEGMENT_FRAMES, dest: 0 };
  const f = PTI_SEGMENT_FRAMES - 1; // 1000: the extra centered-STFT frame is dropped
  const q = f / 4;
  if (i === 0) return { from: 0, to: 3 * q, dest: 0 };
  const dest = 3 * q + (i - 1) * 2 * q;
  if (i === segments - 1) return { from: q, to: f, dest };
  return { from: q, to: 3 * q, dest };
}

/** Copy the kept frames of one segment's [1001 x 88] output into the deframed [nFrames x 88] map. */
export function placeSegment(out: Float32Array, seg: Float32Array, i: number, segments: number): void {
  const { from, to, dest } = keptFrames(i, segments);
  out.set(seg.subarray(from * PTI_PITCHES, to * PTI_PITCHES), dest * PTI_PITCHES);
}

/** One 160000-sample model input starting at `start` (zeros past the end of `audio`). */
export function segmentInput(audio: Float32Array, start: number, into = new Float32Array(PTI_SEGMENT_SAMPLES)): Float32Array {
  const end = Math.min(audio.length, start + PTI_SEGMENT_SAMPLES);
  if (end > start) into.set(audio.subarray(start, end));
  into.fill(0, Math.max(0, end - start));
  return into;
}
