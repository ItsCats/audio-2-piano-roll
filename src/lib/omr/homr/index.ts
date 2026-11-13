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
import type { HomrModelSpec, HomrPageResult, ModelFile, PageInput, Quad, RunStats, Stage, WorkerRequest, WorkerResponse } from './protocol';

export type { HomrModelSpec, HomrPageResult, Quad, RunStats, Stage } from './protocol';

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

export interface ReadProgress {
  stage: Stage;
  /** 0..1 over the whole job (download, then the pages) */
  progress: number;
  /** loading-model: bytes downloaded / total (total 0: from the cache) */
  loaded?: number;
  total?: number;
  /** the page being read (1-based) / pages */
  page?: number;
  pages?: number;
  /** reading: staffs of the page done / total */
  line?: number;
  lines?: number;
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
/** Extra tab memory while reading, MB (sessions + one page): measured, see public/models/homr/README.md. */
export const HOMR_EXTRA_MB = 700;
/** Measured seconds per page (about 4–8 staffs) by WASM threads (index = threads), desktop Chromium. */
const SECONDS_PER_PAGE = [90, 90, 55, 40, 35];
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
export function homrReaderSupport(device: DeviceInfo | undefined = pageDeviceInfo(), threads: number = wasmThreads(4), env: { worker?: boolean; simd?: boolean } = {}): ReaderSupport {
  const phone = device ? isPhoneOrTablet(device) : false;
  const constrained = device ? isMemoryConstrained(device) : false;
  const base = { downloadMB: Math.round(homrDownloadBytes() / 1e6), memoryMB: HOMR_EXTRA_MB, estSecondsPerPage: estimateSecondsPerPage(threads, phone), threads, phone };
  if (!(env.worker ?? typeof Worker !== 'undefined')) return { ...base, available: false, recommended: false, reason: 'This browser cannot run the sheet-music reader (no Web Worker support).' };
  if (!(env.simd ?? hasSimd())) return { ...base, available: false, recommended: false, reason: 'This browser is too old for the sheet-music reader (it needs WebAssembly SIMD).' };
  if (constrained) {
    return {
      ...base,
      available: true,
      recommended: false,
      reason: phone
        ? `Reading sheet music on a phone is slow (about ${Math.round(base.estSecondsPerPage / 60)} minutes per page) and needs about ${HOMR_EXTRA_MB} MB of memory. Close other apps and tabs first; a computer is faster.`
        : `This device reports little memory; reading sheet music needs about ${HOMR_EXTRA_MB} MB.`,
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

/** The page's pixels for the worker (RGBA from images and canvases, gray as is). */
export function pagePixels(src: PageSource): Omit<PageInput, 'quad'> {
  if ('d' in src && 'w' in src) return { w: src.w, h: src.h, channels: 1, data: src.d.slice() };
  if (typeof ImageData !== 'undefined' && src instanceof ImageData) return { w: src.width, h: src.height, channels: 4, data: new Uint8Array(src.data.buffer.slice(0)) };
  const s = src as ImageBitmap | HTMLCanvasElement | OffscreenCanvas;
  const w = s.width;
  const h = s.height;
  const canvas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) throw new SheetReadError('This browser cannot read images.');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(s, 0, 0);
  const d = ctx.getImageData(0, 0, w, h);
  return { w, h, channels: 4, data: new Uint8Array(d.data.buffer) };
}

/**
 * Reads printed music from page images with homr. Rejects with an AbortError when `signal` aborts (the
 * worker is ended at once) and with a SheetReadError (message for the user) when nothing could be read.
 */
export async function readSheetImages(pages: HomrPage[], opts: ReadOptions = {}): Promise<ReadResult> {
  if (!pages.length) throw new SheetReadError('No pages to read.');
  if (pages.length > MAX_PAGES) throw new SheetReadError(`Please choose at most ${MAX_PAGES} pages at a time.`);
  if (opts.signal?.aborted) throw abortError();
  const t0 = performance.now();
  const threads = Math.max(1, opts.threads ?? wasmThreads(4));
  const release = opts.release ?? isMemoryConstrained(pageDeviceInfo() ?? { ua: '' });
  const model = opts.model ?? homrModelSpec(baseUrl());
  const jobId = nextJob++;
  const n = pages.length;
  const r = await new Promise<{ musicXml: string; pages: HomrPageResult[]; stats: RunStats }>((resolve, reject) => {
    const worker = takeWorker(threads);
    let settled = false;
    let downloaded = false;
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
    // overall progress: download 0–0.2 (when there is one), then the pages in equal shares
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const m = e.data;
      if (settled || m.jobId !== jobId) return;
      if (m.type === 'need-page') {
        let px: Omit<PageInput, 'quad'>;
        try {
          px = pagePixels(pages[m.index].image);
        } catch (err) {
          finish(false);
          reject(err instanceof SheetReadError ? err : new SheetReadError('This image could not be read.'));
          return;
        }
        const msg: WorkerRequest = { type: 'page', jobId, index: m.index, page: { ...px, quad: pages[m.index].quad ?? null } };
        worker.postMessage(msg, [px.data.buffer]);
      } else if (m.type === 'progress') {
        if (m.stage === 'loading-model') {
          if ((m.total ?? 0) > 0 && (m.loaded ?? 0) < (m.total ?? 0)) downloaded = true;
          opts.onProgress?.({ stage: m.stage, progress: 0.2 * m.progress, loaded: m.loaded, total: m.total });
        } else {
          const start = downloaded ? 0.2 : 0.02;
          const page = m.page ?? 0;
          // per page: finding the lines ~30 %, reading the staffs ~70 %
          const within = m.stage === 'finding-lines' ? 0.3 * m.progress : 0.3 + 0.7 * m.progress;
          opts.onProgress?.({ stage: m.stage, progress: start + (1 - start) * ((page + within) / n), page: page + 1, pages: n, line: m.line, lines: m.lines });
        }
      } else if (m.type === 'error') {
        finish(false);
        reject(new SheetReadError(m.message));
      } else if (m.type === 'result') {
        finish(true);
        resolve({ musicXml: m.musicXml, pages: m.pages, stats: m.stats });
      }
    };
    worker.onerror = (e) => {
      if (settled) return;
      finish(false);
      reject(new SheetReadError(`The sheet-music reader stopped${e.message ? ` (${e.message})` : ''}. Please try again.`));
    };
    const req: WorkerRequest = { type: 'run', jobId, pageCount: n, model, threads, release, title: opts.title };
    worker.postMessage(req);
  });
  return assemble(r, n, performance.now() - t0);
}

/** Worker output → result and warnings (exported for tests). */
export function assemble(r: { musicXml: string; pages: HomrPageResult[]; stats: RunStats }, nPages: number, ms = 0): ReadResult {
  const warnings: string[] = [];
  const empty = r.pages.map((p, i) => (p.error ? i + 1 : 0)).filter(Boolean);
  if (!r.musicXml || empty.length === nPages) {
    throw new SheetReadError(
      nPages === 1
        ? 'No music was found on this page. The reader needs printed sheet music (not handwriting), with the whole page sharp and evenly lit.'
        : 'No music was found on these pages. The reader needs printed sheet music (not handwriting), with each page sharp and evenly lit.',
    );
  }
  if (empty.length) warnings.push(`No music was found on page ${empty.join(', ')}.`);
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
  support: homrReaderSupport,
  downloadBytes: homrDownloadBytes,
  readPages(images: (PageSource | HomrPage)[], opts: ReadOptions = {}): Promise<ReadResult> {
    const pages = images.map((p) => (typeof p === 'object' && p !== null && 'image' in p ? (p as HomrPage) : { image: p as PageSource }));
    return readSheetImages(pages, opts);
  },
  release: releaseHomrReader,
};
