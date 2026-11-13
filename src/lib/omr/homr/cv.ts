/**
 * The OpenCV / Pillow image operations homr's pipeline uses, ported to TypeScript with the same
 * arithmetic (fixed point where OpenCV uses it): BGR→gray (15-bit fixed point), CLAHE, Pillow's bicubic resize, OpenCV's
 * INTER_LINEAR resize, thresholds, erosion / dilation with OpenCV's structuring elements, box blur,
 * the noise filter, warpAffine and fillConvexPoly. No OpenCV.js: these few operations are small.
 *
 * Derived from homr (AGPL-3.0, Copyright the homr contributors, https://github.com/liebharc/homr);
 * the algorithms follow OpenCV (Apache-2.0) and Pillow (MIT-CMU / HPND).
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

/** cv2.fillConvexPoly(mask, int points, value): the polygon including its outline. */
export function fillConvexPoly(dst: Img, pts: [number, number][], value: number): void {
  const { w, h } = dst;
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const [, y] of pts) (ymin = Math.min(ymin, y)), (ymax = Math.max(ymax, y));
  const lo = new Float64Array(Math.max(0, ymax - ymin + 1)).fill(Infinity);
  const hi = new Float64Array(Math.max(0, ymax - ymin + 1)).fill(-Infinity);
  const mark = (x: number, y: number) => {
    const i = y - ymin;
    if (x < lo[i]) lo[i] = x;
    if (x > hi[i]) hi[i] = x;
  };
  const n = pts.length;
  for (let k = 0; k < n; k++) {
    // the outline as 8-connected lines (Bresenham)
    let [x0, y0] = pts[k];
    const [x1, y1] = pts[(k + 1) % n];
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      mark(x0, y0);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) (err += dy), (x0 += sx);
      if (e2 <= dx) (err += dx), (y0 += sy);
    }
  }
  for (let y = Math.max(ymin, 0); y <= Math.min(ymax, h - 1); y++) {
    const i = y - ymin;
    const a = Math.max(0, lo[i]);
    const b = Math.min(w - 1, hi[i]);
    for (let x = a; x <= b; x++) dst.d[y * w + x] = value;
  }
}
