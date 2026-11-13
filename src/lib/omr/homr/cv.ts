// SPDX-License-Identifier: AGPL-3.0-only AND BSD-3-Clause AND Apache-2.0 AND MIT-CMU
// Modified (TypeScript port of homr 0.7.1) by the Piano2Vision contributors, 2026; see README.md here.
// Ports of OpenCV functions (LICENSE-OpenCV.txt here) and of Pillow's bicubic resampling (LICENSE-Pillow.txt
// here): their copyright notices and licenses are in those files.
/**
 * The OpenCV / Pillow image operations homr's pipeline uses, ported to TypeScript with the same
 * arithmetic (fixed point where OpenCV uses it): BGR→gray (15-bit fixed point), CLAHE, Pillow's bicubic resize, OpenCV's
 * INTER_LINEAR resize, thresholds, erosion / dilation with OpenCV's structuring elements, box blur,
 * the noise filter, warpAffine, fillPoly and fillConvexPoly. No OpenCV.js: these few operations are small.
 *
 * Derived from homr (AGPL-3.0, Copyright the homr contributors, https://github.com/liebharc/homr);
 * the algorithms follow OpenCV (3-clause BSD / Apache-2.0, LICENSE-OpenCV.txt) and Pillow (MIT-CMU, LICENSE-Pillow.txt).
 * tests/unit/homr/cv.test.ts compares them with cv2 / Pillow.
 */
import { cvRound } from './geom';

const f = Math.fround;

/** An 8-bit image, channels interleaved (c = 1 gray, c = 3 color). */
export interface Img {
  w: number;
  h: number;
  c: number;
  d: Uint8Array;
}

export function img(w: number, h: number, c = 1, fill = 0): Img {
  const d = new Uint8Array(w * h * c);
  if (fill) d.fill(fill);
  return { w, h, c, d };
}

/** Color (R, G, B order) → gray like cv2.cvtColor(bgr, COLOR_BGR2GRAY) (fixed point, 15 bits). */
export function toGray(src: Img): Img {
  if (src.c === 1) return src;
  const out = img(src.w, src.h, 1);
  const n = src.w * src.h;
  const s = src.d;
  for (let i = 0; i < n; i++) {
    const r = s[3 * i];
    const g = s[3 * i + 1];
    const b = s[3 * i + 2];
    out.d[i] = (r * 9798 + g * 19235 + b * 3735 + 16384) >> 15;
  }
  return out;
}

/** RGBA (canvas ImageData) → RGB image. */
export function fromRGBA(data: Uint8ClampedArray | Uint8Array, w: number, h: number): Img {
  const out = img(w, h, 3);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    out.d[3 * i] = data[j];
    out.d[3 * i + 1] = data[j + 1];
    out.d[3 * i + 2] = data[j + 2];
  }
  return out;
}

// ------------------------------------------------------------------ Pillow bicubic resize

function bicubic(x: number): number {
  const a = -0.5;
  if (x < 0) x = -x;
  if (x < 1) return ((a + 2) * x - (a + 3)) * x * x + 1;
  if (x < 2) return (((x - 5) * x + 8) * x - 4) * a;
  return 0;
}

const PRECISION_BITS = 32 - 8 - 2;

function pilCoeffs(inSize: number, outSize: number): { bounds: Int32Array; kk: Int32Array; ksize: number } {
  const scale = inSize / outSize;
  const filterscale = Math.max(scale, 1);
  const support = 2 * filterscale;
  const ksize = Math.ceil(support) * 2 + 1;
  const bounds = new Int32Array(outSize * 2);
  const kk = new Int32Array(outSize * ksize);
  const k = new Float64Array(ksize);
  for (let xx = 0; xx < outSize; xx++) {
    const center = (xx + 0.5) * scale;
    let ww = 0;
    const ss = 1 / filterscale;
    let xmin = Math.trunc(center - support + 0.5);
    if (xmin < 0) xmin = 0;
    let xmax = Math.trunc(center + support + 0.5);
    if (xmax > inSize) xmax = inSize;
    xmax -= xmin;
    for (let x = 0; x < xmax; x++) {
      const w = bicubic((x + xmin - center + 0.5) * ss);
      k[x] = w;
      ww += w;
    }
    for (let x = 0; x < xmax; x++) if (ww !== 0) k[x] /= ww;
    for (let x = 0; x < ksize; x++) {
      const v = x < xmax ? k[x] : 0;
      kk[xx * ksize + x] = v < 0 ? Math.trunc(-0.5 + v * (1 << PRECISION_BITS)) : Math.trunc(0.5 + v * (1 << PRECISION_BITS));
    }
    bounds[2 * xx] = xmin;
    bounds[2 * xx + 1] = xmax;
  }
  return { bounds, kk, ksize };
}

const clip8 = (v: number) => {
  const r = v >> PRECISION_BITS;
  return r < 0 ? 0 : r > 255 ? 255 : r;
};

/** PIL.Image.resize((tw, th)) with its default BICUBIC filter (8-bit, horizontal pass first). */
export function resizePil(src: Img, tw: number, th: number): Img {
  const { w, h, c } = src;
  const H = pilCoeffs(w, tw);
  const V = pilCoeffs(h, th);
  // rows of the source the vertical pass needs
  const yFirst = V.bounds[0];
  const yLast = V.bounds[2 * (th - 1)] + V.bounds[2 * (th - 1) + 1];
  const tmpH = yLast - yFirst;
  const tmp = new Uint8Array(tw * tmpH * c);
  const half = 1 << (PRECISION_BITS - 1);
  const needH = tw !== w;
  if (needH) {
    for (let y = 0; y < tmpH; y++) {
      const srow = (y + yFirst) * w * c;
      const drow = y * tw * c;
      for (let x = 0; x < tw; x++) {
        const xmin = H.bounds[2 * x];
        const xmax = H.bounds[2 * x + 1];
        const ko = x * H.ksize;
        for (let ch = 0; ch < c; ch++) {
          let ss = half;
          for (let i = 0; i < xmax; i++) ss += src.d[srow + (i + xmin) * c + ch] * H.kk[ko + i];
          tmp[drow + x * c + ch] = clip8(ss);
        }
      }
    }
  } else {
    tmp.set(src.d.subarray(yFirst * w * c, yLast * w * c));
  }
  if (th === h && yFirst === 0) return { w: tw, h: th, c, d: tmp.length === tw * th * c ? tmp : tmp.slice(0, tw * th * c) };
  const out = img(tw, th, c);
  for (let y = 0; y < th; y++) {
    const ymin = V.bounds[2 * y] - yFirst;
    const ymax = V.bounds[2 * y + 1];
    const ko = y * V.ksize;
    const drow = y * tw * c;
    for (let x = 0; x < tw * c; x++) {
      let ss = half;
      for (let i = 0; i < ymax; i++) ss += tmp[(i + ymin) * tw * c + x] * V.kk[ko + i];
      out.d[drow + x] = clip8(ss);
    }
  }
  return out;
}

// ------------------------------------------------------------------ OpenCV INTER_LINEAR resize (8-bit)

const RESIZE_BITS = 11;
const RESIZE_SCALE = 1 << RESIZE_BITS;

/** cv2.resize(src, (tw, th)) with the default INTER_LINEAR, 8-bit gray or color. */
export function resizeLinear(src: Img, tw: number, th: number): Img {
  const { w, h, c } = src;
  if (tw === w && th === h) return { w, h, c, d: src.d.slice() };
  const scaleX = 1 / (tw / w);
  const scaleY = 1 / (th / h);
  const xofs = new Int32Array(tw);
  const ialpha = new Int32Array(tw * 2);
  let xmax = tw;
  for (let dx = 0; dx < tw; dx++) {
    let fx = f((dx + 0.5) * scaleX - 0.5);
    let sx = Math.floor(fx);
    fx = f(fx - sx);
    if (sx < 0) (fx = 0), (sx = 0);
    if (sx + 1 >= w) {
      xmax = Math.min(xmax, dx);
      if (sx >= w - 1) (fx = 0), (sx = w - 1);
    }
    xofs[dx] = sx;
    ialpha[2 * dx] = cvRound(f(1 - fx) * RESIZE_SCALE);
    ialpha[2 * dx + 1] = cvRound(fx * RESIZE_SCALE);
  }
  const width = tw * c;
  // the rows of horizontally resized values (int), cached per source row
  const rowCache = new Map<number, Int32Array>();
  const hrow = (sy: number): Int32Array => {
    let r = rowCache.get(sy);
    if (r) return r;
    r = new Int32Array(width);
    const s = sy * w * c;
    for (let dx = 0; dx < tw; dx++) {
      const sx = xofs[dx];
      for (let ch = 0; ch < c; ch++) {
        if (dx < xmax) r[dx * c + ch] = src.d[s + sx * c + ch] * ialpha[2 * dx] + src.d[s + (sx + 1) * c + ch] * ialpha[2 * dx + 1];
        else r[dx * c + ch] = src.d[s + sx * c + ch] * RESIZE_SCALE;
      }
    }
    if (rowCache.size > 4) rowCache.delete(rowCache.keys().next().value as number);
    rowCache.set(sy, r);
    return r;
  };
  // the vertical pass rounds in 16 bits like OpenCV's uchar specialisation of VResizeLinear
  const out = img(tw, th, c);
  for (let dy = 0; dy < th; dy++) {
    let fy = f((dy + 0.5) * scaleY - 0.5);
    const sy = Math.floor(fy);
    fy = f(fy - sy);
    const b0 = cvRound(f(1 - fy) * RESIZE_SCALE);
    const b1 = cvRound(fy * RESIZE_SCALE);
    const S0 = hrow(Math.min(Math.max(sy, 0), h - 1));
    const S1 = hrow(Math.min(Math.max(sy + 1, 0), h - 1));
    const o = dy * width;
    for (let x = 0; x < width; x++) {
      const v = ((((S0[x] >> 4) * b0) >> 16) + (((S1[x] >> 4) * b1) >> 16) + 2) >> 2;
      out.d[o + x] = v & 255;
    }
  }
  return out;
}

// ------------------------------------------------------------------ CLAHE

/** cv2.createCLAHE(clipLimit, tileGridSize=(tiles, tiles)).apply(gray) */
export function clahe(src: Img, clipLimitIn = 1, tiles = 8): Img {
  const { w, h } = src;
  let ext = src;
  if (w % tiles !== 0 || h % tiles !== 0) {
    // BORDER_REFLECT_101 to the right and bottom; OpenCV pads both sides by tiles - size % tiles, a
    // dimension that is already a multiple included (by a whole tile)
    const pw = tiles - (w % tiles);
    const ph = tiles - (h % tiles);
    const refl = (i: number, n: number) => (i < n ? i : 2 * n - 2 - i);
    ext = img(w + pw, h + ph);
    for (let y = 0; y < h + ph; y++) {
      const sy = refl(y, h);
      for (let x = 0; x < w + pw; x++) ext.d[y * (w + pw) + x] = src.d[sy * w + refl(x, w)];
    }
  }
  const tw = Math.trunc(ext.w / tiles);
  const th = Math.trunc(ext.h / tiles);
  const total = tw * th;
  const lutScale = f(255 / total);
  let clipLimit = 0;
  if (clipLimitIn > 0) clipLimit = Math.max(Math.trunc((clipLimitIn * total) / 256), 1);
  const lut = new Uint8Array(tiles * tiles * 256);
  const hist = new Int32Array(256);
  for (let k = 0; k < tiles * tiles; k++) {
    const ty = Math.trunc(k / tiles);
    const tx = k % tiles;
    hist.fill(0);
    for (let y = ty * th; y < (ty + 1) * th; y++) {
      const row = y * ext.w;
      for (let x = tx * tw; x < (tx + 1) * tw; x++) hist[ext.d[row + x]]++;
    }
    if (clipLimit > 0) {
      let clipped = 0;
      for (let i = 0; i < 256; i++) {
        if (hist[i] > clipLimit) {
          clipped += hist[i] - clipLimit;
          hist[i] = clipLimit;
        }
      }
      const batch = Math.trunc(clipped / 256);
      let residual = clipped - batch * 256;
      for (let i = 0; i < 256; i++) hist[i] += batch;
      if (residual !== 0) {
        const step = Math.max(Math.trunc(256 / residual), 1);
        for (let i = 0; i < 256 && residual > 0; i += step, residual--) hist[i]++;
      }
    }
    let sum = 0;
    for (let i = 0; i < 256; i++) {
      sum += hist[i];
      const v = cvRound(f(sum * lutScale));
      lut[k * 256 + i] = v > 255 ? 255 : v;
    }
  }
  const out = img(w, h);
  const invTw = f(1 / tw);
  const invTh = f(1 / th);
  const ind1 = new Int32Array(w);
  const ind2 = new Int32Array(w);
  const xa = new Float32Array(w);
  const xa1 = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const txf = f(f(x * invTw) - 0.5);
    let tx1 = Math.floor(txf);
    let tx2 = tx1 + 1;
    xa[x] = f(txf - tx1);
    xa1[x] = f(1 - xa[x]);
    tx1 = Math.max(tx1, 0);
    tx2 = Math.min(tx2, tiles - 1);
    ind1[x] = tx1 * 256;
    ind2[x] = tx2 * 256;
  }
  for (let y = 0; y < h; y++) {
    const tyf = f(f(y * invTh) - 0.5);
    let ty1 = Math.floor(tyf);
    let ty2 = ty1 + 1;
    const ya = f(tyf - ty1);
    const ya1 = f(1 - ya);
    ty1 = Math.max(ty1, 0);
    ty2 = Math.min(ty2, tiles - 1);
    const p1 = ty1 * tiles * 256;
    const p2 = ty2 * tiles * 256;
    for (let x = 0; x < w; x++) {
      const v = src.d[y * w + x];
      const a = f(f(f(lut[p1 + ind1[x] + v] * xa1[x]) + f(lut[p1 + ind2[x] + v] * xa[x])) * ya1);
      const b = f(f(f(lut[p2 + ind1[x] + v] * xa1[x]) + f(lut[p2 + ind2[x] + v] * xa[x])) * ya);
      const r = cvRound(f(a + b));
      out.d[y * w + x] = r < 0 ? 0 : r > 255 ? 255 : r;
    }
  }
  return out;
}

// ------------------------------------------------------------------ morphology

export interface Kernel {
  w: number;
  h: number;
  m: Uint8Array;
}

/** cv2.getStructuringElement(MORPH_ELLIPSE | MORPH_RECT, (w, h)) */
export function structuringElement(shape: 'ellipse' | 'rect', w: number, h: number): Kernel {
  const m = new Uint8Array(w * h);
  if (w === 1 && h === 1) shape = 'rect';
  const r = Math.trunc(h / 2);
  const c = Math.trunc(w / 2);
  const invR2 = r ? 1 / (r * r) : 0;
  for (let i = 0; i < h; i++) {
    let j1 = 0;
    let j2 = 0;
    if (shape === 'rect') j2 = w;
    else {
      const dy = i - r;
      if (Math.abs(dy) <= r) {
        const dx = cvRound(c * Math.sqrt((r * r - dy * dy) * invR2));
        j1 = Math.max(c - dx, 0);
        j2 = Math.min(c + dx + 1, w);
      }
    }
    for (let j = j1; j < j2; j++) m[i * w + j] = 1;
  }
  return { w, h, m };
}

function morph(src: Img, k: Kernel, dilate: boolean): Img {
  const { w, h } = src;
  const ax = Math.trunc(k.w / 2);
  const ay = Math.trunc(k.h / 2);
  const offs: [number, number][] = [];
  for (let i = 0; i < k.h; i++) for (let j = 0; j < k.w; j++) if (k.m[i * k.w + j]) offs.push([j - ax, i - ay]);
  const out = img(w, h);
  const s = src.d;
  // separable when the kernel is a full rectangle
  const full = offs.length === k.w * k.h;
  if (full) {
    const tmp = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = dilate ? 0 : 255;
        for (let j = 0; j < k.w; j++) {
          const xx = x + j - ax;
          if (xx < 0 || xx >= w) continue;
          const p = s[y * w + xx];
          v = dilate ? (p > v ? p : v) : p < v ? p : v;
        }
        tmp[y * w + x] = v;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = dilate ? 0 : 255;
        for (let i = 0; i < k.h; i++) {
          const yy = y + i - ay;
          if (yy < 0 || yy >= h) continue;
          const p = tmp[yy * w + x];
          v = dilate ? (p > v ? p : v) : p < v ? p : v;
        }
        out.d[y * w + x] = v;
      }
    }
    return out;
  }
  // row runs of the kernel: for each kernel row, the [j0, j1) columns (ellipse rows are runs)
  const runs: [number, number, number][] = [];
  for (let i = 0; i < k.h; i++) {
    let j0 = -1;
    let j1 = -1;
    for (let j = 0; j < k.w; j++) if (k.m[i * k.w + j]) (j0 = j0 < 0 ? j : j0), (j1 = j + 1);
    if (j0 >= 0) runs.push([i - ay, j0 - ax, j1 - ax]);
  }
  // per run width: horizontal running max/min, then combine rows
  const cache = new Map<string, Uint8Array>();
  const horiz = (a: number, b: number): Uint8Array => {
    const key = `${a},${b}`;
    let r = cache.get(key);
    if (r) return r;
    r = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let v = dilate ? 0 : 255;
        const x0 = Math.max(0, x + a);
        const x1 = Math.min(w, x + b);
        for (let xx = x0; xx < x1; xx++) {
          const p = s[y * w + xx];
          v = dilate ? (p > v ? p : v) : p < v ? p : v;
        }
        r[y * w + x] = v;
      }
    }
    cache.set(key, r);
    return r;
  };
  out.d.fill(dilate ? 0 : 255);
  for (const [dy, a, b] of runs) {
    const r = horiz(a, b);
    for (let y = 0; y < h; y++) {
      const yy = y + dy;
      if (yy < 0 || yy >= h) continue;
      for (let x = 0; x < w; x++) {
        const p = r[yy * w + x];
        const o = y * w + x;
        if (dilate ? p > out.d[o] : p < out.d[o]) out.d[o] = p;
      }
    }
  }
  return out;
}

/** cv2.dilate (default anchor and border: the border never adds to the maximum) */
export const dilate = (src: Img, k: Kernel) => morph(src, k, true);
/** cv2.erode */
export const erode = (src: Img, k: Kernel) => morph(src, k, false);

export function rectKernel(w: number, h: number): Kernel {
  return { w, h, m: new Uint8Array(w * h).fill(1) };
}

// ------------------------------------------------------------------ misc

/** cv2.blur(src, (k, k)) with BORDER_REFLECT_101 (any channels). */
export function boxBlur(src: Img, k: number): Img {
  const { w, h, c } = src;
  const a = Math.trunc(k / 2);
  const refl = (i: number, n: number) => {
    if (n === 1) return 0;
    while (i < 0 || i >= n) i = i < 0 ? -i : 2 * n - 2 - i;
    return i;
  };
  const tmp = new Int32Array(w * h * c);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let ch = 0; ch < c; ch++) {
        let s = 0;
        for (let j = -a; j < k - a; j++) s += src.d[(y * w + refl(x + j, w)) * c + ch];
        tmp[(y * w + x) * c + ch] = s;
      }
    }
  }
  const out = img(w, h, c);
  const scale = 1 / (k * k);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let ch = 0; ch < c; ch++) {
        let s = 0;
        for (let i = -a; i < k - a; i++) s += tmp[(refl(y + i, h) * w + x) * c + ch];
        const v = cvRound(s * scale);
        out.d[(y * w + x) * c + ch] = v > 255 ? 255 : v;
      }
    }
  }
  return out;
}

/**
 * sum(|filter2D(tile, CV_64F, [[1,-2,1],[-2,4,-2],[1,-2,1]])|) over a tile of a gray image
 * (BORDER_REFLECT_101 inside the tile, as the tile is its own array in Python).
 */
export function laplacianNoiseSum(src: Img, x0: number, y0: number, tw: number, th: number): number {
  const w = Math.min(tw, src.w - x0);
  const h = Math.min(th, src.h - y0);
  const refl = (i: number, n: number) => (n === 1 ? 0 : i < 0 ? -i : i >= n ? 2 * n - 2 - i : i);
  const K = [1, -2, 1, -2, 4, -2, 1, -2, 1];
  let sum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let i = -1; i <= 1; i++) {
        const yy = refl(y + i, h) + y0;
        for (let j = -1; j <= 1; j++) v += K[(i + 1) * 3 + j + 1] * src.d[yy * src.w + refl(x + j, w) + x0];
      }
      sum += Math.abs(v);
    }
  }
  return sum;
}

/** Mask of `v > t` as 0/1 (cv2.threshold(..., t, 1, THRESH_BINARY)). */
export function threshold(src: Img, t: number, maxval = 1): Img {
  const out = img(src.w, src.h);
  for (let i = 0; i < src.d.length; i++) out.d[i] = src.d[i] > t ? maxval : 0;
  return out;
}

/**
 * cv2.warpAffine(src, M, (w, h), flags=INTER_LINEAR, borderMode=BORDER_CONSTANT, borderValue)
 * for 8-bit gray, with OpenCV's fixed point (10-bit coordinates, 5-bit sub-pixel steps, 15-bit weights).
 */
export function warpAffine(src: Img, M: number[], w: number, h: number, borderValue: number): Img {
  const AB_BITS = 10;
  const AB_SCALE = 1 << AB_BITS;
  const INTER_BITS = 5;
  const TAB = 1 << INTER_BITS;
  const roundDelta = AB_SCALE / TAB / 2;
  // invert M (OpenCV maps destination pixels to the source)
  const [a, b, c, d, e, g] = M;
  let D = a * e - b * d;
  D = D !== 0 ? 1 / D : 0;
  const A11 = e * D;
  const A22 = a * D;
  const A12 = -b * D;
  const A21 = -d * D;
  const b1 = -A11 * c - A12 * g;
  const b2 = -A21 * c - A22 * g;
  const out = img(w, h);
  const adelta = new Int32Array(w);
  const bdelta = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    adelta[x] = cvRound(A11 * x * AB_SCALE);
    bdelta[x] = cvRound(A21 * x * AB_SCALE);
  }
  const wt = bilinearTab();
  const sw = src.w;
  const sh = src.h;
  for (let y = 0; y < h; y++) {
    const X0 = cvRound((A12 * y + b1) * AB_SCALE) + roundDelta;
    const Y0 = cvRound((A22 * y + b2) * AB_SCALE) + roundDelta;
    for (let x = 0; x < w; x++) {
      const X = (X0 + adelta[x]) >> (AB_BITS - INTER_BITS);
      const Y = (Y0 + bdelta[x]) >> (AB_BITS - INTER_BITS);
      const sx = X >> INTER_BITS;
      const sy = Y >> INTER_BITS;
      const alpha = (Y & (TAB - 1)) * TAB + (X & (TAB - 1));
      const px = (xx: number, yy: number) => (xx >= 0 && yy >= 0 && xx < sw && yy < sh ? src.d[yy * sw + xx] : borderValue);
      let v: number;
      if (sx >= 0 && sy >= 0 && sx + 1 < sw && sy + 1 < sh) {
        const o = sy * sw + sx;
        v = src.d[o] * wt[alpha * 4] + src.d[o + 1] * wt[alpha * 4 + 1] + src.d[o + sw] * wt[alpha * 4 + 2] + src.d[o + sw + 1] * wt[alpha * 4 + 3];
      } else if (sx >= sw || sx + 1 < 0 || sy >= sh || sy + 1 < 0) {
        out.d[y * w + x] = borderValue;
        continue;
      } else {
        v = px(sx, sy) * wt[alpha * 4] + px(sx + 1, sy) * wt[alpha * 4 + 1] + px(sx, sy + 1) * wt[alpha * 4 + 2] + px(sx + 1, sy + 1) * wt[alpha * 4 + 3];
      }
      const r = (v + (1 << 14)) >> 15;
      out.d[y * w + x] = r < 0 ? 0 : r > 255 ? 255 : r;
    }
  }
  return out;
}

let BILINEAR_TAB: Int32Array | null = null;
/** OpenCV's fixed-point bilinear weights for the 32 x 32 sub-pixel positions (sum 32768 each). */
function bilinearTab(): Int32Array {
  if (BILINEAR_TAB) return BILINEAR_TAB;
  const TAB = 32;
  const SCALE = 1 << 15;
  const tab = new Int32Array(TAB * TAB * 4);
  const lin = (x: number) => [f(1 - x), x];
  for (let i = 0; i < TAB; i++) {
    const vy = lin(f(i / TAB));
    for (let j = 0; j < TAB; j++) {
      const vx = lin(f(j / TAB));
      const w = [f(vy[0] * vx[0]), f(vy[0] * vx[1]), f(vy[1] * vx[0]), f(vy[1] * vx[1])];
      const iw = w.map((v) => cvRound(v * SCALE));
      let isum = iw[0] + iw[1] + iw[2] + iw[3];
      if (isum !== SCALE) {
        let mk1 = 0;
        let mk2 = 0;
        for (let k = 1; k < 4; k++) {
          if (iw[k] < iw[mk1]) mk1 = k;
          else if (iw[k] > iw[mk2]) mk2 = k;
        }
        if (isum < SCALE) iw[mk2] += SCALE - isum;
        else iw[mk1] -= isum - SCALE;
        isum = SCALE;
      }
      tab.set(iw, (i * TAB + j) * 4);
    }
  }
  BILINEAR_TAB = tab;
  return tab;
}

// ------------------------------------------------------------------ polygon filling (OpenCV 4.14 drawing.cpp)

const XY_SHIFT = 16;
const XY_ONE = 1 << XY_SHIFT;
/** int64 >> XY_SHIFT (arithmetic shift = floor) for the values here (< 2^53) */
const shr = (v: number) => Math.floor(v / XY_ONE);

/** cv::clipLine(Size, Point&, Point&): clips the segment to the image; false if it is outside. */
function clipLine(w: number, h: number, p: [number, number, number, number]): boolean {
  const right = w - 1;
  const bottom = h - 1;
  if (w <= 0 || h <= 0) return false;
  let [x1, y1, x2, y2] = p;
  let c1 = +(x1 < 0) + +(x1 > right) * 2 + +(y1 < 0) * 4 + +(y1 > bottom) * 8;
  let c2 = +(x2 < 0) + +(x2 > right) * 2 + +(y2 < 0) * 4 + +(y2 > bottom) * 8;
  if ((c1 & c2) === 0 && (c1 | c2) !== 0) {
    if (c1 & 12) {
      const a = c1 < 8 ? 0 : bottom;
      x1 += Math.trunc(((a - y1) * (x2 - x1)) / (y2 - y1));
      y1 = a;
      c1 = +(x1 < 0) + +(x1 > right) * 2;
    }
    if (c2 & 12) {
      const a = c2 < 8 ? 0 : bottom;
      x2 += Math.trunc(((a - y2) * (x2 - x1)) / (y2 - y1));
      y2 = a;
      c2 = +(x2 < 0) + +(x2 > right) * 2;
    }
    if ((c1 & c2) === 0 && (c1 | c2) !== 0) {
      if (c1) {
        const a = c1 === 1 ? 0 : right;
        y1 += Math.trunc(((a - x1) * (y2 - y1)) / (x2 - x1));
        x1 = a;
        c1 = 0;
      }
      if (c2) {
        const a = c2 === 1 ? 0 : right;
        y2 += Math.trunc(((a - x2) * (y2 - y1)) / (x2 - x1));
        x2 = a;
        c2 = 0;
      }
    }
  }
  p[0] = x1;
  p[1] = y1;
  p[2] = x2;
  p[3] = y2;
  return (c1 | c2) === 0;
}

/** cv::Line with 8-connectivity (LineIterator, left to right) on a one-channel image. */
function line8(dst: Img, ax: number, ay: number, bx: number, by: number, value: number): void {
  const { w, h } = dst;
  const p: [number, number, number, number] = [ax, ay, bx, by];
  if ((ax < 0 || ax >= w || bx < 0 || bx >= w || ay < 0 || ay >= h || by < 0 || by >= h) && !clipLine(w, h, p)) return;
  let [x, y, x2, y2] = p;
  let dx = x2 - x;
  let dy = y2 - y;
  let sx = 1;
  let sy = 1;
  if (dx < 0) {
    // leftToRight: start at the other end
    dx = -dx;
    dy = -dy;
    x = x2;
    y = y2;
  }
  if (dy < 0) {
    dy = -dy;
    sy = -1;
  }
  const vert = dy > dx;
  if (vert) [dx, dy, sx, sy] = [dy, dx, sy, sx];
  let err = dx - (dy + dy);
  const plusDelta = dx + dx;
  const minusDelta = -(dy + dy);
  // minus step: along the major axis; plus step (err < 0): also along the minor axis
  for (let i = 0; i <= dx; i++) {
    dst.d[y * w + x] = value;
    const plus = err < 0;
    err += minusDelta + (plus ? plusDelta : 0);
    if (vert) {
      y += sx;
      if (plus) x += sy;
    } else {
      x += sx;
      if (plus) y += sy;
    }
  }
}

/** cv2.fillConvexPoly(mask, int32 points, value) (LINE_8, shift 0): outline lines + span filling. */
export function fillConvexPoly(dst: Img, pts: [number, number][], value: number): void {
  const npts = pts.length;
  if (!npts) return;
  const { w, h } = dst;
  const delta1 = XY_ONE >> 1;
  const delta2 = XY_ONE >> 1;
  let imin = 0;
  let xmin = pts[0][0];
  let xmax = xmin;
  let ymin = pts[0][1];
  let ymax = ymin;
  let p0 = pts[npts - 1];
  for (let i = 0; i < npts; i++) {
    const p = pts[i];
    if (p[1] < ymin) (ymin = p[1]), (imin = i);
    ymax = Math.max(ymax, p[1]);
    xmax = Math.max(xmax, p[0]);
    xmin = Math.min(xmin, p[0]);
    line8(dst, p0[0], p0[1], p[0], p[1], value);
    p0 = p;
  }
  if (npts < 3 || xmax < 0 || ymax < 0 || xmin >= w || ymin >= h) return;
  ymax = Math.min(ymax, h - 1);
  const edge = [
    { idx: imin, di: 1, x: -XY_ONE, dx: 0, ye: ymin },
    { idx: imin, di: npts - 1, x: -XY_ONE, dx: 0, ye: ymin },
  ];
  let edges = npts;
  let y = ymin;
  do {
    for (let i = 0; i < 2; i++) {
      if (y >= edge[i].ye) {
        let idx0 = edge[i].idx;
        const di = edge[i].di;
        let idx = idx0 + di;
        if (idx >= npts) idx -= npts;
        for (; edges-- > 0; ) {
          const ty = pts[idx][1];
          if (ty > y) {
            const xs = pts[idx0][0] * XY_ONE;
            const xe = pts[idx][0] * XY_ONE;
            edge[i].ye = ty;
            edge[i].dx = Math.trunc(((xe - xs) * 2 + (ty - y)) / (2 * (ty - y)));
            edge[i].x = xs;
            edge[i].idx = idx;
            break;
          }
          idx0 = idx;
          idx += di;
          if (idx >= npts) idx -= npts;
        }
      }
    }
    if (edges < 0) break;
    if (y >= 0) {
      const [l, r] = edge[0].x > edge[1].x ? [1, 0] : [0, 1];
      let x1 = shr(edge[l].x + delta1);
      let x2 = shr(edge[r].x + delta2);
      if (x2 >= 0 && x1 < w) {
        if (x1 < 0) x1 = 0;
        if (x2 >= w) x2 = w - 1;
        dst.d.fill(value, y * w + x1, y * w + x2 + 1);
      }
    }
    edge[0].x += edge[0].dx;
    edge[1].x += edge[1].dx;
  } while (++y <= ymax);
}

interface PolyEdge {
  y0: number;
  y1: number;
  x: number;
  dx: number;
  next: PolyEdge | null;
}

/** cv2.fillPoly(mask, [int32 points], value) for one contour (LINE_8, shift 0): CollectPolyEdges + FillEdgeCollection. */
export function fillPoly(dst: Img, pts: [number, number][], value: number): void {
  const { w, h } = dst;
  const count = pts.length;
  if (!count) return;
  const edges: PolyEdge[] = [];
  let pt0 = [pts[count - 1][0] * XY_ONE, pts[count - 1][1]];
  for (let i = 0; i < count; i++) {
    const pt1 = [pts[i][0] * XY_ONE, pts[i][1]];
    const t: [number, number, number, number] = [shr(pt0[0] + (XY_ONE >> 1)), pt0[1], shr(pt1[0] + (XY_ONE >> 1)), pt1[1]];
    line8(dst, t[0], t[1], t[2], t[3], value);
    let c0y = pt0[1];
    let c1y = pt1[1];
    if (t[0] < 0 || t[0] >= w || t[2] < 0 || t[2] >= w || t[1] < 0 || t[1] >= h || t[3] < 0 || t[3] >= h) {
      clipLine(w, h, t);
      if (t[1] !== t[3]) (c0y = t[1]), (c1y = t[3]);
    }
    const c0x = t[0] * XY_ONE;
    const c1x = t[2] * XY_ONE;
    if (pt0[1] !== pt1[1]) {
      const dx = Math.trunc((c1x - c0x) / (c1y - c0y));
      if (pt0[1] < pt1[1]) edges.push({ y0: pt0[1], y1: pt1[1], x: c0x + (pt0[1] - c0y) * dx, dx, next: null });
      else edges.push({ y0: pt1[1], y1: pt0[1], x: c1x + (pt1[1] - c1y) * dx, dx, next: null });
    }
    pt0 = pt1;
  }
  fillEdgeCollection(dst, edges, value);
}

function fillEdgeCollection(dst: Img, edges: PolyEdge[], value: number): void {
  const { w, h } = dst;
  const total = edges.length;
  const delta = XY_ONE - 1;
  if (total < 2) return;
  let yMax = -Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let xMin = Infinity;
  for (const e1 of edges) {
    const x1 = e1.x + (e1.y1 - e1.y0) * e1.dx;
    yMin = Math.min(yMin, e1.y0);
    yMax = Math.max(yMax, e1.y1);
    xMin = Math.min(xMin, e1.x, x1);
    xMax = Math.max(xMax, e1.x, x1);
  }
  if (yMax < 0 || yMin >= h || xMax < 0 || xMin >= w * XY_ONE) return;
  // std::sort with CmpEdges (a strict order up to equal edges, so the sort's stability does not matter)
  edges.sort((a, b) => (a.y0 !== b.y0 ? a.y0 - b.y0 : a.x !== b.x ? a.x - b.x : a.dx - b.dx));
  const tmp: PolyEdge = { y0: Infinity, y1: 0, x: 0, dx: 0, next: null };
  edges.push(tmp);
  let i = 0;
  let e = edges[0];
  yMax = Math.min(yMax, h);
  for (let y = e.y0; y < yMax; y++) {
    let draw = false;
    const clip = y < 0;
    let prelast: PolyEdge = tmp;
    let last = tmp.next;
    let keep: PolyEdge;
    while (last || e.y0 === y) {
      if (last && last.y1 === y) {
        prelast.next = last.next;
        last = last.next;
        continue;
      }
      keep = prelast;
      if (last && (e.y0 > y || last.x < e.x)) {
        prelast = last;
        last = last.next;
      } else if (i < total) {
        prelast.next = e;
        e.next = last;
        prelast = e;
        e = edges[++i];
      } else break;
      if (draw) {
        if (!clip) {
          let x1: number;
          let x2: number;
          if (keep.x > prelast.x) (x1 = shr(prelast.x + delta)), (x2 = shr(keep.x));
          else (x1 = shr(keep.x + delta)), (x2 = shr(prelast.x));
          if (x1 < w && x2 >= 0) {
            if (x1 < 0) x1 = 0;
            if (x2 >= w) x2 = w - 1;
            if (x2 >= x1) dst.d.fill(value, y * w + x1, y * w + x2 + 1);
          }
        }
        keep.x += keep.dx;
        prelast.x += prelast.dx;
      }
      draw = !draw;
    }
    // bubble sort of the active edges by x
    let keepPrelast: PolyEdge | null = null;
    do {
      prelast = tmp;
      last = tmp.next;
      let lastExchange: PolyEdge | null = null;
      while (last !== keepPrelast && last && last.next) {
        const te: PolyEdge = last.next;
        if (last.x > te.x) {
          prelast.next = te;
          last.next = te.next;
          te.next = last;
          prelast = te;
          lastExchange = prelast;
        } else {
          prelast = last;
          last = te;
        }
      }
      if (!lastExchange) break;
      keepPrelast = lastExchange;
    } while (keepPrelast !== tmp.next && keepPrelast !== tmp);
  }
}
