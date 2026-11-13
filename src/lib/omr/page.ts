/**
 * Page clean-up before staff finding (src/lib/omr): find the sheet of paper in a photo, straighten it,
 * even out the lighting and remove a small tilt. Pure TypeScript on Gray images (image.ts).
 */
import { binarize, close, gaussianF, gray, otsu, percentile, resize, rotate, toGray, warpQuad, type Gray, type Quad } from './image';

/** Width the page is straightened / scaled to before staff finding (an A4 page at 200 dpi). */
export const PAGE_WIDTH = 1654;

/**
 * Corners of the sheet of paper in a photo (largest bright region), or null when no clear page edge
 * is visible (a scan, or a photo filled by the page). Corners are in `img` pixels: top-left, top-right,
 * bottom-right, bottom-left.
 */
export function detectPageQuad(img: Gray): Quad | null {
  const sc = Math.max(img.w, img.h) / 800;
  const small = sc > 1 ? resize(img, img.w / sc, img.h / sc) : img;
  const s = sc > 1 ? sc : 1;
  const { w, h } = small;
  const blur = toGray(gaussianF(small, 1.1), w, h);
  const t = otsu(blur.d);
  // bright = paper; closing the mask fills the printed music
  const mask = gray(w, h, 0);
  for (let i = 0; i < mask.d.length; i++) mask.d[i] = blur.d[i] > t ? 255 : 0;
  const closed = close(mask, 15);
  // largest bright connected region (4-connected flood fill)
  const label = new Int32Array(w * h).fill(-1);
  let best = -1;
  let bestArea = 0;
  const stack = new Int32Array(w * h);
  let next = 0;
  for (let i = 0; i < w * h; i++) {
    if (closed.d[i] !== 255 || label[i] >= 0) continue;
    const id = next++;
    let sp = 0;
    stack[sp++] = i;
    label[i] = id;
    let area = 0;
    while (sp) {
      const p = stack[--sp];
      area++;
      const x = p % w;
      const y = (p - x) / w;
      const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of nb) {
        if (q >= 0 && label[q] < 0 && closed.d[q] === 255) {
          label[q] = id;
          stack[sp++] = q;
        }
      }
    }
    if (area > bestArea) {
      bestArea = area;
      best = id;
    }
  }
  if (best < 0) return null;
  const frac = bestArea / (w * h);
  if (frac < 0.25 || frac > 0.995) return null;
  // corners: extremes along the diagonals
  let tl = [0, 0];
  let tr = [0, 0];
  let br = [0, 0];
  let bl = [0, 0];
  let mTl = Infinity;
  let mBr = -Infinity;
  let mTr = -Infinity;
  let mBl = Infinity;
  let touches = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (label[y * w + x] !== best) continue;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches++;
      const a = x + y;
      const b = x - y;
      if (a < mTl) (mTl = a), (tl = [x, y]);
      if (a > mBr) (mBr = a), (br = [x + 1, y + 1]);
      if (b > mTr) (mTr = b), (tr = [x + 1, y]);
      if (b < mBl) (mBl = b), (bl = [x, y + 1]);
    }
  }
  // a region running along most of the image border is the whole photo, not a page on a table
  if (touches > 1.2 * (w + h)) return null;
  const q: Quad = [
    [tl[0] * s, tl[1] * s],
    [tr[0] * s, tr[1] * s],
    [br[0] * s, br[1] * s],
    [bl[0] * s, bl[1] * s],
  ];
  // reject degenerate shapes (a very thin or self-crossing outline)
  const area = Math.abs(shoelace(q));
  if (area < 0.2 * img.w * img.h) return null;
  return q;
}

function shoelace(q: Quad): number {
  let a = 0;
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = q[i];
    const [x1, y1] = q[(i + 1) % 4];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

/** Puts four corners in the order top-left, top-right, bottom-right, bottom-left. */
export function orderQuad(pts: number[][]): Quad {
  const sum = pts.map((p) => p[0] + p[1]);
  const diff = pts.map((p) => p[1] - p[0]);
  const at = (arr: number[], f: (a: number, b: number) => boolean) => arr.reduce((bi, v, i) => (f(v, arr[bi]) ? i : bi), 0);
  const tl = pts[at(sum, (a, b) => a < b)];
  const br = pts[at(sum, (a, b) => a > b)];
  const tr = pts[at(diff, (a, b) => a < b)];
  const bl = pts[at(diff, (a, b) => a > b)];
  return [
    [tl[0], tl[1]],
    [tr[0], tr[1]],
    [br[0], br[1]],
    [bl[0], bl[1]],
  ];
}

/**
 * Background division: a large closing estimates the paper brightness under the ink, dividing by it
 * removes shadows and uneven light; then paper → 255 and the darkest 1 % → 0.
 */
export function normalizeLight(img: Gray): Gray {
  const k = Math.max(15, Math.floor(img.w / 40)) | 1;
  // the closing at half size (4x cheaper; the background is smooth anyway)
  const half = resize(img, img.w / 2, img.h / 2);
  const kh = Math.max(7, Math.floor(k / 2)) | 1;
  const bgSmall = toGray(gaussianF(close(half, kh), kh / 2), half.w, half.h);
  const bg = resize(bgSmall, img.w, img.h);
  const norm = new Float32Array(img.d.length);
  for (let i = 0; i < norm.length; i++) norm[i] = Math.min(255, (img.d[i] / Math.max(1, bg.d[i])) * 255);
  const lo = percentile(norm, 0.01);
  const span = Math.max(1, 245 - lo);
  const d = new Uint8Array(norm.length);
  for (let i = 0; i < d.length; i++) {
    const v = ((norm[i] - lo) / span) * 255;
    d[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }
  return { w: img.w, h: img.h, d };
}

/**
 * Small tilt (within ±4°) that makes the staff lines most horizontal: the angle whose row projection of
 * the ink is sharpest. Returns degrees for rotate().
 */
export function skewAngle(img: Gray): number {
  const half = resize(img, img.w / 2, img.h / 2);
  const ink = binarize(half);
  const { w, h } = half;
  const xs: number[] = [];
  const ys: number[] = [];
  // subsample the ink pixels (every other column) to keep this fast on big pages
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x += 2) if (ink[y * w + x]) (xs.push(x - w / 2), ys.push(y - h / 2));
  if (xs.length < 100) return 0;
  const n = h + 2 * Math.ceil(w * 0.08) + 4;
  const off = n / 2;
  const prof = new Float64Array(n);
  const score = (deg: number) => {
    const a = (deg * Math.PI) / 180;
    const c = Math.cos(a);
    const s = Math.sin(a);
    prof.fill(0);
    // row of the point after rotating the page by `deg` (see rotate())
    for (let i = 0; i < xs.length; i++) {
      const r = Math.round(-xs[i] * s + ys[i] * c + off);
      if (r >= 0 && r < n) prof[r]++;
    }
    let sum = 0;
    for (let i = 0; i < n; i++) sum += prof[i] * prof[i];
    return sum;
  };
  let best = 0;
  let bestS = -1;
  for (let a = -4; a <= 4.001; a += 0.25) {
    const sc = score(a);
    if (sc > bestS) (bestS = sc), (best = a);
  }
  const a0 = best;
  for (let a = a0 - 0.25; a <= a0 + 0.2501; a += 0.05) {
    const sc = score(a);
    if (sc > bestS) (bestS = sc), (best = a);
  }
  return Math.abs(best) < 0.04 ? 0 : best;
}

export function deskew(img: Gray): Gray {
  const a = skewAngle(img);
  return a ? rotate(img, a) : img;
}

export interface PrepareOptions {
  /** page corners in `img` pixels (photos: from the corner screen); omitted = whole image */
  quad?: Quad | null;
  /** look for the page outline when no quad is given (photos) */
  findPage?: boolean;
}

/** The page as the staff finder wants it: straightened, PAGE_WIDTH wide, even lighting, level. */
export function preparePage(img: Gray, opts: PrepareOptions = {}): { page: Gray; quad: Quad | null } {
  let quad = opts.quad ?? null;
  if (!quad && opts.findPage) quad = detectPageQuad(img);
  let page: Gray;
  if (quad) page = warpQuad(img, quad, PAGE_WIDTH);
  else page = img.w === PAGE_WIDTH ? img : resize(img, PAGE_WIDTH, (img.h * PAGE_WIDTH) / img.w);
  return { page: deskew(normalizeLight(page)), quad };
}
