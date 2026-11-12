/**
 * Sheet-music PDF (DOM): OSMD draws the score as A4 / Letter pages (SVG, off screen), svg2pdf.js
 * turns each page into vector PDF drawing commands in jsPDF, and jsPDF adds page numbers and the
 * credit line. All three libraries load only when a PDF is made.
 *
 * jsPDF's standard fonts only cover Windows-1252 text: a title or artist outside it (e.g. Japanese)
 * is drawn on page 1 as a high-resolution image instead, with OSMD keeping the space free.
 */
import { CREDIT_LINE, toMusicXml } from './musicxml';
import { loadOsmd } from './render';
import type { Score } from './types';

import type { Paper } from './paper';

const PAGE_MM: Record<Paper, [number, number]> = { a4: [210, 297], letter: [215.9, 279.4] };
const PAGE_PX: Record<Paper, number> = { a4: 794, letter: 816 };

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

const sleep0 = () => new Promise<void>((r) => setTimeout(r, 0));

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

export async function makeSheetPdf(score: Score, meta: { title: string; artist?: string }, paper: Paper): Promise<PdfResult> {
  const [W, H] = PAGE_MM[paper];
  const fitsFonts = isWinAnsi(meta.title) && isWinAnsi(meta.artist ?? '');
  const nb = (s: string) => ' '.repeat(Math.max(1, [...s].length));
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:-20000px;top:0;width:${PAGE_PX[paper]}px;background:#fff;pointer-events:none`;
  host.setAttribute('aria-hidden', 'true');
  document.body.appendChild(host);
  try {
    const [{ OpenSheetMusicDisplay }, { jsPDF }, { svg2pdf }] = await Promise.all([loadOsmd(), import('jspdf'), import('svg2pdf.js')]);
    const osmd = new OpenSheetMusicDisplay(host, {
      autoResize: false,
      backend: 'svg',
      pageFormat: paper === 'a4' ? 'A4_P' : 'Letter_P',
      pageBackgroundColor: '#FFFFFF',
      drawingParameters: 'default',
      drawTitle: true,
      drawComposer: true,
      drawCredits: false,
      drawPartNames: false,
      drawMeasureNumbersOnlyAtSystemStart: true,
      autoBeam: false,
      followCursor: false,
      disableCursor: true,
    });
    const xml = toMusicXml(score, {
      title: fitsFonts ? meta.title : nb(meta.title),
      artist: meta.artist ? (fitsFonts ? meta.artist : nb(meta.artist)) : undefined,
    });
    await osmd.load(xml);
    osmd.render();
    const pages = [...host.querySelectorAll('svg')] as SVGSVGElement[];
    const doc = new jsPDF({ unit: 'mm', format: paper, orientation: 'portrait', compress: true });
    doc.setProperties({ title: meta.title, author: meta.artist ?? '', creator: 'Piano2Vision', subject: CREDIT_LINE });
    // OSMD writes the tempo mark's "= 120" with a font size in pt, which svg2pdf drops: use px
    for (const el of host.querySelectorAll<SVGTextElement>('text[font-size$="pt"]')) {
      el.setAttribute('font-size', `${(parseFloat(el.getAttribute('font-size')!) * 4) / 3}px`);
    }
    for (let i = 0; i < pages.length; i++) {
      if (i) doc.addPage();
      await svg2pdf(pages[i], doc, { x: 0, y: 0, width: W, height: H });
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(120);
      doc.text(`${i + 1} / ${pages.length}`, W / 2, H - 8, { align: 'center' });
      if (i === 0) {
        doc.text(CREDIT_LINE, W - 12, H - 8, { align: 'right' });
        if (!fitsFonts) {
          const img = titleImage(meta.title, meta.artist, W - 30);
          doc.addImage(img.url, 'PNG', 15, 10, img.w, img.h);
        }
      }
      if (i % 4 === 3) await sleep0();
    }
    return { blob: doc.output('blob'), pages: pages.length };
  } finally {
    host.remove();
  }
}
