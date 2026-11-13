/**
 * Small grayscale image toolkit for sheet-music reading (src/lib/omr). Pure TypeScript, no DOM, so it
 * runs in the OMR worker and in Node tests. Gray images are 8-bit, white paper = 255, ink near 0.
 *
 * The operations mirror the OpenCV calls of the research prototype (resize INTER_AREA, warpPerspective,
 * morphological close/open, adaptive mean threshold, Otsu) closely enough for staff finding; they are not
 * bit-exact.
 */

export interface Gray {
  w: number;
  h: number;
  /** row-major, w * h bytes */
  d: Uint8Array;
}

/** A page outline: top-left, top-right, bottom-right, bottom-left corners in image pixels. */
export type Quad = [[number, number], [number, number], [number, number], [number, number]];

export function gray(w: number, h: number, fill = 255): Gray {
  const d = new Uint8Array(w * h);
  if (fill) d.fill(fill);
  return { w, h, d };
}

/** RGBA (canvas ImageData layout) → gray, ITU-R BT.601 weights like OpenCV's BGR2GRAY. */
export function grayFromRGBA(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): Gray {
  const d = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < d.length; i++, j += 4) {
    // alpha-composite onto white (transparent PDF backgrounds)
    const a = rgba[j + 3];
    const v = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
    d[i] = a === 255 ? Math.round(v) : Math.round((v * a + 255 * (255 - a)) / 255);
  }
  return { w, h, d };
}

export function crop(img: Gray, x0: number, y0: number, x1: number, y1: number): Gray {
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(img.w, Math.ceil(x1));
  y1 = Math.min(img.h, Math.ceil(y1));
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  const d = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) d.set(img.d.subarray((y0 + y) * img.w + x0, (y0 + y) * img.w + x0 + w), y * w);
  return { w, h, d };
}

/** Pads with white to at least `minH` rows, centred vertically. */
export function padHeight(img: Gray, minH: number): Gray {
  if (img.h >= minH) return img;
  const out = gray(img.w, minH);
  const top = Math.floor((minH - img.h) / 2);
  out.d.set(img.d, top * img.w);
  return out;
}

// ------------------------------------------------------------------ resampling

/**
 * One axis of an area-averaging resample (each output sample is the mean of the input interval it
 * covers; enlarging falls back to linear interpolation).
 */
function resampleAxis(src: Float32Array, n: number, stride: number, count: number, lineStride: number, m: number, out: Float32Array, outStride: number, outLineStride: number) {
  const scale = n / m;
  if (scale <= 1) {
    for (let l = 0; l < count; l++) {
      const s0 = l * lineStride;
      const o0 = l * outLineStride;
      for (let i = 0; i < m; i++) {
        const x = Math.max(0, Math.min(n - 1, (i + 0.5) * scale - 0.5));
        const xi = Math.floor(x);
        const f = x - xi;
        const a = src[s0 + xi * stride];
        const b = src[s0 + Math.min(n - 1, xi + 1) * stride];
        out[o0 + i * outStride] = a + (b - a) * f;
      }
    }
    return;
  }
  for (let l = 0; l < count; l++) {
    const s0 = l * lineStride;
    const o0 = l * outLineStride;
    for (let i = 0; i < m; i++) {
      const a = i * scale;
      const b = a + scale;
      let sum = 0;
      let k = Math.floor(a);
      const kb = Math.min(n, Math.ceil(b));
      for (; k < kb; k++) {
        const lo = Math.max(a, k);
        const hi = Math.min(b, k + 1);
        sum += src[s0 + k * stride] * (hi - lo);
      }
      out[o0 + i * outStride] = sum / scale;
    }
  }
}

/** Resize to nw x nh: area averaging when shrinking (like INTER_AREA), linear when enlarging. */
export function resize(img: Gray, nw: number, nh: number): Gray {
  nw = Math.max(1, Math.round(nw));
  nh = Math.max(1, Math.round(nh));
  if (nw === img.w && nh === img.h) return { w: nw, h: nh, d: img.d.slice() };
  const src = new Float32Array(img.d);
  // horizontal: h rows of w → nw
  const tmp = new Float32Array(nw * img.h);
  resampleAxis(src, img.w, 1, img.h, img.w, nw, tmp, 1, nw);
  // vertical: nw columns of h → nh
  const out = new Float32Array(nw * nh);
  resampleAxis(tmp, img.h, nw, nw, 1, nh, out, nw, 1);
  const d = new Uint8Array(nw * nh);
  for (let i = 0; i < d.length; i++) d[i] = out[i] < 0 ? 0 : out[i] > 255 ? 255 : Math.round(out[i]);
  return { w: nw, h: nh, d };
}

// ------------------------------------------------------------------ geometry

/** 3x3 homography (row-major) mapping the 4 `from` points onto the 4 `to` points. */
export function homography(from: number[][], to: number[][]): number[] {
  // solve A h = b for h0..h7 (h8 = 1)
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solve(A, b);
  return [...h, 1];
}

/** Gaussian elimination with partial pivoting. */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / piv;
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / (r[i] || 1e-12));
}

/** Bilinear sample with white outside the image. */
function sample(img: Gray, x: number, y: number): number {
  if (x < -0.5 || y < -0.5 || x > img.w - 0.5 || y > img.h - 0.5) return 255;
  const xc = Math.max(0, Math.min(img.w - 1, x));
  const yc = Math.max(0, Math.min(img.h - 1, y));
  const x0 = Math.floor(xc);
  const y0 = Math.floor(yc);
  const x1 = Math.min(img.w - 1, x0 + 1);
  const y1 = Math.min(img.h - 1, y0 + 1);
  const fx = xc - x0;
  const fy = yc - y0;
  const d = img.d;
  const a = d[y0 * img.w + x0] + (d[y0 * img.w + x1] - d[y0 * img.w + x0]) * fx;
  const c = d[y1 * img.w + x0] + (d[y1 * img.w + x1] - d[y1 * img.w + x0]) * fx;
  return a + (c - a) * fy;
}

const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Cut the quadrilateral `quad` out of `img` and straighten it to a rectangle `outW` pixels wide (the
 * height follows the quad's aspect ratio). Large sources are first shrunk by area averaging so the
 * bilinear warp does not alias thin staff lines.
 */
export function warpQuad(img: Gray, quad: Quad, outW: number): Gray {
  const q = quad.map((p) => [p[0], p[1]]);
  const wq = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
  const hq = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2;
  let src = img;
  let s = 1;
  if (wq > 1.4 * outW) {
    s = (1.2 * outW) / wq;
    src = resize(img, img.w * s, img.h * s);
    s = src.w / img.w;
  }
  const outH = Math.max(1, Math.round((outW * hq) / Math.max(1, wq)));
  const dst = [
    [0, 0],
    [outW, 0],
    [outW, outH],
    [0, outH],
  ];
  // map output pixel → source pixel
  const H = homography(
    dst,
    q.map(([x, y]) => [x * s, y * s]),
  );
  const out = gray(outW, outH);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const X = x + 0.5;
      const Y = y + 0.5;
      const w = H[6] * X + H[7] * Y + H[8];
      const u = (H[0] * X + H[1] * Y + H[2]) / w - 0.5;
      const v = (H[3] * X + H[4] * Y + H[5]) / w - 0.5;
      out.d[y * outW + x] = Math.round(sample(src, u, v));
    }
  }
  return out;
}

/** Rotate by `deg` degrees about the centre (positive turns lines that rise to the right level), white fill. */
export function rotate(img: Gray, deg: number): Gray {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const cx = img.w / 2;
  const cy = img.h / 2;
  const out = gray(img.w, img.h);
  for (let v = 0; v < img.h; v++) {
    const dv = v + 0.5 - cy;
    for (let u = 0; u < img.w; u++) {
      const du = u + 0.5 - cx;
      // output (u, v) shows the source point rotated by `a`
      const x = du * c - dv * s + cx - 0.5;
      const y = du * s + dv * c + cy - 0.5;
      out.d[v * img.w + u] = Math.round(sample(img, x, y));
    }
  }
  return out;
}

// ------------------------------------------------------------------ filters

/** Running max (dilate) or min (erode) over a window of `k` samples along one axis (van Herk / Gil-Werman). */
function runningExtreme(src: Uint8Array, n: number, stride: number, count: number, lineStride: number, k: number, max: boolean, out: Uint8Array) {
  const r = k >> 1;
  const len = n + 2 * r;
  const pad = max ? 0 : 255;
  const buf = new Uint8Array(len);
  const g = new Uint8Array(len);
  const hBuf = new Uint8Array(len);
  const op = max ? (a: number, b: number) => (a > b ? a : b) : (a: number, b: number) => (a < b ? a : b);
  for (let l = 0; l < count; l++) {
    const s0 = l * lineStride;
    buf.fill(pad);
    for (let i = 0; i < n; i++) buf[i + r] = src[s0 + i * stride];
    for (let i = 0; i < len; i++) g[i] = i % k === 0 ? buf[i] : op(g[i - 1], buf[i]);
    for (let i = len - 1; i >= 0; i--) hBuf[i] = i === len - 1 || (i + 1) % k === 0 ? buf[i] : op(hBuf[i + 1], buf[i]);
    for (let i = 0; i < n; i++) {
      // window [i, i + k - 1] in padded coordinates
      const a = hBuf[i];
      const b = g[Math.min(len - 1, i + k - 1)];
      out[s0 + i * stride] = op(a, b);
    }
  }
}

/** Grayscale dilation (max) or erosion (min) with a kw x kh rectangle. */
export function rectFilter(img: Gray, kw: number, kh: number, max: boolean): Gray {
  let d = img.d;
  if (kw > 1) {
    const o = new Uint8Array(d.length);
    runningExtreme(d, img.w, 1, img.h, img.w, kw, max, o);
    d = o;
  }
  if (kh > 1) {
    const o = new Uint8Array(d.length);
    runningExtreme(d, img.h, img.w, img.w, 1, kh, max, o);
    d = o;
  }
  return { w: img.w, h: img.h, d: d === img.d ? d.slice() : d };
}

/** Morphological closing (max then min): removes dark details smaller than the kernel. */
export function close(img: Gray, kw: number, kh = kw): Gray {
  return rectFilter(rectFilter(img, kw, kh, true), kw, kh, false);
}

/** Box blur of radius r along both axes (running sums, clamped edges), float output. */
function boxBlurF(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let s = 0;
    for (let i = -r; i <= r; i++) s += src[o + Math.min(w - 1, Math.max(0, i))];
    for (let x = 0; x < w; x++) {
      tmp[o + x] = s / win;
      s += src[o + Math.min(w - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += tmp[Math.min(h - 1, Math.max(0, i)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / win;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/** Approximate Gaussian blur (three box blurs), float output. */
export function gaussianF(img: Gray | { w: number; h: number; d: Float32Array }, sigma: number): Float32Array {
  let f = img.d instanceof Float32Array ? img.d : new Float32Array(img.d);
  if (sigma <= 0.3) return f.slice();
  // box radius for 3 passes with the same variance: sigma^2 = 3 * ((2r+1)^2 - 1) / 12
  const r = Math.max(1, Math.round((Math.sqrt(4 * sigma * sigma + 1) - 1) / 2));
  for (let i = 0; i < 3; i++) f = boxBlurF(f, img.w, img.h, r);
  return f;
}

/** Value below which `p` (0..1) of the pixels lie. */
export function percentile(d: ArrayLike<number>, p: number): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i++) hist[Math.max(0, Math.min(255, Math.round(d[i])))]++;
  const target = p * d.length;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= target) return v;
  }
  return 255;
}

/** Otsu's threshold of an 8-bit image. */
export function otsu(d: Uint8Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < d.length; i++) hist[d[i]]++;
  const total = d.length;
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let thr = 127;
  for (let v = 0; v < 256; v++) {
    wB += hist[v];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += v * hist[v];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      thr = v;
    }
  }
  return thr;
}

/**
 * Ink mask like cv2.adaptiveThreshold(MEAN_C, BINARY_INV, block, C): a pixel is ink when it is darker
 * than the mean of its block x block neighbourhood minus C. 1 = ink.
 */
export function binarize(img: Gray, block = 31, C = 15): Uint8Array {
  const { w, h, d } = img;
  const W = w + 1;
  const integ = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += d[y * w + x];
      integ[(y + 1) * W + x + 1] = integ[y * W + x + 1] + row;
    }
  }
  const r = block >> 1;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const s = integ[y1 * W + x1] - integ[y0 * W + x1] - integ[y1 * W + x0] + integ[y0 * W + x0];
      const mean = s / ((y1 - y0) * (x1 - x0));
      out[y * w + x] = d[y * w + x] <= mean - C ? 1 : 0;
    }
  }
  return out;
}

/** Keep only horizontal ink runs at least `minLen` pixels long (binary opening with a 1 x minLen line). */
export function horizontalRuns(mask: Uint8Array, w: number, h: number, minLen: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let x = 0;
    while (x < w) {
      if (!mask[o + x]) {
        x++;
        continue;
      }
      let e = x;
      while (e < w && mask[o + e]) e++;
      if (e - x >= minLen) out.fill(1, o + x, o + e);
      x = e;
    }
  }
  return out;
}

/** Float image → clamped 8-bit gray. */
export function toGray(f: Float32Array, w: number, h: number): Gray {
  const d = new Uint8Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = f[i] < 0 ? 0 : f[i] > 255 ? 255 : Math.round(f[i]);
  return { w, h, d };
}
