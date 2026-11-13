/**
 * PDF pages → gray images for the sheet-music reader, with Mozilla's pdf.js (pdfjs-dist 6.4.299,
 * Apache-2.0), loaded only when a PDF is read. Its worker script and the WASM image decoders it needs
 * for scanned pages (JBIG2 / CCITT from PDFium, JPEG 2000 from OpenJPEG, both BSD-licensed; colour
 * management from qcms, MIT) are served from our own origin: the worker as a fingerprinted /assets file,
 * the decoders from public/pdfjs/wasm/. PDF JavaScript is never run: scripting is a viewer feature we do
 * not use, and pdf.js 6 no longer compiles anything with eval / new Function (its old isEvalSupported
 * option is gone), so the app's CSP without 'unsafe-eval' is enough.
 */
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { grayFromRGBA, type Gray } from './image';

/** Width a page is rendered at (the reader straightens pages to 1654 px; a little more keeps lines crisp). */
export const PDF_RENDER_WIDTH = 2000;

type PdfJs = typeof import('pdfjs-dist');
let lib: Promise<PdfJs> | null = null;

async function pdfjs(): Promise<PdfJs> {
  lib ??= (async () => {
    const mod = await import('pdfjs-dist');
    mod.GlobalWorkerOptions.workerSrc = new URL(pdfWorkerUrl, location.href).href;
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

/** An open PDF: render its pages one by one, then close it (the page picker keeps one open). */
export interface PdfDocument {
  numPages: number;
  /** page (1-based) as a gray image `width` pixels wide on white */
  render(page: number, width?: number): Promise<Gray>;
  close(): Promise<void>;
}

/** Opens a PDF once (password-protected / damaged files: an Error with a plain message). */
export async function openPdf(bytes: Uint8Array): Promise<PdfDocument> {
  const { doc, task } = await open(bytes);
  let closed = false;
  return {
    numPages: doc.numPages,
    render: async (n, width = PDF_RENDER_WIDTH) => {
      if (closed) throw new DOMException('Closed', 'AbortError');
      const page = await doc.getPage(n);
      const v1 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: width / v1.width });
      const w = Math.round(vp.width);
      const h = Math.round(vp.height);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      try {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('This browser cannot draw PDF pages.');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, w, h);
        await page.render({ canvas, canvasContext: ctx, viewport: vp, background: '#ffffff' }).promise;
        const data = ctx.getImageData(0, 0, w, h);
        return grayFromRGBA(data.data, w, h);
      } finally {
        page.cleanup();
        canvas.width = canvas.height = 0;
      }
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await task.destroy().catch(() => undefined);
    },
  };
}

/** Number of pages of a PDF. */
export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  const doc = await openPdf(bytes);
  try {
    return doc.numPages;
  } finally {
    await doc.close();
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
  const doc = await openPdf(bytes);
  try {
    const all = Array.from({ length: doc.numPages }, (_, i) => i + 1);
    const list = (opts.pages ?? all).filter((p) => p >= 1 && p <= doc.numPages).slice(0, opts.maxPages ?? 20);
    const out: Gray[] = [];
    for (let i = 0; i < list.length; i++) {
      if (opts.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      out.push(await doc.render(list[i], opts.width));
      opts.onPage?.(i + 1, list.length);
    }
    return out;
  } finally {
    await doc.close();
  }
}
