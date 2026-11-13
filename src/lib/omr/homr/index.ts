/**
 * The homr sheet-music reader: PDF pages and photos of printed music → MusicXML, which then goes through
 * the normal score import (src/lib/score importMusicXml → songFromScore).
 *
 * A TypeScript / onnxruntime-web port of homr 0.7.1 by Christian Liebhardt and the homr contributors
 * (https://github.com/liebharc/homr, AGPL-3.0; the models are AGPL-3.0 too, and were partly trained on
 * data that may only be used non-commercially, see public/models/homr/README.md). Pipeline (worker.ts →
 * pipeline.ts): segmentation network → staff lines, noteheads, stems, bar lines, clefs (TypeScript ports
 * of homr's image analysis) → per staff a transformer (encoder + decoder) → homr's MusicXML writer.
 * Title detection (homr's OCR) is not included.
 *
 * Same calling convention as the Sheet Music Transformer reader (src/lib/omr/index.ts on its branch):
 * pages in, MusicXML + plain-language warnings out, progress by stage ('loading-model', 'finding-lines',
 * 'reading'), an AbortSignal, and the worker kept warm between jobs on desktops.
 */
import { isMemoryConstrained, isPhoneOrTablet, pageDeviceInfo, type DeviceInfo } from '../../transcription/backendChoice';
import { wasmThreads } from '../../isolation';
import { HOMR_MODELS } from './manifest';
import { fitSize, MAX_INPUT_SIDE, shrinkPixels } from './page';
import { READER_STOPPED_MESSAGE } from './protocol';
import type { HomrModelSpec, HomrPageResult, ModelFile, PageInput, Quad, RunStats, Stage, WorkerRequest, WorkerResponse } from './protocol';

export type { HomrModelSpec, HomrPageResult, Quad, RunStats, Stage } from './protocol';
export { MAX_INPUT_SIDE } from './page';

/** An 8-bit gray image (the SMT reader's Gray: w, h, d). */
export interface GrayImage {
  w: number;
  h: number;
  d: Uint8Array;
}

export type PageSource = ImageBitmap | ImageData | GrayImage | HTMLCanvasElement | OffscreenCanvas;

/** One page to read; for photos optionally the page corners (in the source's pixels) from the corner screen. */
export interface HomrPage {
  image: PageSource;
  quad?: Quad | null;
}

/**
 * Progress, in the Sheet Music Transformer reader's terms (src/lib/omr/index.ts ReadProgress on its
 * branch), so its import screen can show either reader: `progress` is 0–0.15 while loading the models
 * and 0.2–1 while reading the pages; `total` 0 means the models come from the cache (nothing to
 * download). One difference: homr reads page by page, so `line`/`lines` count the staffs of the
 * current page (a piano system has two), the same as `pageLine`/`pageLines`.
 */
export interface ReadProgress {
  stage: Stage;
  /** 0..1 over the whole job, never going back */
  progress: number;
  /** loading-model: bytes downloaded / bytes to download (total 0: all from the cache) */
  loaded?: number;
  total?: number;
  /** the page being read (0-based, as the SMT reader) / pages */
  page?: number;
  pages?: number;
  /** reading: the staff being read on this page (1-based) / staffs on it */
  line?: number;
  lines?: number;
  pageLine?: number;
  pageLines?: number;
}

export interface ReadOptions {
  onProgress?: (p: ReadProgress) => void;
  signal?: AbortSignal;
  /** title written into the MusicXML */
  title?: string;
  /** WASM threads (default wasmThreads(4)) */
  threads?: number;
  /** release the models and end the worker afterwards (default: on phones / small-memory devices) */
  release?: boolean;
  /**
   * low-memory mode: one network at a time, one window per segmentation run (default: on phones /
   * small-memory devices, and whenever `release` is asked for, e.g. the import screen's retry after a crash)
   */
  lowMemory?: boolean;
  /** model files to use instead of the shipped ones (test harnesses) */
  model?: HomrModelSpec;
}

export interface ReadResult {
  musicXml: string;
  /** plain-language notes for the user */
  warnings: string[];
  pages: number;
  /** staffs found on all pages (a grand staff counts as two) */
  staves: number;
  /** systems (lines of music) read */
  lines: number;
  pageInfo: HomrPageResult[];
  stats: RunStats & { ms: number };
}

/** Thrown with a message meant for the user (nothing found, unsupported browser). */
export class SheetReadError extends Error {}

export const ENGINE_ID = 'homr';
/** Most pages read in one go. */
export const MAX_PAGES = 20;
/** Most pages in one go on a phone or tablet (2–4.5 minutes each there). */
export const MAX_PAGES_PHONE = 5;
/**
 * Extra browser memory while reading, MB (desktops: all three networks loaded). Measured in headless
 * Chromium (whole-browser PSS, public/models/homr/README.md): +0.93–1.08 GB on the first page, up to
 * +1.36 GB on a synthetic photo; less since the float16 weights are expanded before session creation.
 */
export const HOMR_EXTRA_MB = 1400;
/** The same in low-memory mode (phones: one network at a time, one thread). */
export const HOMR_EXTRA_MB_LOW = 700;
/**
 * Seconds per page of 3–4 systems by WASM threads (index = threads), headless Chromium on a shared
 * 4-core machine: 1 thread 48–80 s, 3 threads 32–59 s for pages of 2–5 systems.
 */
const SECONDS_PER_PAGE = [65, 65, 55, 45, 40];
/** Phones are assumed ~3x slower than one desktop thread. */
export const PHONE_SLOWDOWN = 3;
/** How long an idle worker keeps its loaded models (desktops). */
export const IDLE_WORKER_MS = 60_000;

export function estimateSecondsPerPage(threads: number, phone = false): number {
  if (phone) return SECONDS_PER_PAGE[1] * PHONE_SLOWDOWN;
  return SECONDS_PER_PAGE[Math.max(1, Math.min(SECONDS_PER_PAGE.length - 1, Math.round(threads)))];
}

/** Download size of the models, bytes. */
export function homrDownloadBytes(): number {
  return HOMR_MODELS.segnet.bytes + HOMR_MODELS.encoder.bytes + HOMR_MODELS.decoder.bytes;
}

/** Absolute URLs (with ?v=<sha256 prefix> so a new model never meets an old HTTP cache entry). */
export function homrModelSpec(base: string): HomrModelSpec {
  const file = (f: { file: string; bytes: number; sha256: string; parts: readonly string[] }): ModelFile => {
    const v = `?v=${f.sha256.slice(0, 8)}`;
    return { url: new URL(`models/homr/${f.file}${v}`, base).href, parts: f.parts.map((p) => new URL(`${p}${v}`, base).href), sha256: f.sha256, bytes: f.bytes };
  };
  return { name: 'homr-0.7.1', segnet: file(HOMR_MODELS.segnet), encoder: file(HOMR_MODELS.encoder), decoder: file(HOMR_MODELS.decoder) };
}

export interface ReaderSupport {
  available: boolean;
  recommended: boolean;
  reason?: string;
  downloadMB: number;
  memoryMB: number;
  estSecondsPerPage: number;
  threads: number;
  phone: boolean;
  /** most pages per job here */
  maxPages: number;
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

/** Can the homr reader run here, and is it a good idea? */
export function homrReaderSupport(deviceIn?: DeviceInfo | string, threadsIn?: number, env: { worker?: boolean; simd?: boolean } = {}): ReaderSupport {
  // also callable like the SMT reader's sheetReaderSupport(kind): a kind string is ignored here
  const device = typeof deviceIn === 'object' ? deviceIn : pageDeviceInfo();
  const phone = device ? isPhoneOrTablet(device) : false;
  const constrained = device ? isMemoryConstrained(device) : false;
  const threads = constrained ? 1 : (threadsIn ?? wasmThreads(4));
  const base = {
    downloadMB: Math.round(homrDownloadBytes() / 1e6),
    memoryMB: constrained ? HOMR_EXTRA_MB_LOW : HOMR_EXTRA_MB,
    estSecondsPerPage: estimateSecondsPerPage(threads, phone),
    threads,
    phone,
    maxPages: phone ? MAX_PAGES_PHONE : MAX_PAGES,
  };
  if (!(env.worker ?? typeof Worker !== 'undefined')) return { ...base, available: false, recommended: false, reason: 'This browser cannot run the sheet-music reader (no Web Worker support).' };
  if (!(env.simd ?? hasSimd())) return { ...base, available: false, recommended: false, reason: 'This browser is too old for the sheet-music reader (it needs WebAssembly SIMD).' };
  if (constrained) {
    return {
      ...base,
      available: true,
      recommended: false,
      reason: phone
        ? `Reading sheet music on a phone is slow (about ${Math.round(base.estSecondsPerPage / 60)} minutes per page, at most ${MAX_PAGES_PHONE} pages at a time) and needs about ${base.memoryMB} MB of memory. Close other apps and tabs first; a computer is much faster.`
        : `This device reports little memory; reading sheet music needs about ${base.memoryMB} MB.`,
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
  // a warm worker with another thread count (e.g. the one-thread retry after a crash) is ended: two
  // workers would hold the models twice
  releaseHomrReader();
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'homr-reader' });
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
export function releaseHomrReader(): void {
  if (!warm) return;
  clearTimeout(warm.timer);
  warm.worker.terminate();
  warm = null;
}

const abortError = () => new DOMException('Sheet-music reading cancelled', 'AbortError');

function baseUrl(): string {
  const origin = typeof location === 'undefined' ? 'http://localhost/' : location.href;
  return new URL(import.meta.env.BASE_URL ?? '/', origin).href;
}

/**
 * The page's pixels for the worker (RGBA from images and canvases, gray as is), scaled down to fit in
 * MAX_INPUT_SIDE, and the factor they were scaled by (for the page corners). Always a copy: the
 * caller keeps its image (the corner screen may still show it).
 */
export function pagePixels(src: PageSource): Omit<PageInput, 'quad'> & { scale: number } {
  if ('d' in src && 'w' in src) {
    const s = shrinkPixels(src.d, src.w, src.h, 1);
    return { w: s.w, h: s.h, channels: 1, data: s.data === src.d ? src.d.slice() : s.data, scale: s.w / src.w };
  }
  if (typeof ImageData !== 'undefined' && src instanceof ImageData) {
    const s = shrinkPixels(src.data, src.width, src.height, 4);
    return { w: s.w, h: s.h, channels: 4, data: s.w === src.width ? s.data.slice() : s.data, scale: s.w / src.width };
  }
  const s = src as ImageBitmap | HTMLCanvasElement | OffscreenCanvas;
  // drawn at the reduced size (a full-size canvas of a 48 MP photo would be 192 MB, and over iOS Safari's canvas limit)
  const { w, h } = fitSize(s.width, s.height, MAX_INPUT_SIDE);
  const canvas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) throw new SheetReadError('This browser cannot read images.');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(s, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h);
  return { w, h, channels: 4, data: new Uint8Array(d.data.buffer), scale: w / s.width };
}

const scaleQuad = (q: Quad | null | undefined, s: number): Quad | null => (q ? (s === 1 ? q : (q.map(([x, y]) => [x * s, y * s]) as Quad)) : null);

/**
 * The error the user sees for a failed worker job: the worker's own plain messages (download failed,
 * corrupted files) as they are; technical ones (onnxruntime, WASM out of memory) become one plain
 * sentence, and their raw text goes to the console (as the SMT reader's workerError).
 */
export function workerError(message: string, plain: boolean): SheetReadError {
  if (plain && message) return new SheetReadError(message);
  console.warn('[homr reader]', message);
  return new SheetReadError(READER_STOPPED_MESSAGE);
}

/** one job at a time: a second call waits (two workers would hold the models twice) */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Reads printed music from page images with homr. Rejects with an AbortError when `signal` aborts (the
 * worker is ended at once) and with a SheetReadError (message for the user) when nothing could be read.
 */
export async function readSheetImages(pages: HomrPage[], opts: ReadOptions = {}): Promise<ReadResult> {
  const device = pageDeviceInfo() ?? { ua: '' };
  const max = isPhoneOrTablet(device) ? MAX_PAGES_PHONE : MAX_PAGES;
  if (!pages.length) throw new SheetReadError('No pages to read.');
  if (pages.length > max) throw new SheetReadError(`Please choose at most ${max} pages at a time${max < MAX_PAGES ? ' on a phone or tablet' : ''}.`);
  if (opts.signal?.aborted) throw abortError();
  const prev = queue;
  let done!: () => void;
  queue = new Promise<void>((r) => (done = r));
  try {
    await prev;
    if (opts.signal?.aborted) throw abortError();
    return await readNow(pages, opts, isMemoryConstrained(device));
  } finally {
    done();
  }
}

async function readNow(pages: HomrPage[], opts: ReadOptions, constrained: boolean): Promise<ReadResult> {
  const t0 = performance.now();
  const threads = Math.max(1, opts.threads ?? (constrained ? 1 : wasmThreads(4)));
  const release = opts.release ?? constrained;
  const lowMemory = opts.lowMemory ?? (constrained || release);
  const model = opts.model ?? homrModelSpec(baseUrl());
  const jobId = nextJob++;
  const n = pages.length;
  const r = await new Promise<{ musicXml: string; pages: HomrPageResult[]; stats: RunStats }>((resolve, reject) => {
    const worker = takeWorker(threads);
    let settled = false;
    let shown = 0;
    const show = (p: ReadProgress) => {
      shown = Math.max(shown, p.progress);
      opts.onProgress?.({ ...p, progress: shown });
    };
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
    // overall progress (as the SMT reader): models 0–0.15, then the pages in equal shares of 0.2–1
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const m = e.data;
      if (settled || m.jobId !== jobId) return;
      if (m.type === 'need-page') {
        let px: ReturnType<typeof pagePixels>;
        try {
          px = pagePixels(pages[m.index].image);
        } catch (err) {
          finish(false);
          reject(err instanceof SheetReadError ? err : new SheetReadError('This image could not be read.'));
          return;
        }
        const { scale, ...pix } = px;
        const msg: WorkerRequest = { type: 'page', jobId, index: m.index, page: { ...pix, quad: scaleQuad(pages[m.index].quad, scale) } };
        worker.postMessage(msg, [pix.data.buffer]);
      } else if (m.type === 'progress') {
        if (m.stage === 'loading-model') {
          show({ stage: m.stage, progress: 0.15 * m.progress, loaded: m.loaded ?? 0, total: m.total ?? 0 });
        } else {
          const page = m.page ?? 0;
          // per page: finding the lines ~30 %, reading the staffs ~70 %
          const within = m.stage === 'finding-lines' ? 0.3 * m.progress : 0.3 + 0.7 * m.progress;
          show({ stage: m.stage, progress: 0.2 + 0.8 * ((page + within) / n), page, pages: n, line: m.line, lines: m.lines, pageLine: m.line, pageLines: m.lines });
        }
      } else if (m.type === 'error') {
        finish(false);
        reject(workerError(m.message, !!m.plain));
      } else if (m.type === 'result') {
        finish(true);
        resolve({ musicXml: m.musicXml, pages: m.pages, stats: m.stats });
      }
    };
    worker.onerror = (e) => {
      if (settled) return;
      finish(false);
      reject(workerError(e.message || 'worker error', false));
    };
    const req: WorkerRequest = { type: 'run', jobId, pageCount: n, model, threads, release, lowMemory, title: opts.title };
    worker.postMessage(req);
  });
  return assemble(r, n, performance.now() - t0);
}

/** Worker output → result and warnings (exported for tests). */
export function assemble(r: { musicXml: string; pages: HomrPageResult[]; stats: RunStats }, nPages: number, ms = 0): ReadResult {
  const warnings: string[] = [];
  const empty = r.pages.map((p, i) => (p.error && p.errorKind !== 'too-tall' ? i + 1 : 0)).filter(Boolean);
  const tall = r.pages.map((p, i) => (p.errorKind === 'too-tall' ? i + 1 : 0)).filter(Boolean);
  const list = (a: number[]) => (a.length > 1 ? `pages ${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}` : `page ${a[0]}`);
  if (!r.musicXml || empty.length + tall.length === nPages) {
    if (tall.length === nPages)
      throw new SheetReadError(
        nPages === 1
          ? 'This image is much taller than a page of music. Crop it into pages (or a few lines of music each) and try again.'
          : 'These images are much taller than pages of music. Crop them into pages (or a few lines of music each) and try again.',
      );
    throw new SheetReadError(
      nPages === 1
        ? 'No music was found on this page. The reader needs printed sheet music (not handwriting), upright, with the whole page sharp and evenly lit.'
        : 'No music was found on these pages. The reader needs printed sheet music (not handwriting), upright, with each page sharp and evenly lit.',
    );
  }
  if (empty.length) warnings.push(`No music was found on ${list(empty)}.`);
  if (tall.length) warnings.push(`${list(tall)[0].toUpperCase()}${list(tall).slice(1)} ${tall.length > 1 ? 'were' : 'was'} skipped: much taller than a page of music. Crop ${tall.length > 1 ? 'them' : 'it'} into pages to read ${tall.length > 1 ? 'them' : 'it'}.`);
  const turned = r.pages.map((p, i) => (p.rotated ? i + 1 : 0)).filter(Boolean);
  if (turned.length) warnings.push(`${list(turned)[0].toUpperCase()}${list(turned).slice(1)} ${turned.length > 1 ? 'were' : 'was'} sideways and ${turned.length > 1 ? 'were' : 'was'} read turned upright.`);
  if (r.stats.notStored) warnings.push('The sheet-music reader could not be saved in this browser (private browsing or not enough storage), so it will be downloaded again next time.');
  if (!/<pitch>/.test(r.musicXml)) throw new SheetReadError('No notes could be read. The reader works best on clear printed music.');
  const staves = r.pages.reduce((a, p) => a + p.staves, 0);
  const lines = r.pages.reduce((a, p) => a + p.systems, 0);
  return { musicXml: r.musicXml, warnings, pages: nPages, staves, lines, pageInfo: r.pages, stats: { ...r.stats, ms } };
}

/**
 * The engine object the import screen can choose (same shape as the Sheet Music Transformer reader's):
 * `readPages(images, { onProgress, signal })` → `{ musicXml, warnings, pages, staves }`.
 */
export const homrEngine = {
  id: ENGINE_ID,
  label: 'Accurate (homr)',
  /** support(kind?, device?, threads?): the same arguments as the SMT reader's sheetReaderSupport */
  support: (_kind?: 'pdf' | 'photo', device?: DeviceInfo, threads?: number) => homrReaderSupport(device, threads),
  downloadBytes: homrDownloadBytes,
  readPages(images: (PageSource | HomrPage)[], opts: ReadOptions = {}): Promise<ReadResult> {
    const pages = images.map((p) => (typeof p === 'object' && p !== null && 'image' in p ? (p as HomrPage) : { image: p as PageSource }));
    return readSheetImages(pages, opts);
  },
  release: releaseHomrReader,
};
