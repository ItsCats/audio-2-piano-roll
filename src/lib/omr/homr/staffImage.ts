/**
 * The image of one staff for the transformer: region, scaling, dewarping, cleanup and the
 * 1280 x 256 canvas. Port of prepare_staff_image and its helpers in homr/staff_parsing.py,
 * homr/staff_dewarping.py and homr/image_utils.py.
 *
 * The dewarping mesh is triangulated with a port of OpenCV's Subdiv2D (subdiv2d.ts): the same
 * triangles in the same order as homr, which matters for the pixels on shared triangle edges.
 *
 * Derived from homr (AGPL-3.0, Copyright the homr contributors, https://github.com/liebharc/homr).
 */
import { fillConvexPoly, img, resizeLinear, warpAffine, type Img } from './cv';
import { boundingRect, boundingRectF, findContours, type Pt } from './geom';
import { pyRound, type MultiStaff, type Staff } from './model';
import { Subdiv2D } from './subdiv2d';

export const TR_HEIGHT = 256;
export const TR_WIDTH = 1280;

/** homr get_tr_omr_canvas_size: (width, height) that fits 1280 x 256 keeping the aspect ratio */
export function canvasSize(h: number, w: number): [number, number] {
  const ratio = TR_HEIGHT / TR_WIDTH;
  if (h / w > ratio) return [Math.trunc((w / h) * TR_HEIGHT), TR_HEIGHT];
  return [TR_WIDTH, Math.trunc((h / w) * TR_WIDTH)];
}

export class StaffRegions {
  centers: [number, number][];
  constructor(staffs: MultiStaff[]) {
    this.centers = staffs.flatMap((ms) => ms.staffs.map((s) => [s.minY, s.maxY] as [number, number]));
  }
  above(y: number): number {
    const a = this.centers.filter((c) => c[0] < y).map((c) => c[1]);
    return a.length ? Math.max(...a) : 0;
  }
  below(y: number): number {
    const b = this.centers.filter((c) => c[1] > y).map((c) => c[0]);
    return b.length ? Math.min(...b) : 1e12;
  }
}

const limit = (v: number, n: number) => Math.max(0, Math.min(n - 1, pyRound(v)));

/** homr crop_image_and_return_new_top (the far edge is exclusive and limited to size - 1) */
function cropImage(im: Img, x1: number, y1: number, x2: number, y2: number): { image: Img; top: Pt } {
  const xa = limit(Math.min(x1, x2), im.w);
  const ya = limit(Math.min(y1, y2), im.h);
  const xb = limit(Math.max(x1, x2), im.w);
  const yb = limit(Math.max(y1, y2), im.h);
  const w = Math.max(0, xb - xa);
  const h = Math.max(0, yb - ya);
  const out = img(w, h);
  for (let y = 0; y < h; y++) out.d.set(im.d.subarray((y + ya) * im.w + xa, (y + ya) * im.w + xa + w), y * w);
  return { image: out, top: [xa, ya] };
}

// ------------------------------------------------------------------ dewarping

/**
 * homr DelaunayTriangulation: OpenCV's Subdiv2D over the points' bounding rectangle (+10 px), its
 * triangle list mapped back to point indices (the first point within 1e-3; triangles with a corner
 * that is no input point are dropped). Same triangles in the same order as Python homr.
 */
export function delaunay(points: Pt[]): [number, number, number][] {
  if (points.length < 3) throw new Error('Need at least 3 points for triangulation');
  const pts = points.map(([x, y]) => [Math.fround(x), Math.fround(y)] as Pt);
  const r = boundingRectF(pts);
  const sub = new Subdiv2D([r[0] - 10, r[1] - 10, r[2] + 20, r[3] + 20]);
  for (const [x, y] of pts) sub.insert(x, y);
  const index = (p: Pt): number | null => {
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const d = Math.fround(Math.hypot(pts[i][0] - p[0], pts[i][1] - p[1]));
      if (d < bd) (bd = d), (best = i);
    }
    return bd < 1e-3 ? best : null;
  };
  const out: [number, number, number][] = [];
  for (const t of sub.getTriangleList()) {
    const a = index(t[0]);
    const b = index(t[1]);
    const c = index(t[2]);
    if (a !== null && b !== null && c !== null) out.push([a, b, c]);
  }
  return out;
}

/** cv2.getAffineTransform: the 2 x 3 matrix mapping three points onto three points */
function affine(src: Pt[], dst: Pt[]): number[] | null {
  const [[x0, y0], [x1, y1], [x2, y2]] = src;
  const det = x0 * (y1 - y2) - y0 * (x1 - x2) + (x1 * y2 - x2 * y1);
  if (det === 0) return null;
  const solve = (u0: number, u1: number, u2: number) => {
    const a = (u0 * (y1 - y2) - y0 * (u1 - u2) + (u1 * y2 - u2 * y1)) / det;
    const b = (x0 * (u1 - u2) - u0 * (x1 - x2) + (x1 * u2 - x2 * u1)) / det;
    const c = (x0 * (y1 * u2 - y2 * u1) - y0 * (x1 * u2 - x2 * u1) + u0 * (x1 * y2 - x2 * y1)) / det;
    return [a, b, c];
  };
  return [...solve(dst[0][0], dst[1][0], dst[2][0]), ...solve(dst[0][1], dst[1][1], dst[2][1])];
}

const f32 = (p: Pt): Pt => [Math.fround(p[0]), Math.fround(p[1])];
const triArea = (t: Pt[]) => Math.abs((t[1][0] - t[0][0]) * (t[2][1] - t[0][1]) - (t[1][1] - t[0][1]) * (t[2][0] - t[0][0])) / 2;

/** homr PiecewiseAffineTransform.warp_image (fill 1, bilinear) */
function warpPiecewise(image: Img, src: Pt[], dst: Pt[]): Img {
  const tris = delaunay(src);
  const out = img(image.w, image.h, 1, 1);
  for (const s of tris) {
    const st = s.map((i) => f32(src[i]));
    const dt = s.map((i) => f32(dst[i]));
    if (triArea(st) < 1e-6 || triArea(dt) < 1e-6) continue;
    if (!affine(st, dt)) continue;
    const sr = boundingRectF(st);
    const dr = boundingRectF(dt);
    if (sr[2] <= 0 || sr[3] <= 0 || dr[2] <= 0 || dr[3] <= 0) continue;
    const stc = st.map(([x, y]) => [Math.fround(x - sr[0]), Math.fround(y - sr[1])] as Pt);
    const dtc = dt.map(([x, y]) => [Math.fround(x - dr[0]), Math.fround(y - dr[1])] as Pt);
    if (triArea(stc) < 1e-6 || triArea(dtc) < 1e-6) continue;
    const M = affine(stc, dtc);
    if (!M) continue;
    // numpy slice of the source rectangle (clipped to the image)
    const sx0 = Math.max(0, sr[0]);
    const sy0 = Math.max(0, sr[1]);
    const sx1 = Math.min(image.w, sr[0] + sr[2]);
    const sy1 = Math.min(image.h, sr[1] + sr[3]);
    if (sx1 <= sx0 || sy1 <= sy0) continue;
    const crop = img(sx1 - sx0, sy1 - sy0);
    for (let y = sy0; y < sy1; y++) crop.d.set(image.d.subarray(y * image.w + sx0, y * image.w + sx1), (y - sy0) * crop.w);
    const warped = warpAffine(crop, M, dr[2], dr[3], 1);
    const mask = img(dr[2], dr[3]);
    fillConvexPoly(
      mask,
      dtc.map(([x, y]) => [Math.trunc(x), Math.trunc(y)] as [number, number]),
      255,
    );
    const y1 = Math.max(0, dr[1]);
    const y2 = Math.min(image.h, dr[1] + dr[3]);
    const x1 = Math.max(0, dr[0]);
    const x2 = Math.min(image.w, dr[0] + dr[2]);
    for (let y = y1; y < y2; y++) {
      for (let x = x1; x < x2; x++) {
        const o = (y - dr[1]) * dr[2] + (x - dr[0]);
        if (mask.d[o]) out.d[y * image.w + x] = warped.d[o];
      }
    }
  }
  return out;
}

function isOnImage(p: Pt, im: Img): boolean {
  const m = 10;
  return !(p[0] < m || p[0] > im.w - m || p[1] < m || p[1] > im.h - m);
}

/** homr dewarp_staff_image + StaffDewarping.dewarp (no dewarping when the mesh cannot be built) */
function dewarpStaffImage(image: Img, staff: Staff): Img {
  try {
    const span: Pt[][] = [];
    const optimal: Pt[][] = [];
    let first: number | null = null;
    const step = Math.trunc(image.h / 6);
    if (step === 0) return image;
    for (let y = 2; y < image.h - 2; y += step) {
      const line: Pt[] = [];
      for (let x = 2; x < image.w; x += 80) {
        const p = staff.getAt(x);
        if (!p) continue;
        const yo = p.y[2];
        let dy: number;
        if (!first) {
          first = yo;
          dy = 0;
        } else dy = Math.trunc(yo - first);
        const pt: Pt = [x, y + dy];
        if (isOnImage(pt, image)) line.push(pt);
      }
      if (line.length > 2) {
        const avg = line.reduce((a, p) => a + p[1], 0) / line.length;
        span.push(line);
        optimal.push(line.map((p) => [p[0], Math.trunc(avg)]));
      }
    }
    const complete = (lines: Pt[][]): Pt[] => {
      const ls = lines.map((l) => [[0, l[0][1]] as Pt, ...l, [image.w, l[l.length - 1][1]] as Pt]);
      return [
        [0, 0],
        [image.w, 0],
        ...ls.flat(),
        [0, image.h],
        [image.w, image.h],
      ];
    };
    return warpPiecewise(image, complete(span), complete(optimal));
  } catch {
    return image;
  }
}

/** homr remove_black_contours_at_edges_of_image (in place) */
function removeBlackContoursAtEdges(gray: Img, unit: number): Img {
  const t = img(gray.w, gray.h);
  for (let i = 0; i < t.d.length; i++) t.d[i] = gray.d[i] > 97 ? 0 : 255;
  const th = 2 * unit;
  for (const c of findContours(t.d, t.w, t.h, 'tree')) {
    const [x, y, w, h] = boundingRect(c);
    if (w < th || h < th) continue;
    if (!(x === 0 || y === 0 || x + w === gray.w || y + h === gray.h)) continue;
    let sum = 0;
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) sum += t.d[yy * t.w + xx];
    if (sum / (w * h) < 127) continue;
    for (let yy = y; yy < y + h; yy++) gray.d.fill(255, yy * gray.w + x, yy * gray.w + x + w);
  }
  return gray;
}

/** homr center_image_on_canvas: resized into the 1280 x 256 canvas, centred vertically, white elsewhere */
function centerOnCanvas(image: Img, size: [number, number]): Img {
  const r = resizeLinear(image, size[0], size[1]);
  const out = img(TR_WIDTH, TR_HEIGHT, 1, 255);
  const yo = Math.floor((TR_HEIGHT - r.h) / 2);
  for (let y = 0; y < r.h; y++) {
    const ty = y + yo;
    if (ty < 0 || ty >= TR_HEIGHT) continue;
    out.d.set(r.d.subarray(y * r.w, y * r.w + Math.min(r.w, TR_WIDTH)), ty * TR_WIDTH);
  }
  return out;
}

/** homr prepare_staff_image: the transformer's 1280 x 256 input for one staff of the (CLAHE) page */
export function prepareStaffImage(staff: Staff, page: Img, regions: StaffRegions): Img {
  const u = staff.averageUnitSize;
  const region = [
    Math.trunc(staff.minX - 2 * u),
    Math.trunc(Math.max(staff.minY - 4 * u, regions.above(staff.minY))),
    Math.trunc(staff.maxX + 2 * u),
    Math.trunc(Math.min(staff.maxY + 4 * u, regions.below(staff.maxY))),
  ];
  const dims = canvasSize(region[3] - region[1], region[2] - region[0]);
  const s = dims[1] / (region[3] - region[1]);
  const scaled = resizeLinear(page, Math.trunc(page.w * s), Math.trunc(page.h * s));
  const r = region.map((v) => roundHalfEven(v * s));
  const c1 = cropImage(scaled, r[0] - 10, r[1] - 50, r[2] + 10, r[3] + 50);
  const r2 = [r[0] - c1.top[0], r[1] - c1.top[1], r[2] - c1.top[0], r[3] - c1.top[1]];
  const tl: Pt = [c1.top[0] / s, c1.top[1] / s];
  const local = staff.transform(([x, y]) => [(x - tl[0]) * s, (y - tl[1]) * s]);
  const dewarped = dewarpStaffImage(c1.image, local);
  const c2 = cropImage(dewarped, r2[0], r2[1], r2[2], r2[3]);
  const clean = removeBlackContoursAtEdges(c2.image, local.averageUnitSize);
  return centerOnCanvas(clean, dims);
}

/** numpy.round (half to even) */
function roundHalfEven(v: number): number {
  return pyRound(v);
}

/** homr ConvertToArray: (pixel / 255 - 0.7931) / 0.1738 as the encoder's [1, 1, 256, 1280] input */
export function encoderInput(staffImage: Img, out = new Float32Array(TR_HEIGHT * TR_WIDTH)): Float32Array {
  for (let i = 0; i < out.length; i++) out[i] = (staffImage.d[i] / 255 - 0.7931) / 0.1738;
  return out;
}
