/**
 * Sheet-music PDF (DOM): the score is drawn one line at a time by OpenSheetMusicDisplay (SVG, off
 * screen), and svg2pdf.js turns each line into vector drawing commands on A4 / Letter pages in
 * jsPDF, which also writes the title, page numbers and the credit line. All three libraries load
 * only when a PDF is made.
 *
 * Drawing the whole song with one OSMD instance froze the page for seconds on long songs; one line
 * per instance keeps every step short, the page responsive between them, and lets the dialog show
 * progress. The lines use our own line breaks (layout.ts), like the on-screen view.
 *
 * jsPDF's standard fonts only cover Windows-1252 text: a title or artist outside it (e.g. Japanese)
 * is drawn on page 1 as a high-resolution image instead.
 */
import { CREDIT_LINE, toMusicXml } from './musicxml';
import { lineBudget, systemBreaks } from './layout';
import { loadOsmd, showAllTupletNumbers } from './render';
import type { Score } from './types';

import type { Paper } from './paper';

const PAGE_MM: Record<Paper, [number, number]> = { a4: [210, 297], letter: [215.9, 279.4] };
const MARGIN_X = 15;
const MARGIN_TOP = 15;
/** Space kept free at the bottom for the page number and credit line. */
const MARGIN_BOTTOM = 16;
/** Lines are drawn this wide (px) and scaled to the page: a staff is about 7.5 mm high. */
const LINE_PX = 960;
/** Space between two lines (mm). */
const LINE_GAP = 3;

const CP1252_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
/** Whether jsPDF's standard fonts can write this text (Windows-1252). */
export function isWinAnsi(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff) || CP1252_EXTRA.has(ch)) continue;
    return false;
  }
  return true;
}

const yieldToMain = (): Promise<void> => {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (s?.yield) return s.yield();
  return new Promise((r) => setTimeout(r, 0));
};

/** A PNG of one or two centred text lines (title, artist) for page 1. */
function titleImage(title: string, artist: string | undefined, widthMm: number): { url: string; w: number; h: number } {
  const scale = 4;
  const pxPerMm = 96 / 25.4;
  const W = Math.round(widthMm * pxPerMm * scale);
  const H = Math.round((artist ? 22 : 14) * pxPerMm * scale);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.textAlign = 'center';
  g.textBaseline = 'top';
  g.font = `${Math.round(7.4 * pxPerMm * scale)}px "Times New Roman", serif`;
  g.fillText(title, W / 2, 2 * scale, W - 8 * scale);
  if (artist) {
    g.font = `${Math.round(3.9 * pxPerMm * scale)}px "Times New Roman", serif`;
    g.fillText(artist, W / 2, 13 * pxPerMm * scale, W - 8 * scale);
  }
  return { url: c.toDataURL('image/png'), w: widthMm, h: H / scale / pxPerMm };
}

export interface PdfResult {
  blob: Blob;
  pages: number;
}

export interface PdfOptions {
  /** Progress: lines drawn so far of all lines. */
  onProgress?: (done: number, total: number) => void;
  /** Stops early (throws an AbortError) when aborted. */
  signal?: AbortSignal;
}

export async function makeSheetPdf(score: Score, meta: { title: string; artist?: string }, paper: Paper, opts: PdfOptions = {}): Promise<PdfResult> {
  const [W, H] = PAGE_MM[paper];
  const contentW = W - 2 * MARGIN_X;
  const mmPerPx = contentW / LINE_PX;
  const fitsFonts = isWinAnsi(meta.title) && isWinAnsi(meta.artist ?? '');
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:-20000px;top:0;width:${LINE_PX}px;background:#fff;pointer-events:none`;
  host.setAttribute('aria-hidden', 'true');
  document.body.appendChild(host);
  try {
    const [{ OpenSheetMusicDisplay }, { jsPDF }, { svg2pdf }] = await Promise.all([loadOsmd(), import('jspdf'), import('svg2pdf.js')]);
    const doc = new jsPDF({ unit: 'mm', format: paper, orientation: 'portrait', compress: true });
    doc.setProperties({ title: meta.title, author: meta.artist ?? '', creator: 'Piano2Vision', subject: CREDIT_LINE });

    // title block on page 1
    let y = MARGIN_TOP;
    if (fitsFonts) {
      doc.setFont('times', 'normal');
      doc.setTextColor(0);
      doc.setFontSize(20);
      const lines = doc.splitTextToSize(meta.title, contentW) as string[];
      doc.text(lines, W / 2, y + 6, { align: 'center' });
      y += 6 + lines.length * 8;
      if (meta.artist) {
        doc.setFontSize(11);
        const a = doc.splitTextToSize(meta.artist, contentW) as string[];
        doc.text(a, W / 2, y, { align: 'center' });
        y += a.length * 5;
      }
      y += 4;
    } else {
      const img = titleImage(meta.title, meta.artist, contentW);
      doc.addImage(img.url, 'PNG', MARGIN_X, y, img.w, img.h);
      y += img.h + 2;
    }

    const starts = systemBreaks(score, lineBudget(LINE_PX - 20, 1));
    let page = 1;
    for (let i = 0; i < starts.length; i++) {
      if (opts.signal?.aborted) throw new DOMException('Stopped', 'AbortError');
      const from = starts[i];
      const to = starts[i + 1] ?? score.measureCount;
      const el = document.createElement('div');
      host.replaceChildren(el);
      const osmd = new OpenSheetMusicDisplay(el, {
        autoResize: false,
        backend: 'svg',
        drawTitle: false,
        drawSubtitle: false,
        drawComposer: false,
        drawLyricist: false,
        drawCredits: false,
        drawPartNames: false,
        drawPartAbbreviations: false,
        drawMeasureNumbersOnlyAtSystemStart: true,
        newSystemFromXML: true,
        drawingParameters: 'compacttight',
        followCursor: false,
        disableCursor: true,
        autoBeam: false,
        pageBackgroundColor: '#FFFFFF',
        stretchLastSystemLine: to < score.measureCount,
      });
      showAllTupletNumbers(osmd);
      await osmd.load(toMusicXml(score, { title: '', from, to, breaks: starts }));
      osmd.render();
      // OSMD writes the tempo mark's "= 120" with a font size in pt, which svg2pdf drops: use px
      for (const t of el.querySelectorAll<SVGTextElement>('text[font-size$="pt"]')) {
        t.setAttribute('font-size', `${(parseFloat(t.getAttribute('font-size')!) * 4) / 3}px`);
      }
      for (const svg of el.querySelectorAll('svg')) {
        const wPx = parseFloat(svg.getAttribute('width') ?? '') || LINE_PX;
        const hPx = parseFloat(svg.getAttribute('height') ?? '') || svg.getBoundingClientRect().height;
        const w = wPx * mmPerPx;
        const h = hPx * mmPerPx;
        if (y + h > H - MARGIN_BOTTOM && y > MARGIN_TOP + 1) {
          doc.addPage();
          page++;
          y = MARGIN_TOP;
        }
        await svg2pdf(svg, doc, { x: MARGIN_X, y, width: w, height: h });
        y += h + LINE_GAP;
      }
      host.replaceChildren();
      opts.onProgress?.(i + 1, starts.length);
      await yieldToMain();
    }
    const pages = page;
    for (let p = 1; p <= pages; p++) {
      doc.setPage(p);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(120);
      doc.text(`${p} / ${pages}`, W / 2, H - 8, { align: 'center' });
      if (p === 1) doc.text(CREDIT_LINE, W - MARGIN_X, H - 8, { align: 'right' });
    }
    return { blob: doc.output('blob'), pages };
  } finally {
    host.remove();
  }
}
