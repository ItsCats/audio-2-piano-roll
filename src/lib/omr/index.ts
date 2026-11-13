/**
 * The Quick sheet-music reader (Beta): PDF pages and photos of printed piano music → MusicXML, which
 * then goes through the normal score import (src/lib/score importMusicXml → songFromScore).
 *
 * Pipeline: page images (pdf.ts renders PDF pages; photos are decoded by loadPhoto) → worker.ts
 * (straighten and clean the page, find the piano systems, read each with the Sheet Music Transformer
 * on onnxruntime-web) → **kern per system → kern.ts (measures on one time line) → musicxml.ts.
 *
 * The recognition model is behind ModelSpec (models.ts) and the worker protocol: a better reader can
 * replace it by shipping new files that take a system image and produce **kern (or by replacing the
 * worker with one that returns the same SystemResult list).
 *
 * One model is shipped for both PDFs and photos, downloaded on first use: the Sheet Music Transformer
 * fine-tuned on Camera-GrandStaff, with 8-bit weights (23 MB). Measured in this pipeline it read clean
 * pages as well as (synthetic pages: better than) the GrandStaff checkpoint made for clean pages, and
 * photos better, so the second model is not shipped; MODEL_FOR keeps the choice per kind of input.
 * public/models/omr/README.md has the measurements.
 */
import { isMemoryConstrained, isPhoneOrTablet, pageDeviceInfo, type DeviceInfo } from '../transcription/backendChoice';
import { wasmThreads } from '../isolation';
import { grayFromRGBA, resize, type Gray, type Quad } from './image';
import { detectPageQuad } from './page';
import { parseKernSystems, soundingNotes, type KernPiece } from './kern';
import { kernToMusicXml } from './musicxml';
import { modelBytes, modelSpec } from './models';
import { READER_STOPPED_MESSAGE } from './protocol';
import type { ModelSpec, PageResult, RunRequest, RunStats, Stage, SystemResult, WorkerResponse } from './protocol';
import { watchWorker } from '../newVersion';

export type { Gray, Quad } from './image';
export { detectPageQuad, orderQuad } from './page';
export type { SystemResult, PageResult, RunStats, Stage } from './protocol';

export type SheetKind = 'pdf' | 'photo';

/** One page to read: a gray image and, for photos, the page corners in its pixels. */
export interface SheetPage {
  image: Gray;
  quad?: Quad | null;
}

export interface ReadProgress {
  stage: Stage;
  /** 0..1 over the whole job (download, finding the lines, reading them) */
  progress: number;
  /** loading-model: bytes downloaded / total (total 0: from the cache) */
  loaded?: number;
  total?: number;
  /** reading: lines of music done / total */
  line?: number;
  lines?: number;
  /** reading: the page being read (0-based) / pages, and the line being read on it (1-based) / its lines */
  page?: number;
  pages?: number;
  pageLine?: number;
  pageLines?: number;
}

export interface ReadOptions {
  kind: SheetKind;
  onProgress?: (p: ReadProgress) => void;
  signal?: AbortSignal;
  /** title written into the MusicXML */
  title?: string;
  /** WASM threads (default wasmThreads(4)) */
  threads?: number;
  /** release the model and end the worker afterwards (default: on phones / small-memory devices) */
  release?: boolean;
  /** model files to use instead of the shipped ones (test harnesses) */
  model?: ModelSpec;
  /** look for the page outline when a page has no corners (default: for photos) */
  findPage?: boolean;
}

export interface ReadResult {
  musicXml: string;
  /** plain-language notes for the user */
  warnings: string[];
  pages: number;
  /** lines of music (piano systems) read */
  lines: number;
  /** per page: staves and lines found, straightened size, corners used */
  pageInfo: PageResult[];
  /** the recognised piece (measures, notes) */
  piece: KernPiece;
  /** per line of music: the model's **kern */
  systems: SystemResult[];
  stats: RunStats & { ms: number };
}

/** Thrown with a message meant for the user (nothing found, unsupported browser). */
export class SheetReadError extends Error {}

/** Model per kind of input (one model serves both today). */
export const MODEL_FOR: Record<SheetKind, string> = { pdf: 'smt-camera-grandstaff', photo: 'smt-camera-grandstaff' };

/**
 * Extra browser memory while reading, MB. Measured (2026-11-13, headless Chromium, RSS of the whole
 * browser, a dense real page of five systems): +550 MB peak with 1 WASM thread, +940 MB with 3 (each
 * thread has its own scratch memory); about +370–470 MB stays while the model is kept loaded, and goes
 * when the worker ends (always right after the job on phones).
 */
export const OMR_EXTRA_MB = 800;
/**
 * Measured seconds per page of real printed piano music (four to five systems, ~1400 model steps) by
 * WASM threads (index = threads), headless Chromium on a shared 4-core x86 box with other jobs
 * running: 31–36 s with 1 thread, 18–28 s with 3 (the token-by-token decoder gains little from
 * threads). A short page of two systems takes a quarter of that.
 */
const SECONDS_PER_PAGE = [35, 35, 30, 25, 23];
/** How long an idle worker keeps its loaded model (desktops). */
export const IDLE_WORKER_MS = 60_000;
/** Most pages read in one go. */
export const MAX_PAGES = 20;

export interface SheetReaderSupport {
  available: boolean;
  /** fine to use here (false on phones / small-memory devices: slow, may run out of memory) */
  recommended: boolean;
  /** plain-language reason when unavailable or not recommended */
  reason?: string;
  /** download on first use, MB (then cached) */
  downloadMB: number;
  memoryMB: number;
  /** expected seconds per page here */
  estSecondsPerPage: number;
  threads: number;
  phone: boolean;
}

// a tiny module using a v128 instruction: onnxruntime-web 1.31 ships SIMD builds only
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
function hasSimd(): boolean {
  try {
    return typeof WebAssembly === 'object' && WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

/** Phones run one thread (no cross-origin isolation on iOS Safari) and are assumed 1.5x slower than one desktop thread (not measured on a phone yet). */
export const PHONE_SLOWDOWN = 1.5;
export function estimateSecondsPerPage(threads: number, phone = false): number {
  const base = SECONDS_PER_PAGE[Math.max(1, Math.min(SECONDS_PER_PAGE.length - 1, Math.round(threads)))];
  return phone ? SECONDS_PER_PAGE[1] * PHONE_SLOWDOWN : base;
}

/** Can the sheet-music reader run here, and is it a good idea? */
export function sheetReaderSupport(
  kind: SheetKind = 'pdf',
  device: DeviceInfo | undefined = pageDeviceInfo(),
  threads: number = wasmThreads(4),
  env: { worker?: boolean; simd?: boolean } = {},
): SheetReaderSupport {
  const phone = device ? isPhoneOrTablet(device) : false;
  const constrained = device ? isMemoryConstrained(device) : false;
  const base = {
    downloadMB: Math.round(modelBytes(MODEL_FOR[kind]) / 1e6),
    memoryMB: OMR_EXTRA_MB,
    estSecondsPerPage: estimateSecondsPerPage(threads, phone),
    threads,
    phone,
  };
  if (!(env.worker ?? typeof Worker !== 'undefined')) return { ...base, available: false, recommended: false, reason: 'This browser cannot run the sheet-music reader (no Web Worker support).' };
  if (!(env.simd ?? hasSimd())) return { ...base, available: false, recommended: false, reason: 'This browser is too old for the sheet-music reader (it needs WebAssembly SIMD).' };
  if (constrained) {
    return {
      ...base,
      available: true,
      recommended: false,
      reason: phone
        ? `Reading sheet music on a phone is slow (about ${Math.round(base.estSecondsPerPage / 10) * 10} seconds per page) and needs about ${OMR_EXTRA_MB} MB of memory. Close other apps and tabs first; a computer is faster.`
        : `This device reports little memory; reading sheet music needs about ${OMR_EXTRA_MB} MB.`,
    };
  }
  return { ...base, available: true, recommended: true };
}

// ------------------------------------------------------------------ worker

interface Warm {
  worker: Worker;
  threads: number;
  timer: ReturnType<typeof setTimeout>;
}
let warm: Warm | null = null;
let nextJob = 1;

function takeWorker(threads: number): Worker {
  if (warm && warm.threads === threads) {
    clearTimeout(warm.timer);
    const w = warm.worker;
    warm = null;
    return w;
  }
  return watchWorker(new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'sheet-reader' }));
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

/** End the idle worker now (frees its memory). */
export function releaseSheetReader(): void {
  if (!warm) return;
  clearTimeout(warm.timer);
  warm.worker.terminate();
  warm = null;
}

const abortError = () => new DOMException('Sheet-music reading canceled', 'AbortError');

function baseUrl(): string {
  const origin = typeof location === 'undefined' ? 'http://localhost/' : location.href;
  return new URL(import.meta.env.BASE_URL ?? '/', origin).href;
}

/** Runs the worker on the pages; resolves with its per-system **kern. */
function runWorker(pages: SheetPage[], opts: ReadOptions): Promise<{ systems: SystemResult[]; pages: PageResult[]; stats: RunStats }> {
  if (opts.signal?.aborted) return Promise.reject(abortError());
  const threads = Math.max(1, opts.threads ?? wasmThreads(4));
  const release = opts.release ?? isMemoryConstrained(pageDeviceInfo() ?? { ua: '' });
  const model = opts.model ?? modelSpec(MODEL_FOR[opts.kind], baseUrl());
  if (!model) return Promise.reject(new SheetReadError('The sheet-music reader is not available in this version of the app.'));
  const jobId = nextJob++;
  // copies: the caller keeps its images (the corner screen may still show them)
  const input = pages.map((p) => ({ w: p.image.w, h: p.image.h, data: p.image.d.slice(), quad: p.quad ?? null }));
  return new Promise((resolve, reject) => {
    const worker = takeWorker(threads);
    let settled = false;
    const finish = (keep: boolean) => {
      settled = true;
      worker.onmessage = null;
      worker.onerror = null;
      opts.signal?.removeEventListener('abort', onAbort);
      if (keep && !release) parkWorker(worker, threads);
      else worker.terminate();
    };
    const onAbort = () => {
      if (settled) return;
      finish(false);
      reject(abortError());
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    // overall progress: download 0–0.15 (when there is one), finding lines up to 0.2, reading the rest
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const m = e.data;
      if (settled || m.jobId !== jobId) return;
      if (m.type === 'progress') {
        const at = m.stage === 'loading-model' ? 0.15 * m.progress : m.stage === 'finding-lines' ? 0.15 + 0.05 * m.progress : 0.2 + 0.8 * m.progress;
        opts.onProgress?.({ stage: m.stage, progress: at, loaded: m.loaded, total: m.total, line: m.line, lines: m.lines, page: m.page, pages: m.pages, pageLine: m.pageLine, pageLines: m.pageLines });
      } else if (m.type === 'error') {
        finish(false);
        reject(workerError(m.message, !!m.plain));
      } else {
        finish(true);
        resolve({ systems: m.systems, pages: m.pages, stats: m.stats });
      }
    };
    worker.onerror = (e) => {
      if (settled) return;
      finish(false);
      reject(workerError(e.message || 'worker error', false));
    };
    const req: RunRequest = { type: 'run', jobId, kind: opts.kind, pages: input, model, threads, release, findPage: opts.findPage ?? opts.kind === 'photo' };
    worker.postMessage(
      req,
      input.map((p) => p.data.buffer),
    );
  });
}

/**
 * The error the user sees for a failed worker job: the worker's own plain messages (download failed,
 * corrupted files) as they are; technical ones (onnxruntime, WASM out of memory, "no available
 * backend") become one plain sentence, and their raw text goes to the console.
 */
export function workerError(message: string, plain: boolean): SheetReadError {
  if (plain && message) return new SheetReadError(message);
  console.warn('[sheet reader]', message);
  return new SheetReadError(READER_STOPPED_MESSAGE);
}

/**
 * Reads printed piano music from page images. Rejects with an AbortError when `signal` aborts (the
 * worker is ended at once) and with a SheetReadError (message for the user) when nothing could be read.
 */
export async function readSheetImages(pages: SheetPage[], opts: ReadOptions): Promise<ReadResult> {
  if (!pages.length) throw new SheetReadError('No pages to read.');
  if (pages.length > MAX_PAGES) throw new SheetReadError(`Please choose at most ${MAX_PAGES} pages at a time.`);
  const t0 = performance.now();
  const r = await runWorker(pages, opts);
  return assemble(r, pages.length, opts, performance.now() - t0);
}

/** Worker output → the piece, MusicXML and warnings (exported for tests). */
export function assemble(r: { systems: SystemResult[]; pages: PageResult[]; stats: RunStats }, nPages: number, opts: Pick<ReadOptions, 'title' | 'kind'>, ms = 0): ReadResult {
  const warnings: string[] = [];
  const emptyPages = r.pages.map((p, i) => (p.systems === 0 ? i + 1 : 0)).filter(Boolean);
  if (!r.systems.length) {
    throw new SheetReadError(
      opts.kind === 'photo'
        ? 'No music lines were found in this photo. Make sure the whole page is in the picture, sharp and evenly lit, and adjust the corners to the page.'
        : 'No music lines were found in this PDF. The reader needs printed sheet music (not handwriting or a scan of very low quality).',
    );
  }
  if (emptyPages.length) warnings.push(`No music lines were found on page ${emptyPages.join(', ')}.`);
  const single = r.pages.reduce((a, p) => a + (p.staves === 1 ? 1 : 0), 0);
  if (single) warnings.push('Some lines have only one staff. The reader is made for piano music (two staves); other music may come out wrong.');
  const cut = r.systems.filter((s) => !s.finished).length;
  if (cut) warnings.push(`${cut === 1 ? 'One line' : `${cut} lines`} could not be read to the end; some notes may be missing there.`);
  const piece = parseKernSystems(r.systems.map((s) => s.kern));
  if (!soundingNotes(piece).length) throw new SheetReadError('No notes could be read. The reader works best on clear printed piano music.');
  // an over-full bar is lengthened so no note is lost; the notes after it then come later than on the
  // page (the piano roll's bar lines stop matching the printed bars). One is common; say so from two.
  if (piece.overfullBars >= Math.max(2, 0.15 * piece.measures.length))
    warnings.push(`${piece.overfullBars} bars had more beats than the time signature (often a note read twice), so they were made longer and the notes after them come a little later than on your page. Check the rhythm.`);
  if (piece.keyMismatchSystems > 0)
    warnings.push('The key signature (sharps and flats at the start of each line) was not read the same on every line. The most common one was used; check the sharps and flats.');
  const musicXml = kernToMusicXml(piece, { title: opts.title });
  return { musicXml, warnings, pages: nPages, lines: r.systems.length, pageInfo: r.pages, piece, systems: r.systems, stats: { ...r.stats, ms } };
}

// ------------------------------------------------------------------ images

/** Longest side a photo is decoded at (phone photos are 4000+ px; the page is straightened to 1654 px). */
export const PHOTO_MAX_SIDE = 3000;

/** RGBA pixels → gray (canvas ImageData). */
export function grayFromImageData(img: { data: Uint8ClampedArray; width: number; height: number }): Gray {
  return grayFromRGBA(img.data, img.width, img.height);
}

function drawToGray(src: CanvasImageSource, w: number, h: number, outW: number, outH: number): Gray {
  const canvas: OffscreenCanvas | HTMLCanvasElement =
    typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(outW, outH) : Object.assign(document.createElement('canvas'), { width: outW, height: outH });
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) throw new SheetReadError('This browser cannot read images.');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, outW, outH);
  ctx.drawImage(src, 0, 0, w, h, 0, 0, outW, outH);
  const data = ctx.getImageData(0, 0, outW, outH);
  return grayFromImageData(data);
}

export interface LoadedPhoto {
  /** decoded gray image (longest side ≤ PHOTO_MAX_SIDE), the coordinates corners refer to */
  image: Gray;
  /** suggested page corners (null: none found; use the whole image) */
  quad: Quad | null;
}

/** Size to decode a w × h picture at so its longest side is at most maxSide. */
export function fitSize(w: number, h: number, maxSide: number): { w: number; h: number } {
  const s = Math.min(1, maxSide / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** Upright size of a picture without decoding all its pixels (<img> reads the header; EXIF applied). */
export async function pictureSize(file: Blob): Promise<{ w: number; h: number } | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    const ok = await new Promise<boolean>((res) => {
      img.onload = () => res(true);
      img.onerror = () => res(false);
      img.src = url;
    });
    return ok && img.naturalWidth > 0 ? { w: img.naturalWidth, h: img.naturalHeight } : null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Decodes a photo (JPEG / PNG / WebP / HEIC where the browser can), upright per its EXIF, as gray.
 * Very large photos (48 MP phone pictures are 8000 × 6000) are decoded straight at the reading size, so
 * the full-size picture (~190 MB of pixels) is never held; browsers without createImageBitmap's resize
 * options fall back to a full decode.
 */
export async function loadPhoto(file: Blob, maxSide = PHOTO_MAX_SIDE): Promise<LoadedPhoto> {
  const size = await pictureSize(file).catch(() => null);
  let bmp: ImageBitmap | null = null;
  // only very large pictures take the resize path: up to twice the reading size (12 MP phone photos)
  // the full decode is affordable and reads the same as it was measured
  if (size && Math.max(size.w, size.h) > 2 * maxSide) {
    const fit = fitSize(size.w, size.h, maxSide);
    try {
      bmp = await createImageBitmap(file, { imageOrientation: 'from-image', resizeWidth: fit.w, resizeHeight: fit.h, resizeQuality: 'high' });
      // a browser that ignored the resize options or the orientation: decode again the plain way
      if (Math.abs(bmp.width / bmp.height - fit.w / fit.h) > 0.02) {
        bmp.close();
        bmp = null;
      }
    } catch {
      bmp = null;
    }
  }
  if (!bmp) {
    try {
      bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      throw new SheetReadError('This image could not be opened. Please use a JPEG or PNG photo.');
    }
  }
  try {
    const fit = fitSize(bmp.width, bmp.height, maxSide);
    const image = drawToGray(bmp, bmp.width, bmp.height, fit.w, fit.h);
    return { image, quad: detectPageQuad(image) };
  } finally {
    bmp.close();
  }
}

/** A gray image scaled to fit `maxSide` (previews). */
export function shrink(img: Gray, maxSide: number): Gray {
  const s = maxSide / Math.max(img.w, img.h);
  return s >= 1 ? img : resize(img, img.w * s, img.h * s);
}

export { openPdf, pdfPageCount, renderPdfPages, type PdfDocument } from './pdf';
