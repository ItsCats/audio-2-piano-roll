/**
 * The tempo printed on a PDF page, from its text layer (pdf.js getTextContent): typeset PDFs from
 * notation programs keep their words as text ("Andante", "♩ = 72", "q = 72"; the note itself is often
 * a music-font glyph that can't be read, then the beat is the meter's). Only the top of the page is
 * looked at (the title, the tempo, the composer): text further down is lyrics, fingering, footers.
 * Scanned pages and photos have no text layer: nothing is found and the tempo is set by hand.
 */
import { tempoFromWords, tempoNumberInText, type WrittenTempoUnit } from './ir';

/** A text run on the page: position of its baseline in PDF units (y up from the bottom) and its height. */
export interface PageTextItem {
  str: string;
  x: number;
  y: number;
  h: number;
}

export interface PageTempo {
  bpm: number;
  /** null: the note before "=" wasn't readable (the meter's beat) */
  unit: WrittenTempoUnit | null;
  /** the line it was read from */
  text: string;
  /** from tempo words alone ("Andante"): a guess, not a number on the page */
  guess: boolean;
}

/** Part of the page height, from the top, that is searched. */
const TOP_SHARE = 0.4;

/** The page's text lines in the top part of the page, top to bottom (runs on one baseline joined left to right). */
export function topLines(items: PageTextItem[], pageHeight: number): string[] {
  const top = items.filter((it) => it.str.trim() && Number.isFinite(it.x) && Number.isFinite(it.y) && it.y >= pageHeight * (1 - TOP_SHARE));
  top.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: { y: number; h: number; runs: PageTextItem[] }[] = [];
  for (const it of top) {
    const line = lines.find((l) => Math.abs(l.y - it.y) <= Math.max(2, 0.5 * Math.max(l.h, it.h)));
    if (line) {
      line.runs.push(it);
      line.h = Math.max(line.h, it.h);
    } else lines.push({ y: it.y, h: it.h, runs: [it] });
  }
  return lines.map((l) =>
    l.runs
      .sort((a, b) => a.x - b.x)
      .map((r) => r.str.trim())
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

/** The tempo printed at the top of the page: a metronome mark first, else tempo words (a guess). */
export function tempoFromPageText(items: PageTextItem[], pageHeight: number): PageTempo | null {
  const lines = topLines(items, pageHeight).slice(0, 40);
  for (const line of lines) {
    const num = tempoNumberInText(line);
    if (num) return { ...num, text: line.slice(0, 60), guess: false };
  }
  for (const line of lines) {
    // a short line only: a title like "Sonata in the style of an Allegro" is not a tempo
    if (line.split(' ').length > 4) continue;
    const qpm = tempoFromWords(line);
    if (qpm) return { bpm: qpm, unit: 'q', text: line.slice(0, 60), guess: true };
  }
  return null;
}
