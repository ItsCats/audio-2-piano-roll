/**
 * Watermark layout (pure: text widths come from a measure function, so it is unit-tested without a
 * canvas). Spaced capitals are laid out glyph by glyph (ctx.letterSpacing is not available everywhere).
 */
import { familyCss, nearestWeight } from '../render/titleCard/presets';
import type { WatermarkPosition, WatermarkSettings } from './types';
import { watermarkActive } from './types';

/** letter spacing of spaced capitals, in em */
export const TRACKING_EM = 0.38;
/** dimmer part of a highlighted link ("YOUTUBE.COM/") */
export const DIM_ALPHA = 0.55;

export interface Glyph {
  ch: string;
  x: number;
  /** multiplies the watermark opacity */
  alpha: number;
}

export interface WatermarkLayout {
  font: string;
  px: number;
  baseline: number;
  glyphs: Glyph[];
  /** whole strings when the letters are not spaced */
  runs: { text: string; x: number; alpha: number }[];
  /** text bounds (empty when there is no text) */
  bbox: { x: number; y: number; w: number; h: number } | null;
  logo: { x: number; y: number; w: number; h: number } | null;
  /** canvas height / 1080 */
  scale: number;
}

export type Measure = (text: string, font: string) => number;

export const textPx = (w: Pick<WatermarkSettings, 'size'>, W: number, H: number): number => Math.max(8, w.size * 26 * (Math.min(W, H) / 1080));
export const fontFor = (w: Pick<WatermarkSettings, 'font'>, px: number): string => `${nearestWeight(w.font, w.font === 'cormorant' ? 600 : 400)} ${px.toFixed(2)}px ${familyCss(w.font)}`;
export const displayText = (w: Pick<WatermarkSettings, 'text' | 'spaced'>): string => (w.spaced ? w.text.trim().toUpperCase() : w.text.trim());
const isBottom = (p: WatermarkPosition) => p[0] === 'b';

/**
 * Height to keep free under a "hands at the bottom" video for a watermark at the bottom of the frame
 * (0 when there is none there).
 */
export function watermarkBand(w: WatermarkSettings, W: number, H: number): number {
  if (!watermarkActive(w)) return 0;
  let band = 0;
  if (w.text.trim() && isBottom(w.position)) band = 2.6 * textPx(w, W, H);
  if (w.logo && isBottom(w.logo.position)) band = Math.max(band, w.logo.size * H + 2 * margin(W, H) * 0.6);
  return Math.round(band);
}

const margin = (W: number, H: number) => 0.04 * Math.min(W, H);

/**
 * Where everything goes. `band`: the space reserved at the bottom (hands video layout), the bottom
 * line is centered in it; `avoidBottom`: the Studio keyboard's height (a bottom watermark sits above it).
 */
export function watermarkLayout(w: WatermarkSettings, W: number, H: number, measure: Measure, opts: { band?: number; avoidBottom?: number; logoAspect?: number } = {}): WatermarkLayout {
  const px = textPx(w, W, H);
  const font = fontFor(w, px);
  const m = margin(W, H);
  const band = opts.band ?? 0;
  const lift = band > 0 ? 0 : (opts.avoidBottom ?? 0);
  const text = w.enabled ? displayText(w) : '';
  const glyphs: Glyph[] = [];
  const runs: WatermarkLayout['runs'] = [];
  // text width
  const cut = w.highlightName ? text.lastIndexOf('/') : -1;
  const parts = cut >= 0 && cut < text.length - 1 ? [{ s: text.slice(0, cut + 1), a: DIM_ALPHA }, { s: text.slice(cut + 1), a: 1 }] : [{ s: text, a: 1 }];
  let total = 0;
  const track = TRACKING_EM * px;
  const widths: number[] = [];
  if (w.spaced) {
    for (const ch of text) {
      const cw = measure(ch, font);
      widths.push(cw);
      total += cw;
    }
    total += track * Math.max(0, [...text].length - 1);
  } else for (const p of parts) total += measure(p.s, font);
  // logo size
  const L = w.enabled ? w.logo : null;
  const lh = L ? L.size * H : 0;
  const lw = L ? lh * (opts.logoAspect ?? 1) : 0;
  const gap = 0.5 * px;
  const sharesCorner = !!(L && text && L.position === w.position);
  const groupW = sharesCorner ? lw + gap + total : total;
  // text anchor
  const pos = w.position;
  const bottomBase = band > 0 ? H - band / 2 + 0.33 * px : H - m - lift;
  const baseline = isBottom(pos) ? bottomBase : m + 0.8 * px;
  const gx = pos === 'bc' ? (W - groupW) / 2 : pos === 'bl' || pos === 'tl' ? m : W - m - groupW;
  const tx = sharesCorner ? gx + lw + gap : gx;
  if (text) {
    if (w.spaced) {
      let x = tx;
      let i = 0;
      for (const p of parts) {
        for (const ch of p.s) {
          glyphs.push({ ch, x, alpha: p.a });
          x += widths[i++] + track;
        }
      }
    } else {
      let x = tx;
      for (const p of parts) {
        runs.push({ text: p.s, x, alpha: p.a });
        x += measure(p.s, font);
      }
    }
  }
  const bbox = text ? { x: tx, y: baseline - 0.8 * px, w: total, h: 1.05 * px } : null;
  let logo: WatermarkLayout['logo'] = null;
  if (L) {
    const lp = L.position;
    const midY = baseline - 0.3 * px; // the text's optical middle
    if (sharesCorner) logo = { x: gx, y: midY - lh / 2, w: lw, h: lh };
    else {
      const x = lp === 'bc' ? (W - lw) / 2 : lp === 'bl' || lp === 'tl' ? m : W - m - lw;
      const y = isBottom(lp) ? (band > 0 ? H - band / 2 - lh / 2 : H - m - lift - lh) : m;
      logo = { x, y, w: lw, h: lh };
    }
  }
  return { font, px, baseline, glyphs, runs, bbox, logo, scale: H / 1080 };
}
