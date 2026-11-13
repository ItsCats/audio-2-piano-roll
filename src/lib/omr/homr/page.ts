/**
 * Page images for the homr reader: pixels → the pipeline's image, and a photo straightened to the four
 * page corners the user confirmed (not part of homr, which instead crops a photo to the paper itself;
 * with corners the page is straightened first, then homr's own steps run as usual).
 */
import { img, type Img } from './cv';
import type { PageInput, Quad } from './protocol';

/**
 * Longest side of a page image the reader works on, px. homr scales every page to 1920 px wide anyway,
 * but crops photos to the paper before that, on the full image (Python: numpy; here: typed arrays): a
 * 48-megapixel photo took 40 s and 2 GB there. Larger images are scaled down first (none of the test
 * pages is larger: 2400 x 3287 at most, so this does not change their results).
 */
export const MAX_INPUT_SIDE = 4000;
/**
 * Height / width beyond which an image is not read as one page: homr scales the width to 1920 px, so a
 * long screenshot (e.g. 351 x 3000) would become 1920 x 16,400 px, ~300 segmentation windows and
 * hundreds of MB. A4 is 1.41, two pages one above the other 2.8.
 */
export const MAX_ASPECT = 3;

/** Size that fits in maxSide (aspect kept). */
export function fitSize(w: number, h: number, maxSide = MAX_INPUT_SIDE): { w: number; h: number; scale: number } {
  const s = Math.min(1, maxSide / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)), scale: s };
}

/**
 * Pixels scaled down by area averaging to fit in maxSide (unchanged when they fit). Works on any
 * channel count; the scale is the same on both axes up to rounding.
 */
export function shrinkPixels(data: Uint8Array | Uint8ClampedArray, w: number, h: number, channels: number, maxSide = MAX_INPUT_SIDE): { data: Uint8Array; w: number; h: number } {
  const t = fitSize(w, h, maxSide);
  if (t.scale >= 1) return { data: data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength), w, h };
  const out = new Uint8Array(t.w * t.h * channels);
  const fx = w / t.w;
  const fy = h / t.h;
  const acc = new Float64Array(t.w * channels);
  const wsum = new Float64Array(t.w);
  for (let oy = 0; oy < t.h; oy++) {
    acc.fill(0);
    wsum.fill(0);
    const y0 = oy * fy;
    const y1 = (oy + 1) * fy;
    for (let y = Math.floor(y0); y < Math.min(h, Math.ceil(y1)); y++) {
      const wy = Math.min(y + 1, y1) - Math.max(y, y0);
      const row = y * w * channels;
      for (let ox = 0; ox < t.w; ox++) {
        const x0 = ox * fx;
        const x1 = (ox + 1) * fx;
        for (let x = Math.floor(x0); x < Math.min(w, Math.ceil(x1)); x++) {
          const wgt = wy * (Math.min(x + 1, x1) - Math.max(x, x0));
          const o = row + x * channels;
          for (let c = 0; c < channels; c++) acc[ox * channels + c] += data[o + c] * wgt;
          wsum[ox] += wgt;
        }
      }
    }
    for (let ox = 0; ox < t.w; ox++) for (let c = 0; c < channels; c++) out[(oy * t.w + ox) * channels + c] = Math.round(acc[ox * channels + c] / wsum[ox]);
  }
  return { data: out, w: t.w, h: t.h };
}

/** The image turned by 90 degrees clockwise (deg 90) or counter-clockwise (deg 270). */
export function rotate90(src: Img, deg: 90 | 270): Img {
  const out = img(src.h, src.w, src.c);
  const c = src.c;
  for (let y = 0; y < src.h; y++)
    for (let x = 0; x < src.w; x++) {
      // clockwise: (x, y) -> (h - 1 - y, x); counter-clockwise: (x, y) -> (y, w - 1 - x)
      const nx = deg === 90 ? src.h - 1 - y : y;
      const ny = deg === 90 ? x : src.w - 1 - x;
      const o = (y * src.w + x) * c;
      const n = (ny * out.w + nx) * c;
      for (let k = 0; k < c; k++) out.d[n + k] = src.d[o + k];
    }
  return out;
}

/** PageInput (gray, RGB or RGBA) → gray or RGB image */
export function pageImage(p: PageInput): Img {
  if (p.channels === 1) return { w: p.w, h: p.h, c: 1, d: p.data };
  if (p.channels === 3) return { w: p.w, h: p.h, c: 3, d: p.data };
  const out = img(p.w, p.h, 3);
  for (let i = 0, j = 0; i < p.w * p.h; i++, j += 4) {
    // transparent pixels (PNG) are paper
    const a = p.data[j + 3];
    if (a === 255) {
      out.d[3 * i] = p.data[j];
      out.d[3 * i + 1] = p.data[j + 1];
      out.d[3 * i + 2] = p.data[j + 2];
    } else {
      for (let c = 0; c < 3; c++) out.d[3 * i + c] = Math.round((p.data[j + c] * a + 255 * (255 - a)) / 255);
    }
  }
  return out;
}

/** 3 x 3 homography mapping the unit square's corners (0,0), (1,0), (1,1), (0,1) onto the quad */
function squareToQuad(q: Quad): number[] {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = den ? (sx * dy2 - dx2 * sy) / den : 0;
  const h = den ? (dx1 * sy - sx * dy1) / den : 0;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}

const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** The page inside the quad, straightened (bilinear), at the size of its longer edges. */
export function straighten(src: Img, q: Quad): Img {
  const w = Math.max(16, Math.round(Math.max(dist(q[0], q[1]), dist(q[3], q[2]))));
  const h = Math.max(16, Math.round(Math.max(dist(q[0], q[3]), dist(q[1], q[2]))));
  const H = squareToQuad(q);
  const out = img(w, h, src.c, 255);
  const c = src.c;
  for (let y = 0; y < h; y++) {
    const v = (y + 0.5) / h;
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w;
      const z = H[6] * u + H[7] * v + H[8];
      const sx = (H[0] * u + H[1] * v + H[2]) / z - 0.5;
      const sy = (H[3] * u + H[4] * v + H[5]) / z - 0.5;
      const ix = Math.floor(sx);
      const iy = Math.floor(sy);
      if (ix < 0 || iy < 0 || ix + 1 >= src.w || iy + 1 >= src.h) continue;
      const fx = sx - ix;
      const fy = sy - iy;
      const o = (iy * src.w + ix) * c;
      const r = src.w * c;
      for (let k = 0; k < c; k++) {
        const a = src.d[o + k] * (1 - fx) + src.d[o + c + k] * fx;
        const b = src.d[o + r + k] * (1 - fx) + src.d[o + r + c + k] * fx;
        out.d[(y * w + x) * c + k] = Math.round(a * (1 - fy) + b * fy);
      }
    }
  }
  return out;
}
