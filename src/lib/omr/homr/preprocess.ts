/**
 * Page preparation and the segmentation's output: ports of homr/autocrop.py, homr/resize.py,
 * homr/color_adjust.py, the patching of homr/segmentation/inference_segnet.py and
 * homr/noise_filtering.py.
 *
 * Derived from homr (AGPL-3.0, Copyright the homr contributors, https://github.com/liebharc/homr).
 */
import { boxBlur, clahe, dilate, erode, img, laplacianNoiseSum, rectKernel, resizePil, toGray, type Img } from './cv';
import { boundingRect, contourArea, convexHullIndices, findContours } from './geom';
import { median, pyRound } from './model';

// ------------------------------------------------------------------ autocrop

const MAX_CHROMA_DIFF = 0.07;

/** per-pixel chromaticity (c + 1) / sum(c + 1), float32 like numpy's */
function chroma(r: number, g: number, b: number): [number, number, number] {
  const f = Math.fround;
  const R = f(r + 1);
  const G = f(g + 1);
  const B = f(b + 1);
  const s = f(f(R + G) + B);
  return [f(R / s), f(G / s), f(B / s)];
}

function medianChroma(pixels: number[][]): [number, number, number] {
  const cs = pixels.map(([r, g, b]) => chroma(r, g, b));
  return [median(cs.map((c) => c[0])), median(cs.map((c) => c[1])), median(cs.map((c) => c[2]))];
}

function isPaper(im: Img, x0: number, y0: number, x1: number, y1: number, paper: [number, number, number]): boolean {
  const px: number[][] = [];
  for (let y = Math.max(0, y0); y < Math.min(im.h, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(im.w, x1); x++) {
      const o = (y * im.w + x) * 3;
      px.push([im.d[o], im.d[o + 1], im.d[o + 2]]);
    }
  if (!px.length) return true;
  const c = medianChroma(px);
  return Math.abs(c[0] - paper[0]) + Math.abs(c[1] - paper[1]) + Math.abs(c[2] - paper[2]) <= MAX_CHROMA_DIFF;
}

/** Fill a polygon (a convex hull) with 0 in a 0/1 mask. */
function fillConvex(mask: Img, poly: number[]): void {
  const n = poly.length / 2;
  for (let y = 0; y < mask.h; y++) {
    const xs: number[] = [];
    for (let k = 0; k < n; k++) {
      const ax = poly[2 * k];
      const ay = poly[2 * k + 1];
      const bx = poly[2 * ((k + 1) % n)];
      const by = poly[2 * ((k + 1) % n) + 1];
      if (ay === by) {
        if (ay === y) xs.push(ax, bx);
        continue;
      }
      if ((y >= ay && y <= by) || (y >= by && y <= ay)) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay));
    }
    if (!xs.length) continue;
    const a = Math.max(0, Math.ceil(Math.min(...xs) - 1e-9));
    const b = Math.min(mask.w - 1, Math.floor(Math.max(...xs) + 1e-9));
    for (let x = a; x <= b; x++) mask.d[y * mask.w + x] = 0;
  }
}

/**
 * homr autocrop_with_offset: crops a photo to the sheet of paper (the largest bright region) and
 * paints what is beside the sheet in the paper's color. Color images only (RGB); returns the crop
 * and its top left corner.
 */
export function autocrop(im: Img): { image: Img; x: number; y: number } {
  if (im.c !== 3) return { image: im, x: 0, y: 0 };
  const gray = toGray(im);
  // histogram of the first channel (cv2 BGR: blue = our channel 2)
  const hist = new Int32Array(256);
  for (let i = 0; i < im.w * im.h; i++) hist[im.d[3 * i + 2]]++;
  let dom = 0;
  for (let i = 1; i < 256; i++) if (hist[i] > hist[dom]) dom = i;
  const t = dom - 30;
  const thresh = img(im.w, im.h);
  for (let i = 0; i < gray.d.length; i++) thresh.d[i] = gray.d[i] > t ? 255 : 0;
  let morph = erode(dilate(thresh, rectKernel(7, 7)), rectKernel(7, 7));
  morph = erode(morph, rectKernel(9, 9));
  const contours = findContours(morph.d, morph.w, morph.h, 'external');
  let areaT = 0;
  let big: Int32Array | null = null;
  for (const c of contours) {
    const a = contourArea(c);
    if (a > areaT) (areaT = a), (big = c);
  }
  if (!big) return { image: im, x: 0, y: 0 };
  const [x, y, w, h] = boundingRect(big);
  const W = im.w;
  const H = im.h;
  if (w < W * 0.25 || h < H * 0.25) return { image: im, x: 0, y: 0 };
  // a sample of the paper: thresholded pixels in the box, every 10th
  const paper: number[][] = [];
  let k = 0;
  for (let yy = y; yy < y + h; yy++)
    for (let xx = x; xx < x + w; xx++) {
      if (thresh.d[yy * W + xx] > 0) {
        if (k % 10 === 0) {
          const o = (yy * W + xx) * 3;
          paper.push([im.d[o], im.d[o + 1], im.d[o + 2]]);
        }
        k++;
      }
    }
  if (!paper.length) return { image: im, x: 0, y: 0 };
  const pc = medianChroma(paper);
  const margin = Math.max(5, Math.floor(Math.max(W, H) / 100));
  const x0 = Math.max(0, x - margin);
  const y0 = Math.max(0, y - margin);
  const x1 = Math.min(W, x + w + margin);
  const y1 = Math.min(H, y + h + margin);
  const bw = x1 - x0;
  const bh = y1 - y0;
  // keep the sides where the strip beside the box is paper
  const left = isPaper(im, 0, y0, x0, y0 + bh, pc) ? 0 : x0;
  const top = isPaper(im, x0, 0, x0 + bw, y0, pc) ? 0 : y0;
  const right = isPaper(im, x0 + bw, y0, W, y0 + bh, pc) ? W : x0 + bw;
  const bottom = isPaper(im, x0, y0 + bh, x0 + bw, H, pc) ? H : y0 + bh;
  const cx = left;
  const cy = top;
  const cw = right - left;
  const ch = bottom - top;
  if (cx === 0 && cy === 0 && cw === W && ch === H) return { image: im, x: 0, y: 0 };
  const crop = img(cw, ch, 3);
  for (let yy = 0; yy < ch; yy++) crop.d.set(im.d.subarray(((yy + cy) * W + cx) * 3, ((yy + cy) * W + cx + cw) * 3), yy * cw * 3);
  // remove what is beside the sheet
  const beside = img(cw, ch, 1, 1);
  const shifted = new Int32Array(big.length);
  for (let i = 0; i < big.length; i += 2) {
    shifted[i] = big[i] - cx;
    shifted[i + 1] = big[i + 1] - cy;
  }
  const hull = convexHullIndices(shifted).flatMap((i) => [shifted[2 * i], shifted[2 * i + 1]]);
  fillConvex(beside, hull);
  const paperColor = [0, 1, 2].map((c) => median(paper.map((p) => p[c])));
  const smooth = boxBlur(crop, 7);
  const meanPaper = (paperColor[0] + paperColor[1] + paperColor[2]) / 3;
  const bg = img(cw, ch);
  for (let i = 0; i < cw * ch; i++) {
    const r = smooth.d[3 * i];
    const g = smooth.d[3 * i + 1];
    const b = smooth.d[3 * i + 2];
    const c = chroma(r, g, b);
    const diff = Math.abs(c[0] - pc[0]) + Math.abs(c[1] - pc[1]) + Math.abs(c[2] - pc[2]);
    const bright = (r + g + b) / 3 > 0.25 * meanPaper;
    bg.d[i] = beside.d[i] && bright && diff > MAX_CHROMA_DIFF ? 1 : 0;
  }
  const bgd = dilate(bg, rectKernel(5, 5));
  const pcol = paperColor.map((v) => Math.trunc(v));
  for (let i = 0; i < cw * ch; i++) {
    if (bgd.d[i] && beside.d[i]) {
      crop.d[3 * i] = pcol[0];
      crop.d[3 * i + 1] = pcol[1];
      crop.d[3 * i + 2] = pcol[2];
    }
  }
  return { image: crop, x: cx, y: cy };
}

// ------------------------------------------------------------------ resize, CLAHE

export const TARGET_WIDTH = 1920;

/** homr resize_image: to 1920 px wide with Pillow's bicubic filter */
export function resizeToTarget(im: Img): Img {
  if (im.w === TARGET_WIDTH) return im;
  const h = pyRound(im.h * (TARGET_WIDTH / im.w));
  return resizePil(im, TARGET_WIDTH, h);
}

/** homr apply_clahe: gray, CLAHE (clip 1, 8 x 8 tiles) */
export function preprocess(im: Img): Img {
  return clahe(toGray(im), 1, 8);
}

// ------------------------------------------------------------------ segmentation patches

export const WIN = 320;
export const STEP = 320;

/** Top-left corners of homr's segmentation windows (step 320 = the window: no overlap except at the edges). */
export function patchOrigins(w: number, h: number): [number, number][] {
  const out: [number, number][] = [];
  for (let yl = 0; yl < Math.max(h, WIN); yl += STEP) {
    const y = Math.min(yl, h - WIN);
    for (let xl = 0; xl < Math.max(w, WIN); xl += STEP) out.push([Math.min(xl, w - WIN), y]);
  }
  return out;
}

/** One window of the CLAHE page as the segmentation input [3, 320, 320] (gray in every channel, 0..255; white beyond the page). */
export function extractPatch(page: Img, x: number, y: number, out: Float32Array): void {
  const plane = WIN * WIN;
  out.fill(255, 0, 3 * plane);
  const y0 = Math.max(y, 0);
  const x0 = Math.max(x, 0);
  const y1 = Math.min(y + WIN, page.h);
  const x1 = Math.min(x + WIN, page.w);
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const v = page.d[yy * page.w + xx];
      const o = (yy - y0) * WIN + (xx - x0);
      out[o] = v;
      out[plane + o] = v;
      out[2 * plane + o] = v;
    }
  }
}

/**
 * homr merge_patches on the per-window class maps (argmax): where windows overlap the class
 * numbers are averaged and truncated, as homr does.
 */
export class PatchMerger {
  sum: Float32Array;
  weight: Uint8Array;
  constructor(
    public w: number,
    public h: number,
  ) {
    this.sum = new Float32Array(w * h);
    this.weight = new Uint8Array(w * h);
  }

  add(x: number, y: number, classes: Uint8Array): void {
    const y0 = Math.max(y, 0);
    const y1 = Math.min(y + WIN, this.h);
    const x0 = Math.max(x, 0);
    const x1 = Math.min(x + WIN, this.w);
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const o = yy * this.w + xx;
        this.sum[o] += classes[(yy - y0) * WIN + (xx - x0)];
        this.weight[o]++;
      }
    }
  }

  /** class per pixel (0 background, 1 stems/rests, 2 noteheads, 3 clefs/keys, 4 staff lines, 5 other symbols) */
  classes(): Uint8Array {
    const out = new Uint8Array(this.w * this.h);
    const f = Math.fround;
    for (let i = 0; i < out.length; i++) {
      const wgt = this.weight[i] || 1;
      out[i] = Math.trunc(f(this.sum[i] / wgt));
    }
    return out;
  }
}

/** argmax over the 6 class planes of one window of the segmentation output */
export function argmaxClasses(logits: Float32Array | Uint16Array, offset: number, out: Uint8Array, half = false): void {
  const plane = WIN * WIN;
  const read = half ? halfToFloat : (v: number) => v;
  for (let i = 0; i < plane; i++) {
    let best = 0;
    let bv = read(logits[offset + i]);
    for (let c = 1; c < 6; c++) {
      const v = read(logits[offset + c * plane + i]);
      if (v > bv) (bv = v), (best = c);
    }
    out[i] = best;
  }
}

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

export interface Predictions {
  w: number;
  h: number;
  stemsRest: Img;
  notehead: Img;
  clefsKeys: Img;
  staff: Img;
  symbols: Img;
}

/** Class map → the five 0/1 masks of homr's InputPredictions. */
export function masksFromClasses(cls: Uint8Array, w: number, h: number): Predictions {
  const m = (k: number) => {
    const o = img(w, h);
    for (let i = 0; i < cls.length; i++) o.d[i] = cls[i] === k ? 1 : 0;
    return o;
  };
  return { w, h, stemsRest: m(1), notehead: m(2), clefsKeys: m(3), staff: m(4), symbols: m(5) };
}

// ------------------------------------------------------------------ noise filtering

const NOISE_LIMIT = 50;

/**
 * homr filter_predictions: where the staff-line mask is noisy (cells of a 20 x 20 grid whose
 * Laplacian is high, next to another such cell) all masks are cleared, unless that is over half the
 * page. Returns the cells' mask (1 = keep) or null (nothing to filter).
 */
export function noiseMask(staff: Img): Uint8Array | null {
  const { w, h } = staff;
  const M = Math.floor(h / 20);
  const N = Math.floor(w / 20);
  if (M === 0 || N === 0) return null;
  const scaled: Img = { w, h, c: 1, d: new Uint8Array(staff.d.length) };
  for (let i = 0; i < staff.d.length; i++) scaled.d[i] = (255 * staff.d[i]) & 255;
  const gh = Math.ceil(h / M);
  const gw = Math.ceil(w / N);
  const grid = new Uint8Array(gh * gw);
  for (let i = 0, y = 0; y < h; y += M, i++) {
    for (let j = 0, x = 0; x < w; x += N, j++) {
      const th = Math.min(M, h - y);
      const tw = Math.min(N, w - x);
      const sigma = laplacianNoiseSum(scaled, x, y, tw, th) / (th * tw);
      grid[i * gw + j] = Math.trunc(sigma) & 255;
    }
  }
  const mask = new Uint8Array(w * h);
  let filtered = 0;
  let total = 0;
  for (let i = 0, y = 0; y < h; y += M, i++) {
    for (let j = 0, x = 0; x < w; x += N, j++) {
      const v = grid[i * gw + j];
      const nb: number[] = [];
      if (i > 0) nb.push(grid[(i - 1) * gw + j]);
      if (j > 0) nb.push(grid[i * gw + j - 1]);
      if (i < gh - 1) nb.push(grid[(i + 1) * gw + j]);
      if (j < gw - 1) nb.push(grid[i * gw + j + 1]);
      if (v > NOISE_LIMIT && nb.some((n) => n > NOISE_LIMIT)) filtered++;
      else for (let yy = y; yy < Math.min(y + M, h); yy++) mask.fill(1, yy * w + x, yy * w + Math.min(x + N, w));
      total++;
    }
  }
  if (filtered / total > 0.5) return null;
  if (filtered > 0) return mask;
  return null;
}

export function applyMask(im: Img, mask: Uint8Array): Img {
  const out = img(im.w, im.h, im.c);
  for (let i = 0; i < im.w * im.h; i++) if (mask[i]) for (let c = 0; c < im.c; c++) out.d[i * im.c + c] = im.d[i * im.c + c];
  return out;
}
