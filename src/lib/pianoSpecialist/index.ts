/**
 * The piano specialist: ByteDance's high-resolution piano transcription note model (Kong et al. 2021;
 * inference code MIT (piano_transcription_inference), training code Apache-2.0 (bytedance/piano_transcription),
 * checkpoint CC BY 4.0; public/models/piano-specialist/README.md) in the browser, for the
 * import option "High-accuracy piano model". Solo piano only: it was trained on MAESTRO
 * (piano recordings) and does not help with vocals, drums or band mixes.
 *
 * runPianoSpecialist() takes mono 16 kHz audio (decodeToRate(blob, 16000) + mixToMono) and returns the
 * model's four output maps, segmented and deframed exactly like piano_transcription_inference 0.0.6;
 * postprocess.ts turns them into notes. The model runs in a module worker on onnxruntime-web's WASM
 * backend, multi-threaded on cross-origin-isolated pages (src/lib/isolation.ts).
 */
import { isMemoryConstrained, isPhoneOrTablet, pageDeviceInfo, type DeviceInfo } from '../transcription/backendChoice';
import { wasmThreads } from '../isolation';
import { PTI_CONSTRAINED_MAX_SECONDS, PTI_FPS, PTI_SAMPLE_RATE, planSegments, specialistMemoryMB } from './protocol';
import type { ProgressStage, RunRequest, RunStats, WorkerResponse } from './protocol';

export { PTI_SAMPLE_RATE, PTI_FPS, PTI_CONSTRAINED_MAX_SECONDS, specialistMemoryMB } from './protocol';
export type { ProgressStage, RunStats } from './protocol';

/**
 * The model file (README.md there) is shipped as PIANO_SPECIALIST_MODEL_PARTS consecutive pieces of
 * ~8.2 MB (Netlify recommends at most 10 MB per deployed file): piano-note.fp16.part1.bin … part5.bin.
 * The worker joins them, checks the sha256 of the whole and caches it under PIANO_SPECIALIST_MODEL_PATH
 * (a Cache API key only; no such file is served).
 */
export const PIANO_SPECIALIST_MODEL_PATH = 'models/piano-specialist/piano-note.fp16.onnx';
export const PIANO_SPECIALIST_MODEL_PARTS = 5;
export function pianoSpecialistPartPaths(): string[] {
  return Array.from({ length: PIANO_SPECIALIST_MODEL_PARTS }, (_, i) => `models/piano-specialist/piano-note.fp16.part${i + 1}.bin`);
}
export const PIANO_SPECIALIST_MODEL_SHA256 = '8fd48c407cd15dd88b98c3803b5f037291a93003767ed590dc647fff21e03c59';
export const PIANO_SPECIALIST_MODEL_BYTES = 41_044_512;
/**
 * Extra memory of the tab while the model runs for a 4-minute piece (the figure the Import card shows):
 * protocol.ts specialistMemoryMB, measured as the RSS of the whole browser through the real app
 * (+720 MB RSS / +740 MB PSS for a 3:14 piece) and modelled as 700 MB + 0.25 MB per second of audio
 * (the output maps and the 16 kHz audio grow with the length: a 20-minute file needs ~1 GB). Freed
 * when the worker is terminated.
 */
export const PIANO_SPECIALIST_EXTRA_MB = specialistMemoryMB(240);
/**
 * Measured wall time per minute of audio by WASM thread count (index = threads), headless Chromium
 * on a shared 4-core x86 box (load average 1.5–4 from other jobs), model already compiled. A long piece
 * needs 12 model calls (10 s windows every 5 s) per minute: ~7.7 s per call with 1 thread (full
 * 3.2-minute MAESTRO piece: 94 s/min), ~4.2 s with 2, 3.0–4.2 s with 3 (36 s/min on the same piece);
 * 4 threads were no faster than 3 on this box (4 = estimate). Real desktops are usually faster.
 * Final measurement through the whole app pipeline (2026-11-12, 11 piano recordings of 2–10 minutes,
 * decoding and arranging included): 36–41 s/min with 3 threads (mean 38), 97 s/min with 1 thread.
 */
const SECONDS_PER_MINUTE = [97, 97, 52, 38, 36];
/**
 * One-off on the first run: the 41 MB download (time depends on the connection: ~7 s at 50 Mbit/s)
 * plus the sha256 check and session compile (0.4–0.8 s measured). Later runs read the Cache API copy
 * (~0.1 s) and compile again unless the worker is still warm.
 */
export const COMPILE_SECONDS = 1;
/**
 * How long a finished worker (and its compiled session) is kept for the next import on devices that
 * are not memory-constrained. A WASM memory never shrinks while its worker lives, so idle workers are
 * terminated; memory-constrained devices terminate it right after each job.
 */
export const IDLE_WORKER_MS = 60_000;

export interface PianoSpecialistSupport {
  /** the model can run in this browser */
  available: boolean;
  /** and it is a good idea on this device (false on phones / tablets / ≤ 4 GB devices) */
  recommended: boolean;
  /** why it is unavailable or not recommended (UI text) */
  reason?: string;
  /** model download, MB (once; cached afterwards) */
  downloadMB: number;
  /** extra memory while it runs for a 4-minute piece, MB (more for longer recordings: specialistMemoryMB) */
  memoryMB: number;
  /** recordings longer than this might not work here (memory-constrained devices only; they still run) */
  warnAboveSeconds?: number;
  /** expected wall time per minute of audio on this device */
  estSecondsPerMinute: number;
  /** WASM threads it would use here */
  threads: number;
  /** a phone or tablet (UI: "May be slow on phones.") */
  phone?: boolean;
}

// a tiny module using a v128 instruction: onnxruntime-web 1.31 ships SIMD builds only
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

function hasSimd(): boolean {
  try {
    return typeof WebAssembly === 'object' && WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

/**
 * Expected seconds per audio minute with `threads` WASM threads; x3 on phones and tablets (their
 * processors, not their memory: a desktop that reports 4 GB runs at desktop speed).
 */
export function estimateSecondsPerMinute(threads: number, phone = false): number {
  const base = SECONDS_PER_MINUTE[Math.max(1, Math.min(SECONDS_PER_MINUTE.length - 1, Math.round(threads)))];
  return phone ? base * 3 : base;
}

/**
 * Whether the piano specialist can run here and whether to recommend it. Pure apart from the defaults
 * (the page's device facts and thread count), so tests can pass their own.
 */
export function pianoSpecialistSupport(
  device: DeviceInfo | undefined = pageDeviceInfo(),
  threads: number = wasmThreads(4),
  env: { worker?: boolean; simd?: boolean } = {},
): PianoSpecialistSupport {
  const downloadMB = Math.round(PIANO_SPECIALIST_MODEL_BYTES / 1e6);
  const memoryMB = PIANO_SPECIALIST_EXTRA_MB;
  const constrained = device ? isMemoryConstrained(device) : false;
  const phone = device ? isPhoneOrTablet(device) : false;
  const base = { downloadMB, memoryMB, threads, phone, estSecondsPerMinute: estimateSecondsPerMinute(threads, phone) };
  const worker = env.worker ?? typeof Worker !== 'undefined';
  if (!worker) return { ...base, available: false, recommended: false, reason: 'This browser has no Web Worker support.' };
  if (!(env.simd ?? hasSimd())) {
    return { ...base, available: false, recommended: false, reason: 'This browser does not support WebAssembly SIMD, which the piano model needs.' };
  }
  if (constrained) {
    const mem = device?.deviceMemory;
    return {
      ...base,
      available: true,
      recommended: false,
      warnAboveSeconds: PTI_CONSTRAINED_MAX_SECONDS,
      reason:
        (!phone && typeof mem === 'number' ? `This device reports ${mem} GB of memory. ` : 'Not recommended on phones and tablets. ') +
        `The piano model needs about ${memoryMB} MB of extra memory for a 4-minute piece (more for longer ones)` +
        (phone ? ' and several minutes per song here' : '') +
        `, and the browser may reload the page if it runs out. Recordings over ${PTI_CONSTRAINED_MAX_SECONDS / 60} minutes might not work on this device.`,
    };
  }
  return { ...base, available: true, recommended: true };
}

export interface SpecialistProgress {
  stage: ProgressStage;
  /** 0..1 within the stage */
  progress: number;
  /** loading-model: model bytes downloaded / expected (absent when it came from the cache) */
  loaded?: number;
  total?: number;
  /** analyzing: 10 s segments done / total */
  done?: number;
  segments?: number;
}

export interface PianoSpecialistResult {
  nFrames: number;
  fps: typeof PTI_FPS;
  /** each nFrames x 88, frame-major (t * 88 + pitch), pitch 0 = MIDI 21 */
  frame: Float32Array;
  onset: Float32Array;
  offset: Float32Array;
  velocity: Float32Array;
  /** wall time of the whole call (main thread) */
  ms: number;
  threads: number;
  stats: RunStats;
}

export interface RunOptions {
  /** absolute or page-relative URL of the whole model file, fetched instead of the shipped pieces (tests / harnesses) */
  modelUrl?: string;
  /** WASM threads (default: wasmThreads(4), i.e. 1 unless the page is cross-origin isolated) */
  threads?: number;
  /** release the session and terminate the worker afterwards (default: on memory-constrained devices) */
  release?: boolean;
  /**
   * Hand the audio's buffer to the worker instead of copying it (saves a copy of the whole recording,
   * 3.8 MB per minute). The caller's array is detached afterwards.
   */
  transfer?: boolean;
}

const abortError = () => new DOMException('Piano transcription cancelled', 'AbortError');

interface Warm {
  worker: Worker;
  threads: number;
  timer: ReturnType<typeof setTimeout>;
}
/** at most one finished worker kept warm for the next call */
let warm: Warm | null = null;
let nextJob = 1;

function takeWorker(threads: number): Worker {
  if (warm && warm.threads === threads) {
    clearTimeout(warm.timer);
    const w = warm.worker;
    warm = null;
    return w;
  }
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'piano-specialist' });
}

function parkWorker(worker: Worker, threads: number): void {
  if (warm) {
    worker.terminate();
    return;
  }
  const timer = setTimeout(() => {
    if (warm?.worker === worker) warm = null;
    worker.terminate();
  }, IDLE_WORKER_MS);
  warm = { worker, threads, timer };
}

/** Terminate the idle worker now (frees its WASM memory). */
export function releasePianoSpecialist(): void {
  if (!warm) return;
  clearTimeout(warm.timer);
  warm.worker.terminate();
  warm = null;
}

/** number of 10 s model calls for `seconds` of audio */
export function specialistSegments(seconds: number): number {
  return planSegments(Math.round(seconds * PTI_SAMPLE_RATE)).starts.length;
}

/**
 * Run the piano model on mono 16 kHz audio. The array is copied (the caller keeps it) unless
 * `opts.transfer`. Progress is real
 * work: model download bytes and compile ('loading-model'), then 10 s segments ('analyzing').
 * Rejects with an AbortError when `signal` aborts (the worker is terminated at once).
 */
export function runPianoSpecialist(
  audio16k: Float32Array,
  onProgress?: (e: SpecialistProgress) => void,
  signal?: AbortSignal,
  opts: RunOptions = {},
): Promise<PianoSpecialistResult> {
  if (signal?.aborted) return Promise.reject(abortError());
  const t0 = performance.now();
  const threads = Math.max(1, opts.threads ?? wasmThreads(4));
  const release = opts.release ?? isMemoryConstrained(pageDeviceInfo() ?? { ua: '' });
  const base = typeof location === 'undefined' ? 'http://localhost/' : location.href;
  const v = `?v=${PIANO_SPECIALIST_MODEL_SHA256.slice(0, 8)}`;
  const modelUrl = new URL(opts.modelUrl ?? `${import.meta.env.BASE_URL}${PIANO_SPECIALIST_MODEL_PATH}${v}`, base).href;
  const modelParts = opts.modelUrl ? undefined : pianoSpecialistPartPaths().map((p) => new URL(`${import.meta.env.BASE_URL}${p}${v}`, base).href);
  const jobId = nextJob++;
  // a whole-buffer array can be handed over as it is; a view into a bigger buffer is copied
  const whole = audio16k.byteOffset === 0 && audio16k.byteLength === audio16k.buffer.byteLength;
  const audio = opts.transfer && whole ? audio16k : audio16k.slice();
  return new Promise<PianoSpecialistResult>((resolve, reject) => {
    const worker = takeWorker(threads);
    let settled = false;
    const finish = (keep: boolean) => {
      settled = true;
      worker.onmessage = null;
      worker.onerror = null;
      signal?.removeEventListener('abort', onAbort);
      if (keep && !release) parkWorker(worker, threads);
      else worker.terminate();
    };
    const onAbort = () => {
      if (settled) return;
      finish(false);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const m = e.data;
      if (settled || m.jobId !== jobId) return;
      if (m.type === 'progress') {
        const { stage, progress, loaded, total, done, segments } = m;
        onProgress?.({ stage, progress, loaded, total, done, segments });
      } else if (m.type === 'error') {
        finish(false);
        reject(new Error(m.message));
      } else {
        finish(true);
        resolve({
          nFrames: m.nFrames,
          fps: m.fps,
          frame: m.frame,
          onset: m.onset,
          offset: m.offset,
          velocity: m.velocity,
          ms: performance.now() - t0,
          threads: m.threads,
          stats: m.stats,
        });
      }
    };
    worker.onerror = (e) => {
      if (settled) return;
      finish(false);
      reject(new Error(`The piano model worker failed${e.message ? `: ${e.message}` : ''}.`));
    };
    const req: RunRequest = {
      type: 'run',
      jobId,
      audio16k: audio,
      threads,
      modelUrl,
      modelParts,
      modelSha256: PIANO_SPECIALIST_MODEL_SHA256,
      modelBytes: PIANO_SPECIALIST_MODEL_BYTES,
      release,
    };
    worker.postMessage(req, [audio.buffer]);
  });
}
