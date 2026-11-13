/**
 * PDF pages → gray images for the sheet-music reader, with Mozilla's pdf.js (pdfjs-dist 6.4.299,
 * Apache-2.0), loaded only when a PDF is read. Its worker script and the WASM image decoders it needs
 * for scanned pages (JBIG2 / CCITT from PDFium, JPEG 2000 from OpenJPEG, both BSD-licensed; colour
 * management from qcms, MIT) are served from our own origin: the worker as a fingerprinted /assets file,
 * the decoders from public/pdfjs/wasm/. PDF JavaScript is never run: scripting is a viewer feature we do
 * not use, and pdf.js 6 no longer compiles anything with eval / new Function (its old isEvalSupported
 * option is gone), so the app's CSP without 'unsafe-eval' is enough.
 */
import { grayFromRGBA, type Gray } from './image';

/** Width a page is rendered at (the reader straightens pages to 1654 px; a little more keeps lines crisp). */
export const PDF_RENDER_WIDTH = 2000;

type PdfJs = typeof import('pdfjs-dist');
let lib: Promise<PdfJs> | null = null;

async function pdfjs(): Promise<PdfJs> {
  lib ??= (async () => {
    const [mod, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
    mod.GlobalWorkerOptions.workerSrc = worker.default;
    return mod;
  })();
  try {
    return await lib;
  } catch (err) {
    lib = null;
    throw err;
  }
}

function base(): string {
  const origin = typeof location === 'undefined' ? 'http://localhost/' : location.href;
  return new URL(import.meta.env.BASE_URL ?? '/', origin).href;
}

async function open(bytes: Uint8Array) {
  const pdf = await pdfjs();
  const task = pdf.getDocument({
    // pdf.js takes ownership of (detaches) the buffer it is given
    data: bytes.slice(),
    enableXfa: false,
    wasmUrl: new URL('pdfjs/wasm/', base()).href,
    // text is not needed for reading notes; no font files are fetched
    disableFontFace: false,
    useSystemFonts: true,
  });
  try {
    return { doc: await task.promise, task };
  } catch (err) {
    await task.destroy().catch(() => undefined);
    const name = (err as { name?: string })?.name;
    if (name === 'PasswordException') throw new Error('This PDF is password-protected. Please use a copy without a password.', { cause: err });
    throw new Error('This PDF could not be opened. It may be damaged.', { cause: err });
  }
}

/** Number of pages of a PDF. */
export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  const { doc, task } = await open(bytes);
  try {
    return doc.numPages;
  } finally {
    await task.destroy();
  }
}

export interface RenderPdfOptions {
  /** 1-based page numbers to render (default: all, up to maxPages) */
  pages?: number[];
  maxPages?: number;
  width?: number;
  signal?: AbortSignal;
  onPage?: (done: number, total: number) => void;
}

/** Renders PDF pages as gray images `width` pixels wide (white background). */
export async function renderPdfPages(bytes: Uint8Array, opts: RenderPdfOptions = {}): Promise<Gray[]> {
  const { doc, task } = await open(bytes);
  try {
    const all = Array.from({ length: doc.numPages }, (_, i) => i + 1);
    const list = (opts.pages ?? all).filter((p) => p >= 1 && p <= doc.numPages).slice(0, opts.maxPages ?? 20);
    const out: Gray[] = [];
    for (let i = 0; i < list.length; i++) {
      if (opts.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const page = await doc.getPage(list[i]);
      const v1 = page.getViewport({ scale: 1 });
      const scale = (opts.width ?? PDF_RENDER_WIDTH) / v1.width;
      const vp = page.getViewport({ scale });
      const w = Math.round(vp.width);
      const h = Math.round(vp.height);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('This browser cannot draw PDF pages.');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      await page.render({ canvas, canvasContext: ctx, viewport: vp, background: '#ffffff' }).promise;
      const data = ctx.getImageData(0, 0, w, h);
      out.push(grayFromRGBA(data.data, w, h));
      page.cleanup();
      canvas.width = canvas.height = 0;
      opts.onPage?.(i + 1, list.length);
    }
    return out;
  } finally {
    await task.destroy();
  }
}
