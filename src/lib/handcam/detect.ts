/**
 * Best-effort automatic keyboard finding on a still frame (pure, unit-tested). The user can always drag
 * the corners and move the sliders; these only give a good start.
 *
 *  - findKeyboard: the black-key band is the run of rows with many narrow dark runs; the white
 *    keys continue below it until the brightness drops (the front edge). Done separately on the left and
 *    right of the frame, which gives the keyboard's tilt.
 *  - guessRange: counts the black keys on a straightened keyboard (36 → 88 keys, 31 → 76, 25 → 61).
 *  - autoMatch: moves and stretches the lanes until the predicted black keys sit on the dark keys found.
 */
import { isBlack } from '../music/theory';
import { BLACK_OFFSET } from '../render/layout';
import { cornerHomography, whitesBetween, type KeyPreset } from './calibration';
import { apply3 } from '../geom/homography';
import type { KeyboardCalibration } from './types';

export interface Gray {
  w: number;
  h: number;
  d: Uint8Array | Uint8ClampedArray;
}

/** RGBA pixels → gray */
export function toGray(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Gray {
  const d = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) d[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
  return { w, h, d };
}

export function shrink(img: Gray, maxW: number): Gray {
  if (img.w <= maxW) return img;
  const k = img.w / maxW;
  const w = maxW;
  const h = Math.max(1, Math.round(img.h / k));
  const d = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // box average
      const x0 = Math.floor(x * k);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * k));
      const y0 = Math.floor(y * k);
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * k));
      let s = 0;
      let n = 0;
      for (let yy = y0; yy < Math.min(img.h, y1); yy++)
        for (let xx = x0; xx < Math.min(img.w, x1); xx++) {
          s += img.d[yy * img.w + xx];
          n++;
        }
      d[y * w + x] = n ? s / n : 0;
    }
  return { w, h, d };
}

/** per row: dark runs as narrow as a black key, and the share of bright pixels (between x0 and x1) */
function rowStats(img: Gray, y: number, x0: number, x1: number): { segs: number; bright: number } {
  let segs = 0;
  let bright = 0;
  let run = 0;
  const maxRun = Math.max(3, img.w / 25);
  const row = y * img.w;
  for (let x = x0; x <= x1; x++) {
    const v = x < x1 ? img.d[row + x] : 255;
    if (v > 165) bright++;
    if (v < 90) run++;
    else {
      if (run >= 1 && run <= maxRun && x - run > x0) segs++;
      run = 0;
    }
  }
  return { segs, bright: bright / Math.max(1, x1 - x0) };
}

/** longest run of rows where `on(y)` holds (gaps of up to 2 rows bridged) */
function longestRun(h: number, on: (y: number) => boolean): [number, number] | null {
  let best: [number, number] | null = null;
  let start = -1;
  let last = -1;
  for (let y = 0; y <= h; y++) {
    const ok = y < h && on(y);
    if (ok) {
      if (start < 0) start = y;
      last = y;
    } else if (start >= 0 && (y - last > 2 || y === h)) {
      if (!best || last - start > best[1] - best[0]) best = [start, last];
      start = -1;
    }
  }
  return best;
}

/**
 * The keys in a column range: the black-key band (rows with many narrow dark runs) and the front edge
 * (where the bright white keys below it end). Rows, or null.
 */
export function keyRows(img: Gray, x0: number, x1: number): { back: number; blackEnd: number; front: number } | null {
  const st = Array.from({ length: img.h }, (_, y) => rowStats(img, y, x0, x1));
  const S = st.map((_, y) => (st[Math.max(0, y - 1)].segs + st[y].segs + st[Math.min(img.h - 1, y + 1)].segs) / 3);
  const max = Math.max(...S);
  // at least ~6 black keys in this part of the frame
  if (max < 6) return null;
  const band = longestRun(img.h, (y) => st[y].segs >= Math.max(4, 0.5 * max));
  if (!band || band[1] - band[0] < 2) return null;
  let front = band[1];
  let gap = 0;
  for (let y = band[1] + 1; y < img.h; y++) {
    if (st[y].bright > 0.35 && st[y].segs < 3) {
      front = y;
      gap = 0;
    } else if (++gap > 2) break;
  }
  // the white part is about 0.37 of a key; a hand over it can hide some of it
  front = Math.max(front + 1, band[1] + Math.round((band[1] - band[0]) * 0.45));
  return { back: band[0], blackEnd: band[1], front: Math.min(img.h, front) };
}

/**
 * Corners of the keyboard (fractions of the frame: back-left, back-right, front-right, front-left), or
 * null when no keyboard-like pattern is found.
 */
export function findKeyboard(input: Gray): [number, number][] | null {
  const img = shrink(input, 360);
  const { w, h } = img;
  const parts = [
    [0, Math.round(w * 0.45)],
    [Math.round(w * 0.55), w],
  ] as const;
  let rows = parts.map(([a, b]) => keyRows(img, a, b));
  if (!rows[0] || !rows[1]) {
    const all = keyRows(img, 0, w);
    if (!all) return null;
    rows = [all, all];
  }
  const [L, R] = rows as [NonNullable<(typeof rows)[0]>, NonNullable<(typeof rows)[0]>];
  const xs = parts.map(([a, b]) => (a + b) / 2);
  const lineY = (ya: number, yb: number, x: number) => ya + ((yb - ya) * (x - xs[0])) / (xs[1] - xs[0] || 1);
  // left and right ends, on a row near the back and one near the front (perspective makes the
  // keyboard wider at the front): how far the keys (bright, with narrow dark gaps) reach
  const maxGap = Math.max(4, Math.round(w / 25));
  const extent = (yAt: (x: number) => number): [number, number] => {
    const keyish = (x: number) => img.d[Math.max(0, Math.min(h - 1, Math.round(yAt(x)))) * w + x] > 150;
    let l = Math.round(w / 2);
    let r = l;
    let miss = 0;
    for (let x = l; x >= 0; x--) {
      if (keyish(x)) {
        l = x;
        miss = 0;
      } else if (++miss > maxGap) break;
    }
    miss = 0;
    for (let x = r; x < w; x++) {
      if (keyish(x)) {
        r = x + 1;
        miss = 0;
      } else if (++miss > maxGap) break;
    }
    return [l, r];
  };
  const backY = (x: number) => lineY(L.back, R.back, x);
  const frontY = (x: number) => lineY(L.front, R.front, x);
  const at = (f: number) => (x: number) => backY(x) + (frontY(x) - backY(x)) * f;
  const fb = 0.12;
  const ff = 0.85;
  const [lb, rb] = extent(at(fb));
  const [lf, rf] = extent(at(ff));
  if (Math.min(rb - lb, rf - lf) < w * 0.2) return null;
  // extend both sides to the back (v 0) and front (v 1) edges
  const ext = (xb: number, xf: number, v: number) => xb + ((xf - xb) * (v - fb)) / (ff - fb);
  const pt = (x: number, y: number): [number, number] => [x / w, y / h];
  const xBL = ext(lb, lf, 0);
  const xBR = ext(rb, rf, 0);
  const xFR = ext(rb, rf, 1);
  const xFL = ext(lb, lf, 1);
  return [pt(xBL, backY(xBL)), pt(xBR, backY(xBR)), pt(xFR, frontY(xFR)), pt(xFL, frontY(xFL))];
}

/**
 * The keyboard between `corners` straightened into a w × h gray strip (u across, v from v0 to v1 down),
 * bilinear.
 */
export function rectify(img: Gray, corners: [number, number][], w: number, h: number, v0 = 0, v1 = 1): Gray {
  const Hm = cornerHomography(corners);
  const d = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const v = v0 + ((y + 0.5) / h) * (v1 - v0);
    for (let x = 0; x < w; x++) {
      const p = apply3(Hm, (x + 0.5) / w, v);
      const sx = p.x * img.w - 0.5;
      const sy = p.y * img.h - 0.5;
      if (sx < 0 || sy < 0 || sx > img.w - 1 || sy > img.h - 1) continue;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const i = y0 * img.w + x0;
      const a = img.d[i] + (img.d[Math.min(i + 1, img.d.length - 1)] - img.d[i]) * fx;
      const b = img.d[Math.min(i + img.w, img.d.length - 1)] + (img.d[Math.min(i + img.w + 1, img.d.length - 1)] - img.d[Math.min(i + img.w, img.d.length - 1)]) * fx;
      d[y * w + x] = a + (b - a) * fy;
    }
  }
  return { w, h, d };
}

/** Centers (u, 0..1) of the dark keys along the black-key row of a straightened keyboard. */
export function darkKeys(strip: Gray, v = 0.35): number[] {
  const y = Math.min(strip.h - 1, Math.round(v * strip.h));
  const row = Array.from({ length: strip.w }, (_, x) => {
    // a few rows averaged (noise, a finger)
    let s = 0;
    let n = 0;
    for (let yy = Math.max(0, y - 2); yy <= Math.min(strip.h - 1, y + 2); yy++) {
      s += strip.d[yy * strip.w + x];
      n++;
    }
    return s / n;
  });
  const sorted = [...row].sort((a, b) => a - b);
  const thr = (sorted[Math.floor(sorted.length * 0.15)] + sorted[Math.floor(sorted.length * 0.85)]) / 2;
  const out: number[] = [];
  let start = -1;
  for (let x = 0; x <= row.length; x++) {
    const dark = x < row.length && row[x] < thr;
    if (dark && start < 0) start = x;
    if (!dark && start >= 0) {
      const len = x - start;
      // a black key is about 0.6 of a white key wide: ignore specks and wide dark areas
      // (and dark areas touching the ends: the floor beyond the keyboard)
      if (len >= 2 && len < strip.w / 20 && start > 0 && x < row.length) out.push((start + x) / 2 / strip.w);
      start = -1;
    }
  }
  return out;
}

/** The key preset whose black-key count is nearest to what is seen. */
export function guessRange(strip: Gray, presets: KeyPreset[]): KeyPreset | null {
  const n = darkKeys(strip).length;
  if (n < 10) return null;
  let best: KeyPreset | null = null;
  let bd = Infinity;
  for (const p of presets) {
    let blacks = 0;
    for (let m = p.lo; m <= p.hi; m++) if (isBlack(m)) blacks++;
    const d = Math.abs(blacks - n);
    if (d < bd) {
      bd = d;
      best = p;
    }
  }
  return bd <= 4 ? best : null;
}

/** u of each black key's center for these edges */
export function blackCenters(cal: Pick<KeyboardCalibration, 'lo' | 'hi' | 'edgeL' | 'edgeR'>): number[] {
  const n = whitesBetween(cal.lo, cal.hi);
  const a = cal.edgeL;
  const b = n + cal.edgeR;
  const out: number[] = [];
  let wi = 0;
  for (let m = cal.lo; m <= cal.hi; m++) {
    if (!isBlack(m)) wi++;
    else out.push((wi + 0.6 * (BLACK_OFFSET[m % 12] ?? 0) - a) / (b - a));
  }
  return out;
}

/**
 * The fine match (edgeL, edgeR) that puts the predicted black keys on the dark keys found in `strip`
 * (searched within ±1.5 white keys on each side). null if too few dark keys are seen.
 */
export function autoMatch(strip: Gray, cal: Pick<KeyboardCalibration, 'lo' | 'hi'>): { edgeL: number; edgeR: number; score: number } | null {
  const found = darkKeys(strip);
  if (found.length < 6) return null;
  const n = whitesBetween(cal.lo, cal.hi);
  const sigma = 0.18 / n; // in u: a fifth of a white key
  const score = (edgeL: number, edgeR: number) => {
    const pred = blackCenters({ ...cal, edgeL, edgeR });
    let s = 0;
    let j = 0;
    for (const p of pred) {
      while (j + 1 < found.length && Math.abs(found[j + 1] - p) < Math.abs(found[j] - p)) j++;
      const d = (found[j] - p) / sigma;
      s += Math.exp(-d * d);
    }
    return s / pred.length;
  };
  let best = { edgeL: 0, edgeR: 0, score: -1 };
  // coarse, then fine
  for (let a = -1.5; a <= 1.5001; a += 0.05)
    for (let b = -1.5; b <= 1.5001; b += 0.05) {
      const s = score(a, b);
      if (s > best.score) best = { edgeL: a, edgeR: b, score: s };
    }
  const c = best;
  for (let a = c.edgeL - 0.05; a <= c.edgeL + 0.05; a += 0.01)
    for (let b = c.edgeR - 0.05; b <= c.edgeR + 0.05; b += 0.01) {
      const s = score(a, b);
      if (s > best.score) best = { edgeL: a, edgeR: b, score: s };
    }
  return { edgeL: Math.round(best.edgeL * 100) / 100, edgeR: Math.round(best.edgeR * 100) / 100, score: best.score };
}
