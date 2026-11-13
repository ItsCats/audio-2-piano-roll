// SPDX-License-Identifier: AGPL-3.0-only AND BSD-3-Clause
// Modified (TypeScript port of homr 0.7.1) by the Piano2Vision contributors, 2026; see README.md here.
// Ports of OpenCV functions: copyright notices and licence in LICENSE-OpenCV.txt here.
/**
 * The OpenCV geometry functions homr uses, ported to TypeScript with OpenCV's own algorithms and
 * (where it decides results) its float32 arithmetic: findContours (Suzuki-Abe border following,
 * CHAIN_APPROX_SIMPLE, OpenCV's contour order), convexHull (Sklansky), minAreaRect (rotating
 * calipers), fitEllipse, boxPoints, ellipse2Poly, pointPolygonTest, intersectConvexConvex (area),
 * rotatedRectangleIntersection (does it intersect), boundingRect, contourArea.
 *
 * Derived from homr (AGPL-3.0, Copyright the homr contributors, https://github.com/liebharc/homr),
 * which calls these through opencv-python; the algorithms follow OpenCV (3-clause BSD / Apache-2.0, see LICENSE-OpenCV.txt).
 * tests/unit/homr/geom.test.ts compares them with cv2 on fixtures dumped by tests/homr/make_fixtures.py.
 */

const f = Math.fround;

/** A contour: x0, y0, x1, y1, ... (integer pixel coordinates). */
export type Contour = Int32Array;

/** OpenCV RotatedRect: center, size (width, height), angle in degrees. */
export type RotatedRect = [[number, number], [number, number], number];

export type Pt = [number, number];

// ------------------------------------------------------------------ findContours

const CODE_DX = [1, 1, 0, -1, -1, -1, 0, 1];
const CODE_DY = [0, -1, -1, -1, 0, 1, 1, 1];

interface RawContour {
  pts: number[];
  isHole: boolean;
  parent: number; // -1: the frame
  children: number[];
}

/**
 * cv2.findContours(mask, mode, CHAIN_APPROX_SIMPLE)[0] for an 8-bit mask (non-zero = foreground).
 * mode 'tree' (RETR_TREE: all contours, holes too) or 'external' (RETR_EXTERNAL). The order is
 * OpenCV's: a depth-first walk of the contour tree, siblings in reverse order of discovery.
 */
export function findContours(mask: Uint8Array, w: number, h: number, mode: 'tree' | 'external'): Contour[] {
  // padded copy, binarised to 0/1 (OpenCV pads with a zero border and shifts the points back by -1)
  const W = w + 2;
  const H = h + 2;
  const img = new Int8Array(W * H);
  for (let y = 0; y < h; y++) {
    const s = y * w;
    const d = (y + 1) * W + 1;
    for (let x = 0; x < w; x++) if (mask[s + x]) img[d + x] = 1;
  }
  // which contour marked a border pixel (for the parent of the next contour)
  const owner = new Int32Array(W * H).fill(-1);
  const contours: RawContour[] = [];
  const topLevel: number[] = [];
  const deltas = new Int32Array(16);
  const base = [1, -W + 1, -W, -W - 1, -1, W - 1, W, W + 1];
  for (let i = 0; i < 16; i++) deltas[i] = base[i & 7];
  const external = mode === 'external';

  const fetch = (i0: number, ptx: number, pty: number, isHole: boolean, id: number): number[] => {
    const out: number[] = [];
    let s = isHole ? 0 : 4;
    let sEnd = s;
    let i1 = 0;
    do {
      s = (s - 1) & 7;
      i1 = i0 + deltas[s];
    } while (img[i1] === 0 && s !== sEnd);
    if (s === sEnd) {
      // single pixel
      img[i0] = 2 | -128;
      owner[i0] = id;
      out.push(ptx, pty);
      return out;
    }
    let i3 = i0;
    let i4 = 0;
    let prevS = s ^ 4;
    for (;;) {
      sEnd = s;
      s = Math.min(s, 15);
      while (s < 15) {
        i4 = i3 + deltas[++s];
        if (img[i4] !== 0) break;
      }
      s &= 7;
      if ((s - 1) >>> 0 < sEnd >>> 0) {
        img[i3] = 2 | -128;
        owner[i3] = id;
      } else if (img[i3] === 1) {
        img[i3] = 2;
        owner[i3] = id;
      }
      if (s !== prevS) {
        out.push(ptx, pty);
        prevS = s;
      }
      ptx += CODE_DX[s];
      pty += CODE_DY[s];
      if (i4 === i0 && i3 === i1) break;
      i3 = i4;
      s = (s + 4) & 7;
    }
    return out;
  };

  for (let y = 1; y < H - 1; y++) {
    let lnbdX = 0;
    const lnbdY = y;
    let prev = 0;
    const row = y * W;
    for (let x = 1; x < W - 1; x++) {
      const p = img[row + x];
      if (p === prev) continue;
      let isHole = false;
      let start = true;
      if (!(prev === 0 && p === 1)) {
        // hole?
        if (p !== 0 || prev < 1) start = false;
        else {
          if (prev & -2) lnbdX = x - 1;
          isHole = true;
        }
      }
      if (start && external && (isHole || img[lnbdY * W + lnbdX] > 0)) start = false;
      if (start) {
        // parent: the contour through the last border pixel left of here (Suzuki-Abe)
        let parent = -1;
        if (!external && lnbdX > 0) {
          const o = owner[lnbdY * W + lnbdX];
          if (o >= 0) {
            parent = o;
            if (contours[o].isHole === isHole) parent = contours[o].parent;
          }
        }
        // the frame counts as a hole: an outer contour's parent is a hole or the frame
        if (parent >= 0 && contours[parent].isHole === isHole) parent = -1;
        const id = contours.length;
        const sx = x - (isHole ? 1 : 0);
        const c: RawContour = { pts: [], isHole, parent, children: [] };
        contours.push(c);
        c.pts = fetch(row + sx, sx - 1, y - 1, isHole, id);
        if (parent >= 0) contours[parent].children.unshift(id);
        else topLevel.unshift(id);
      }
      // resume: the start pixel may have been marked by the contour just traced
      prev = start ? img[row + x] : p;
      if (!start && prev & -2) lnbdX = x;
    }
  }
  const result: Contour[] = [];
  const walk = (id: number) => {
    result.push(Int32Array.from(contours[id].pts));
    for (const ch of contours[id].children) walk(ch);
  };
  for (const id of topLevel) walk(id);
  return result;
}

/** cv2.boundingRect of integer points: [x, y, w, h]. */
export function boundingRect(c: ArrayLike<number>): [number, number, number, number] {
  if (c.length === 0) return [0, 0, 0, 0];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < c.length; i += 2) {
    x0 = Math.min(x0, c[i]);
    x1 = Math.max(x1, c[i]);
    y0 = Math.min(y0, c[i + 1]);
    y1 = Math.max(y1, c[i + 1]);
  }
  return [x0, y0, x1 - x0 + 1, y1 - y0 + 1];
}

/** cv2.boundingRect of float points (cvFloor of the extremes). */
export function boundingRectF(pts: Pt[]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const ix0 = Math.floor(x0);
  const iy0 = Math.floor(y0);
  return [ix0, iy0, Math.floor(x1) - ix0 + 1, Math.floor(y1) - iy0 + 1];
}

/** cv2.contourArea (unsigned) of a polygon. */
export function contourArea(c: ArrayLike<number>): number {
  const n = c.length / 2;
  if (n < 3) return 0;
  let a = 0;
  let px = c[2 * n - 2];
  let py = c[2 * n - 1];
  for (let i = 0; i < n; i++) {
    const x = c[2 * i];
    const y = c[2 * i + 1];
    a += px * y - py * x;
    px = x;
    py = y;
  }
  return Math.abs(a * 0.5);
}

// ------------------------------------------------------------------ convex hull

function sklansky(px: Int32Array, py: Int32Array, ptr: Int32Array, start: number, end: number, stack: Int32Array, so: number, nsign: number, sign2: number): number {
  const incr = end > start ? 1 : -1;
  let pprev = start;
  let pcur = pprev + incr;
  let pnext = pcur + incr;
  let size = 3;
  const X = (i: number) => px[ptr[i]];
  const Y = (i: number) => py[ptr[i]];
  if (start === end || (X(start) === X(end) && Y(start) === Y(end))) {
    stack[so] = start;
    return 1;
  }
  stack[so] = pprev;
  stack[so + 1] = pcur;
  stack[so + 2] = pnext;
  end += incr;
  while (pnext !== end) {
    const cury = Y(pcur);
    const nexty = Y(pnext);
    const by = nexty - cury;
    if (Math.sign(by) !== nsign) {
      const ax = X(pcur) - X(pprev);
      const bx = X(pnext) - X(pcur);
      const ay = cury - Y(pprev);
      const convexity = ay * bx - ax * by;
      if (Math.sign(convexity) === sign2 && (ax !== 0 || ay !== 0)) {
        pprev = pcur;
        pcur = pnext;
        pnext += incr;
        stack[so + size] = pnext;
        size++;
      } else if (pprev === start) {
        pcur = pnext;
        stack[so + 1] = pcur;
        pnext += incr;
        stack[so + 2] = pnext;
      } else {
        stack[so + size - 2] = pnext;
        pcur = pprev;
        pprev = stack[so + size - 4];
        size--;
      }
    } else {
      pnext += incr;
      stack[so + size - 1] = pnext;
    }
  }
  return size - 1;
}

/** cv2.convexHull(points, clockwise=False, returnPoints=True) of integer points; returns indices into the points. */
export function convexHullIndices(c: ArrayLike<number>): number[] {
  const total = c.length / 2;
  if (total === 0) return [];
  const px = new Int32Array(total);
  const py = new Int32Array(total);
  for (let i = 0; i < total; i++) {
    px[i] = c[2 * i];
    py[i] = c[2 * i + 1];
  }
  const order = Array.from({ length: total }, (_, i) => i).sort((a, b) => px[a] - px[b] || py[a] - py[b] || a - b);
  const ptr = Int32Array.from(order);
  let miny = 0;
  let maxy = 0;
  for (let i = 1; i < total; i++) {
    const y = py[ptr[i]];
    if (py[ptr[miny]] > y) miny = i;
    if (py[ptr[maxy]] < y) maxy = i;
  }
  const hull: number[] = [];
  const stack = new Int32Array(total + 2);
  if (px[ptr[0]] === px[ptr[total - 1]] && py[ptr[0]] === py[ptr[total - 1]]) {
    hull.push(ptr[0]);
    return hull;
  }
  // upper half (clockwise = false: the stacks are swapped)
  let tlS = 0;
  let tlC = sklansky(px, py, ptr, 0, maxy, stack, 0, -1, 1);
  let trS = tlC;
  let trC = sklansky(px, py, ptr, total - 1, maxy, stack, trS, -1, -1);
  [tlS, trS] = [trS, tlS];
  [tlC, trC] = [trC, tlC];
  for (let i = 0; i < tlC - 1; i++) hull.push(ptr[stack[tlS + i]]);
  for (let i = trC - 1; i > 0; i--) hull.push(ptr[stack[trS + i]]);
  const stopIdx = trC > 2 ? stack[trS + 1] : tlC > 2 ? stack[tlS + tlC - 2] : -1;
  // lower half
  const blS = 0;
  let blC = sklansky(px, py, ptr, 0, miny, stack, blS, 1, -1);
  const brS = blC;
  let brC = sklansky(px, py, ptr, total - 1, miny, stack, brS, 1, 1);
  if (stopIdx >= 0) {
    const checkIdx = blC > 2 ? stack[blS + 1] : blC + brC > 2 ? stack[brS + 2 - blC] : -1;
    if (checkIdx === stopIdx || (checkIdx >= 0 && px[ptr[checkIdx]] === px[ptr[stopIdx]] && py[ptr[checkIdx]] === py[ptr[stopIdx]])) {
      blC = Math.min(blC, 2);
      brC = Math.min(brC, 2);
    }
  }
  for (let i = 0; i < blC - 1; i++) hull.push(ptr[stack[blS + i]]);
  for (let i = brC - 1; i > 0; i--) hull.push(ptr[stack[brS + i]]);
  // make the indices an ascending or descending sequence by a cyclic shift, if possible
  const nout = hull.length;
  if (nout >= 3) {
    let minIdx = 0;
    let maxIdx = 0;
    let lt = 0;
    for (let i = 1; i < nout; i++) {
      const idx = hull[i];
      lt += hull[i - 1] < idx ? 1 : 0;
      if (lt > 1 && lt <= i - 2) break;
      if (idx < hull[minIdx]) minIdx = i;
      if (idx > hull[maxIdx]) maxIdx = i;
    }
    const mmdist = Math.abs(maxIdx - minIdx);
    if ((mmdist === 1 || mmdist === nout - 1) && (lt <= 1 || lt >= nout - 2)) {
      const ascending = (maxIdx + 1) % nout === minIdx;
      const i0 = ascending ? minIdx : maxIdx;
      let j = i0;
      if (i0 > 0) {
        const tmp: number[] = [];
        let i = 0;
        for (; i < nout; i++) {
          const cur = hull[j];
          tmp.push(cur);
          const nj = j + 1 < nout ? j + 1 : 0;
          const next = hull[nj];
          if (i < nout - 1 && ascending !== cur < next) break;
          j = nj;
        }
        if (i === nout) for (let k = 0; k < nout; k++) hull[k] = tmp[k];
      }
    }
  }
  return hull;
}

// ------------------------------------------------------------------ minAreaRect

function rotatingCalipersMinArea(pts: Float32Array, n: number): number[] {
  // pts: x0, y0, ... as float32
  let minarea = 3.4028234663852886e38;
  const vx = new Float32Array(n);
  const vy = new Float32Array(n);
  const inv = new Float32Array(n);
  let left = 0;
  let bottom = 0;
  let right = 0;
  let top = 0;
  const seq = [-1, -1, -1, -1];
  let orientation = 0;
  let baseA = 0;
  let baseB = 0;
  let p0x = pts[0];
  let p0y = pts[1];
  let leftX = p0x;
  let rightX = p0x;
  let topY = p0y;
  let bottomY = p0y;
  for (let i = 0; i < n; i++) {
    if (p0x < leftX) (leftX = p0x), (left = i);
    if (p0x > rightX) (rightX = p0x), (right = i);
    if (p0y > topY) (topY = p0y), (top = i);
    if (p0y < bottomY) (bottomY = p0y), (bottom = i);
    const j = i + 1 < n ? i + 1 : 0;
    const ptx = pts[2 * j];
    const pty = pts[2 * j + 1];
    const dx = ptx - p0x;
    const dy = pty - p0y;
    vx[i] = dx;
    vy[i] = dy;
    inv[i] = 1 / Math.sqrt(dx * dx + dy * dy);
    p0x = ptx;
    p0y = pty;
  }
  {
    let ax = vx[n - 1];
    let ay = vy[n - 1];
    for (let i = 0; i < n; i++) {
      const bx = vx[i];
      const by = vy[i];
      const convexity = ax * by - ay * bx;
      if (convexity !== 0) {
        orientation = convexity > 0 ? 1 : -1;
        break;
      }
      ax = bx;
      ay = by;
    }
  }
  baseA = orientation;
  seq[0] = bottom;
  seq[1] = right;
  seq[2] = top;
  seq[3] = left;
  const buf = { left: 0, a: 0, width: 0, b: 0, height: 0, bottom: 0 };
  for (let k = 0; k < n; k++) {
    const dp = [
      f(f(baseA * vx[seq[0]]) + f(baseB * vy[seq[0]])),
      f(f(-baseB * vx[seq[1]]) + f(baseA * vy[seq[1]])),
      f(f(-baseA * vx[seq[2]]) - f(baseB * vy[seq[2]])),
      f(f(baseB * vx[seq[3]]) - f(baseA * vy[seq[3]])),
    ];
    let main = 0;
    let maxcos = f(dp[0] * inv[seq[0]]);
    for (let i = 1; i < 4; i++) {
      const c = f(dp[i] * inv[seq[i]]);
      if (c > maxcos) {
        main = i;
        maxcos = c;
      }
    }
    {
      const pi = seq[main];
      const lx = f(vx[pi] * inv[pi]);
      const ly = f(vy[pi] * inv[pi]);
      if (main === 0) (baseA = lx), (baseB = ly);
      else if (main === 1) (baseA = ly), (baseB = -lx);
      else if (main === 2) (baseA = -lx), (baseB = -ly);
      else (baseA = -ly), (baseB = lx);
    }
    seq[main] += 1;
    if (seq[main] === n) seq[main] = 0;
    let dx = f(pts[2 * seq[1]] - pts[2 * seq[3]]);
    let dy = f(pts[2 * seq[1] + 1] - pts[2 * seq[3] + 1]);
    const width = f(f(dx * baseA) + f(dy * baseB));
    dx = f(pts[2 * seq[2]] - pts[2 * seq[0]]);
    dy = f(pts[2 * seq[2] + 1] - pts[2 * seq[0] + 1]);
    const height = f(f(-dx * baseB) + f(dy * baseA));
    const area = f(width * height);
    if (area <= minarea) {
      minarea = area;
      buf.left = seq[3];
      buf.a = baseA;
      buf.width = width;
      buf.b = baseB;
      buf.height = height;
      buf.bottom = seq[0];
    }
  }
  const A1 = buf.a;
  const B1 = buf.b;
  const A2 = -buf.b;
  const B2 = buf.a;
  const C1 = f(f(A1 * pts[2 * buf.left]) + f(pts[2 * buf.left + 1] * B1));
  const C2 = f(f(A2 * pts[2 * buf.bottom]) + f(pts[2 * buf.bottom + 1] * B2));
  const idet = f(1 / f(f(A1 * B2) - f(A2 * B1)));
  const px = f(f(f(C1 * B2) - f(C2 * B1)) * idet);
  const py = f(f(f(A1 * C2) - f(A2 * C1)) * idet);
  return [px, py, f(A1 * buf.width), f(B1 * buf.width), f(A2 * buf.height), f(B2 * buf.height)];
}

/** cv2.minAreaRect of integer points. */
export function minAreaRect(c: ArrayLike<number>): RotatedRect {
  const idx = convexHullIndices(c);
  const n = idx.length;
  const hp = new Float32Array(2 * n);
  for (let i = 0; i < n; i++) {
    hp[2 * i] = c[2 * idx[i]];
    hp[2 * i + 1] = c[2 * idx[i] + 1];
  }
  let cx = 0;
  let cy = 0;
  let w = 0;
  let h = 0;
  let angle = 0;
  if (n > 2) {
    const o = rotatingCalipersMinArea(hp, n);
    cx = f(o[0] + f(f(o[2] + o[4]) * 0.5));
    cy = f(o[1] + f(f(o[3] + o[5]) * 0.5));
    w = f(Math.sqrt(o[2] * o[2] + o[3] * o[3]));
    h = f(Math.sqrt(o[4] * o[4] + o[5] * o[5]));
    angle = (Math.atan2(o[3], o[2]) * 180) / Math.PI;
  } else if (n === 2) {
    cx = f(f(hp[0] + hp[2]) * 0.5);
    cy = f(f(hp[1] + hp[3]) * 0.5);
    const dx = hp[2] - hp[0];
    const dy = hp[3] - hp[1];
    w = f(Math.sqrt(dx * dx + dy * dy));
    h = 0;
    angle = (Math.atan2(dy, dx) * 180) / Math.PI;
  } else if (n === 1) {
    cx = hp[0];
    cy = hp[1];
  }
  angle = f(angle);
  // the OpenCV homr runs on (4.14) reports angles in [-90, 0)
  while (angle >= 0) {
    [w, h] = [h, w];
    angle = f(angle - 90);
  }
  while (angle < -90) {
    [w, h] = [h, w];
    angle = f(angle + 90);
  }
  return [[cx, cy], [w, h], angle];
}

/** cv2.boxPoints (float32 corners). */
export function boxPoints(r: RotatedRect): Pt[] {
  const [[cx, cy], [w, h], angle] = r;
  const a0 = (angle * Math.PI) / 180;
  const b = f(f(Math.cos(a0)) * 0.5);
  const a = f(f(Math.sin(a0)) * 0.5);
  const p0x = f(f(cx - f(a * h)) - f(b * w));
  const p0y = f(f(cy + f(b * h)) - f(a * w));
  const p1x = f(f(cx + f(a * h)) - f(b * w));
  const p1y = f(f(cy - f(b * h)) - f(a * w));
  return [
    [p0x, p0y],
    [p1x, p1y],
    [f(f(2 * cx) - p0x), f(f(2 * cy) - p0y)],
    [f(f(2 * cx) - p1x), f(f(2 * cy) - p1y)],
  ];
}

// ------------------------------------------------------------------ fitEllipse

/** Symmetric eigen decomposition (Jacobi): returns eigenvalues (descending) and vectors (columns). */
function jacobiEigen(a: Float64Array, n: number): { values: Float64Array; vectors: Float64Array } {
  const A = Float64Array.from(a);
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i * n + j] * A[i * n + j];
    if (off < 1e-300) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = A[p * n + q];
        if (Math.abs(apq) < 1e-300) continue;
        const app = A[p * n + p];
        const aqq = A[q * n + q];
        const theta = (aqq - app) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k * n + p];
          const akq = A[k * n + q];
          A[k * n + p] = c * akp - s * akq;
          A[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p * n + k];
          const aqk = A[q * n + k];
          A[p * n + k] = c * apk - s * aqk;
          A[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k * n + p];
          const vkq = V[k * n + q];
          V[k * n + p] = c * vkp - s * vkq;
          V[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((x, y) => A[y * n + y] - A[x * n + x]);
  const values = new Float64Array(n);
  const vectors = new Float64Array(n * n);
  order.forEach((o, k) => {
    values[k] = A[o * n + o];
    for (let r = 0; r < n; r++) vectors[r * n + k] = V[r * n + o];
  });
  return { values, vectors };
}

/** Least squares A x = b (rows m, cols n) via the SVD of A (eigen of AᵀA); also returns the singular values. */
function lstsq(A: Float64Array, b: Float64Array, m: number, n: number): { x: Float64Array; w: Float64Array } {
  const ata = new Float64Array(n * n);
  const atb = new Float64Array(n);
  for (let r = 0; r < m; r++) {
    for (let i = 0; i < n; i++) {
      const ai = A[r * n + i];
      atb[i] += ai * b[r];
      for (let j = i; j < n; j++) ata[i * n + j] += ai * A[r * n + j];
    }
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) ata[i * n + j] = ata[j * n + i];
  const { values, vectors } = jacobiEigen(ata, n);
  const w = values.map((v) => Math.sqrt(Math.max(v, 0)));
  const x = new Float64Array(n);
  const thresh = 1e-12 * values[0];
  for (let k = 0; k < n; k++) {
    if (!(values[k] > thresh)) continue;
    let d = 0;
    for (let i = 0; i < n; i++) d += vectors[i * n + k] * atb[i];
    d /= values[k];
    for (let i = 0; i < n; i++) x[i] += d * vectors[i * n + k];
  }
  return { x, w };
}

/** cv2.fitEllipse of integer points (OpenCV's fitEllipseNoDirect). Needs at least 5 points. */
export function fitEllipse(c: ArrayLike<number>): RotatedRect {
  const n = c.length / 2;
  if (n < 5) throw new Error('fitEllipse needs at least 5 points');
  const pts = new Float32Array(2 * n);
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    pts[2 * i] = c[2 * i];
    pts[2 * i + 1] = c[2 * i + 1];
    cx = f(cx + pts[2 * i]);
    cy = f(cy + pts[2 * i + 1]);
  }
  cx = f(cx / n);
  cy = f(cy / n);
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(f(pts[2 * i] - cx)) + Math.abs(f(pts[2 * i + 1] - cy));
  const FLT_EPSILON = 1.1920928955078125e-7;
  const scale = 100 / (s > FLT_EPSILON ? s : FLT_EPSILON);
  const fill = (A: Float64Array, b: Float64Array) => {
    for (let i = 0; i < n; i++) {
      const px = f(pts[2 * i] - cx) * scale;
      const py = f(pts[2 * i + 1] - cy) * scale;
      b[i] = 10000;
      A[i * 5] = -px * px;
      A[i * 5 + 1] = -py * py;
      A[i * 5 + 2] = -px * py;
      A[i * 5 + 3] = px;
      A[i * 5 + 4] = py;
    }
  };
  let A = new Float64Array(n * 5);
  let b = new Float64Array(n);
  fill(A, b);
  let sol = lstsq(A, b, n, 5);
  if (sol.w[0] * FLT_EPSILON > sol.w[4]) {
    const eps = f(f(s / (n * 2)) * 1e-3);
    for (let i = 0; i < n; i++) {
      pts[2 * i] = f(pts[2 * i] + ((i & 1) * 2 - 1) * eps);
      pts[2 * i + 1] = f(pts[2 * i + 1] + ((i & 2) - 1) * eps);
    }
    fill(A, b);
    sol = lstsq(A, b, n, 5);
  }
  const gfp = sol.x;
  // center: solve the 2x2 system
  const a00 = 2 * gfp[0];
  const a01 = gfp[2];
  const a11 = 2 * gfp[1];
  const det = a00 * a11 - a01 * a01;
  let rp0 = 0;
  let rp1 = 0;
  if (Math.abs(det) > 1e-300) {
    rp0 = (gfp[3] * a11 - a01 * gfp[4]) / det;
    rp1 = (a00 * gfp[4] - a01 * gfp[3]) / det;
  } else {
    const r = lstsq(Float64Array.from([a00, a01, a01, a11]), Float64Array.from([gfp[3], gfp[4]]), 2, 2).x;
    rp0 = r[0];
    rp1 = r[1];
  }
  A = new Float64Array(n * 3);
  b = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const px = f(pts[2 * i] - cx) * scale;
    const py = f(pts[2 * i + 1] - cy) * scale;
    b[i] = 1;
    A[i * 3] = (px - rp0) * (px - rp0);
    A[i * 3 + 1] = (py - rp1) * (py - rp1);
    A[i * 3 + 2] = (px - rp0) * (py - rp1);
  }
  const g = lstsq(A, b, n, 3).x;
  const minEps = 1e-8;
  const rp4 = -0.5 * Math.atan2(g[2], g[1] - g[0]);
  const t = Math.abs(g[2]) > minEps ? g[2] / Math.sin(-2 * rp4) : g[1] - g[0];
  let rp2 = Math.abs(g[0] + g[1] - t);
  if (rp2 > minEps) rp2 = Math.sqrt(2 / rp2);
  let rp3 = Math.abs(g[0] + g[1] + t);
  if (rp3 > minEps) rp3 = Math.sqrt(2 / rp3);
  const ccx = f(f(rp0 / scale) + cx);
  const ccy = f(f(rp1 / scale) + cy);
  let w = f((rp2 * 2) / scale);
  let h = f((rp3 * 2) / scale);
  // OpenCV 4.x sets the angle of the first axis + 90 degrees whether or not it swaps the axes
  let angle = f(90 + (rp4 * 180) / Math.PI);
  if (w > h) [w, h] = [h, w];
  if (angle < -180) angle = f(angle + 360);
  if (angle > 360) angle = f(angle - 360);
  return [[ccx, ccy], [w, h], angle];
}

// ------------------------------------------------------------------ ellipse2Poly

// OpenCV's SinTable: sin of whole degrees to 7 decimals, as float32
const SIN_TABLE = Float32Array.from({ length: 451 }, (_, i) => Number(Math.sin((i * Math.PI) / 180).toFixed(7)));

/** cv2.ellipse2Poly(center, axes, angle, 0, 360, 1) with integer arguments. */
export function ellipse2Poly(center: Pt, axes: Pt, angleIn: number, arcStart = 0, arcEnd = 360, delta = 1): number[] {
  let angle = angleIn;
  while (angle < 0) angle += 360;
  while (angle > 360) angle -= 360;
  let a0 = arcStart;
  let a1 = arcEnd;
  if (a0 > a1) [a0, a1] = [a1, a0];
  while (a0 < 0) (a0 += 360), (a1 += 360);
  while (a1 > 360) (a1 -= 360), (a0 -= 360);
  if (a1 - a0 > 360) (a0 = 0), (a1 = 360);
  const alpha = SIN_TABLE[450 - angle];
  const beta = SIN_TABLE[angle];
  const out: number[] = [];
  let prevX = -2147483648;
  let prevY = -2147483648;
  let count = 0;
  for (let i = a0; i < a1 + delta; i += delta) {
    let an = i;
    if (an > a1) an = a1;
    if (an < 0) an += 360;
    const x = axes[0] * SIN_TABLE[450 - an];
    const y = axes[1] * SIN_TABLE[an];
    const px = center[0] + x * alpha - y * beta;
    const py = center[1] + x * beta + y * alpha;
    count++;
    const rx = cvRound(px);
    const ry = cvRound(py);
    if (rx !== prevX || ry !== prevY) {
      out.push(rx, ry);
      prevX = rx;
      prevY = ry;
    }
  }
  if (out.length === 2 || count === 1) return [center[0], center[1], center[0], center[1]];
  return out;
}

/** cvRound: round half to even. */
export function cvRound(v: number): number {
  if (Math.abs(v - Math.trunc(v)) === 0.5) return 2 * Math.round(v / 2) + 0;
  return Math.round(v) + 0;
}

// ------------------------------------------------------------------ polygon tests

/** cv2.pointPolygonTest(contour, pt, False) for an integer polygon and an integer point: 1 in, 0 on, -1 out. */
export function pointPolygonTest(poly: ArrayLike<number>, x: number, y: number): number {
  const total = poly.length / 2;
  if (total === 0) return -1;
  let counter = 0;
  let vx = poly[2 * total - 2];
  let vy = poly[2 * total - 1];
  for (let i = 0; i < total; i++) {
    const v0x = vx;
    const v0y = vy;
    vx = poly[2 * i];
    vy = poly[2 * i + 1];
    if ((v0y <= y && vy <= y) || (v0y > y && vy > y) || (v0x < x && vx < x)) {
      if (y === vy && (x === vx || (y === v0y && ((v0x <= x && x <= vx) || (vx <= x && x <= v0x))))) return 0;
      continue;
    }
    let dist = (y - v0y) * (vx - v0x) - (x - v0x) * (vy - v0y);
    if (dist === 0) return 0;
    if (vy < v0y) dist = -dist;
    if (dist > 0) counter++;
  }
  return counter % 2 === 0 ? -1 : 1;
}

/** Area of the intersection of two convex polygons (cv2.intersectConvexConvex(...)[0]). */
export function intersectConvexConvexArea(p1: Pt[], p2: Pt[]): number {
  const orient = (p: Pt[]) => {
    let a = 0;
    for (let i = 0; i < p.length; i++) {
      const [x0, y0] = p[i];
      const [x1, y1] = p[(i + 1) % p.length];
      a += x0 * y1 - x1 * y0;
    }
    return a;
  };
  const a1 = orient(p1);
  const a2 = orient(p2);
  if (a1 === 0 || a2 === 0) return 0;
  // Sutherland-Hodgman: clip p1 by each edge of p2 (both made counter-clockwise)
  let subject = a1 > 0 ? p1.slice() : p1.slice().reverse();
  const clip = a2 > 0 ? p2 : p2.slice().reverse();
  for (let i = 0; i < clip.length && subject.length; i++) {
    const [ax, ay] = clip[i];
    const [bx, by] = clip[(i + 1) % clip.length];
    const side = (p: Pt) => (bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax);
    const next: Pt[] = [];
    for (let j = 0; j < subject.length; j++) {
      const P = subject[j];
      const Q = subject[(j + 1) % subject.length];
      const sp = side(P);
      const sq = side(Q);
      if (sp >= 0) next.push(P);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        next.push([P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1])]);
      }
    }
    subject = next;
  }
  return subject.length >= 3 ? Math.abs(orient(subject)) / 2 : 0;
}

/** RotatedRect::points in float32 (the corners rotatedRectangleIntersection works with). */
function cornersf(cx: number, cy: number, w: number, h: number, angle: number): Pt[] {
  const t = (angle * Math.PI) / 180;
  const b = f(f(Math.cos(t)) * 0.5);
  const a = f(f(Math.sin(t)) * 0.5);
  const p0: Pt = [f(f(cx - f(a * h)) - f(b * w)), f(f(cy + f(b * h)) - f(a * w))];
  const p1: Pt = [f(f(cx + f(a * h)) - f(b * w)), f(f(cy - f(b * h)) - f(a * w))];
  return [p0, p1, [f(f(2 * cx) - p0[0]), f(f(2 * cy) - p0[1])], [f(f(2 * cx) - p1[0]), f(f(2 * cy) - p1[1])]];
}

/**
 * cv2.rotatedRectangleIntersection(r1, r2)[0] != INTERSECT_NONE, ported from OpenCV 4.14
 * (modules/imgproc/src/intersection.cpp) with its float32 arithmetic: both rectangles are moved by
 * their average centre, then edge crossings and corners inside the other rectangle are searched.
 * Touching counts, so float32 rounding decides for rectangles that just touch (a bar line next to
 * the end of a staff line). An empty rectangle intersects nothing.
 */
export function rotatedRectsIntersect(r1: RotatedRect, r2: RotatedRect): boolean {
  const w1 = f(r1[1][0]);
  const h1 = f(r1[1][1]);
  const w2 = f(r2[1][0]);
  const h2 = f(r2[1][1]);
  if (!(w1 > 0 && h1 > 0 && w2 > 0 && h2 > 0)) return false;
  const c1x = f(r1[0][0]);
  const c1y = f(r1[0][1]);
  const c2x = f(r2[0][0]);
  const c2y = f(r2[0][1]);
  const ax = f(f(c1x + c2x) / 2);
  const ay = f(f(c1y + c2y) / 2);
  const p1 = cornersf(f(c1x - ax), f(c1y - ay), w1, h1, f(r1[2]));
  const p2 = cornersf(f(c2x - ax), f(c2y - ay), w2, h2, f(r2[2]));
  const eps = f(f(1e-6) * Math.max(f(w1 * h1), f(w2 * h2)));
  let same = true;
  for (let i = 0; i < 4 && same; i++) if (Math.abs(f(p1[i][0] - p2[i][0])) > eps || Math.abs(f(p1[i][1] - p2[i][1])) > eps) same = false;
  if (same) return true;
  const v1: Pt[] = [];
  const v2: Pt[] = [];
  for (let i = 0; i < 4; i++) {
    v1.push([f(p1[(i + 1) % 4][0] - p1[i][0]), f(p1[(i + 1) % 4][1] - p1[i][1])]);
    v2.push([f(p2[(i + 1) % 4][0] - p2[i][0]), f(p2[(i + 1) % 4][1] - p2[i][1])]);
  }
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const x21 = f(p2[j][0] - p1[i][0]);
      const y21 = f(p2[j][1] - p1[i][1]);
      const [vx1, vy1] = v1[i];
      const [vx2, vy2] = v2[j];
      const det = f(f(vx2 * vy1) - f(vx1 * vy2));
      if (Math.abs(det) < 1e-12) continue;
      const inv = f(1 / det);
      const t1 = f(f(f(vx2 * y21) - f(vy2 * x21)) * inv);
      const t2 = f(f(f(vx1 * y21) - f(vy1 * x21)) * inv);
      if (!Number.isFinite(t1) || !Number.isFinite(t2)) continue;
      if (t1 >= 0 && t1 <= 1 && t2 >= 0 && t2 <= 1) return true;
    }
  }
  // corners of one rectangle on the same side of all four edges of the other (_isOnPositiveSide)
  const inside = (pts: Pt[], vec: Pt[], other: Pt[]) => {
    for (const [x, y] of pts) {
      let pos = 0;
      for (let j = 0; j < 4; j++) if (f(vec[j][1] * f(other[j][0] - x)) >= f(vec[j][0] * f(other[j][1] - y))) pos++;
      if (pos === 4 || pos === 0) return true;
    }
    return false;
  };
  return inside(p1, v2, p2) || inside(p2, v1, p1);
}

/** Truncation toward zero of float corners (numpy .astype(np.int64)). */
export function truncPts(p: Pt[]): number[] {
  const out: number[] = [];
  for (const [x, y] of p) out.push(Math.trunc(x), Math.trunc(y));
  return out;
}
