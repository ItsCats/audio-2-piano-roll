// SPDX-License-Identifier: AGPL-3.0-only
// Modified (TypeScript port of homr 0.7.1) by the Piano2Vision contributors, 2026; see README.md here.
/**
 * Bounding boxes of the detected symbols: port of homr/bounding_boxes.py.
 *
 * Derived from homr (AGPL-3.0, Copyright the homr contributors, https://github.com/liebharc/homr).
 */
import { boxPoints, ellipse2Poly, findContours, fitEllipse, intersectConvexConvexArea, minAreaRect, pointPolygonTest, rotatedRectsIntersect, truncPts, type Pt, type RotatedRect } from './geom';
import type { Img } from './cv';

/** Python homr's box equality: the RotatedRect tuple. */
export function boxKey(b: RotatedRect): string {
  return `${b[0][0]},${b[0][1]},${b[1][0]},${b[1][1]},${b[2]}`;
}

function polyPts(p: number[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < p.length; i += 2) out.push([p[i], p[i + 1]]);
  return out;
}

/** homr's do_polygons_overlap: convex intersection area, or touching (a vertex on / in the other). */
export function polygonsOverlap(p1: number[], p2: number[]): boolean {
  if (intersectConvexConvexArea(polyPts(p1), polyPts(p2)) > 0) return true;
  for (let i = 0; i < p1.length; i += 2) if (pointPolygonTest(p2, p1[i], p1[i + 1]) >= 0) return true;
  for (let i = 0; i < p2.length; i += 2) if (pointPolygonTest(p1, p2[i], p2[i + 1]) >= 0) return true;
  return false;
}

export interface Polygonal {
  polygon: number[];
}

/** An axis-aligned box (x1, y1, x2, y2). */
export class BoundingBox implements Polygonal {
  box: [number, number, number, number];
  center: Pt;
  size: Pt;
  rotatedBox: RotatedRect;
  polygon: number[];
  constructor(
    box: [number, number, number, number],
    public contours: Int32Array,
    public debugId = 0,
  ) {
    this.box = box;
    this.center = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    this.size = [box[2] - box[0], box[3] - box[1]];
    this.rotatedBox = [this.center, this.size, 0];
    this.polygon = truncPts(boxPoints(this.rotatedBox));
  }
}

export abstract class AngledBoundingBox implements Polygonal {
  box: RotatedRect;
  center: Pt;
  size: Pt;
  angle: number;
  topLeft: Pt;
  bottomLeft: Pt;
  topRight: Pt;
  bottomRight: Pt;
  readonly key: string;
  constructor(
    box: RotatedRect,
    public contours: Int32Array,
    public polygon: number[],
    public debugId = 0,
  ) {
    let angle = box[2];
    const c: Pt = [box[0][0], box[0][1]];
    if (angle > 135) this.box = [c, [box[1][0], box[1][1]], angle - 180];
    else if (angle < -135) this.box = [c, [box[1][0], box[1][1]], angle + 180];
    else if (angle > 45) this.box = [c, [box[1][1], box[1][0]], angle - 90];
    else if (angle < -45) this.box = [c, [box[1][1], box[1][0]], angle + 90];
    else this.box = [c, [box[1][0], box[1][1]], angle];
    angle = this.box[2];
    this.center = this.box[0];
    this.size = this.box[1];
    this.angle = angle;
    const hw = this.box[1][0] / 2;
    const hh = this.box[1][1] / 2;
    const [cx, cy] = this.center;
    this.topLeft = [cx - hw, cy - hh];
    this.bottomLeft = [cx - hw, cy + hh];
    this.topRight = [cx + hw, cy - hh];
    this.bottomRight = [cx + hw, cy + hh];
    this.key = boxKey(this.box);
  }

  /** the box tuple a symbol is compared with (BoundingBox: its rotated box) */
  static boxOf(o: Polygonal): RotatedRect {
    if (o instanceof BoundingBox) return o.rotatedBox;
    if (o instanceof AngledBoundingBox) return o.box;
    throw new Error('Unknown box type');
  }

  canTouch(other: Polygonal): boolean {
    const [c1, a1] = this.box;
    const [c2, a2] = AngledBoundingBox.boxOf(other);
    const d = Math.sqrt((c1[0] - c2[0]) ** 2 + (c1[1] - c2[1]) ** 2);
    return !(d > Math.max(a1[0], a1[1]) + Math.max(a2[0], a2[1]));
  }

  isOverlapping(other: Polygonal): boolean {
    if (!this.canTouch(other)) return false;
    return polygonsOverlap(this.polygon, other.polygon);
  }

  isOverlappingWithAny(others: Polygonal[]): boolean {
    for (const o of others) if (this.isOverlapping(o)) return true;
    return false;
  }

  equals(o: AngledBoundingBox): boolean {
    return this.key === o.key;
  }
}

export class RotatedBoundingBox extends AngledBoundingBox {
  constructor(box: RotatedRect, contours: Int32Array, debugId = 0) {
    super(box, contours, truncPts(boxPoints(box)), debugId);
  }

  isIntersecting(other: RotatedBoundingBox): boolean {
    if (!this.canTouch(other)) return false;
    return rotatedRectsIntersect(this.box, other.box);
  }

  makeBoxThicker(t: number): RotatedBoundingBox {
    if (t <= 0) return this;
    return new RotatedBoundingBox([[this.box[0][0], this.box[0][1]], [this.box[1][0] + t, this.box[1][1] + t], this.box[2]], this.contours, this.debugId);
  }

  moveToXHorizontalBy(dx: number): RotatedBoundingBox {
    return new RotatedBoundingBox([[this.center[0] + dx, this.center[1]], this.box[1], this.box[2]], this.contours, this.debugId);
  }

  makeBoxTaller(t: number): RotatedBoundingBox {
    return new RotatedBoundingBox([[this.box[0][0], this.box[0][1]], [this.box[1][0], this.box[1][1] + t], this.box[2]], this.contours, this.debugId);
  }

  getCenterExtrapolated(x: number): number {
    return (x - this.box[0][0]) * Math.tan((this.box[2] / 180) * Math.PI) + this.box[0][1];
  }

  isOverlappingExtrapolated(other: RotatedBoundingBox, unitSize: number): boolean {
    const [left, right] = this.box[0][0] > other.box[0][0] ? [other, this as RotatedBoundingBox] : [this as RotatedBoundingBox, other];
    const centerX = (left.center[0] + right.center[0]) * 0.5;
    const tolerance = unitSize / 3;
    const maxGap = 5 * unitSize;
    if (centerX - left.center[0] - Math.floor(left.size[0] / 2) > maxGap || right.center[0] - centerX - Math.floor(right.size[0] / 2) > maxGap) return false;
    const la = Math.tan((left.box[2] * Math.PI) / 180);
    const ra = Math.tan((right.box[2] * Math.PI) / 180);
    const ly = (centerX - left.box[0][0]) * la + left.box[0][1];
    const ry = (centerX - right.box[0][0]) * ra + right.box[0][1];
    return Math.abs(ly - ry) <= tolerance;
  }
}

export class BoundingEllipse extends AngledBoundingBox {
  constructor(box: RotatedRect, contours: Int32Array, debugId = 0) {
    super(box, contours, ellipse2Poly([Math.trunc(box[0][0]), Math.trunc(box[0][1])], [Math.trunc(box[1][0] / 2), Math.trunc(box[1][1] / 2)], Math.trunc(box[2])), debugId);
  }

  makeBoxThicker(t: number): BoundingEllipse {
    return new BoundingEllipse([[this.box[0][0], this.box[0][1]], [this.box[1][0] + t, this.box[1][1] + t], this.box[2]], this.contours, this.debugId);
  }
}

const validSize = (b: RotatedRect) => !Number.isNaN(b[1][0]) && !Number.isNaN(b[1][1]) && b[1][0] > 0 && b[1][1] > 0;

function concat(contours: Int32Array[]): Int32Array {
  let n = 0;
  for (const c of contours) n += c.length;
  const out = new Int32Array(n);
  let o = 0;
  for (const c of contours) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export function concatContours(contours: Int32Array[]): Int32Array {
  return concat(contours);
}

/** homr create_rotated_bounding_boxes: one box per contour (RETR_TREE), optionally merged where they overlap. */
export function createRotatedBoundingBoxes(
  mask: Img,
  opts: { skipMerging?: boolean; minSize?: [number, number]; maxSize?: [number, number]; thicken?: number } = {},
): RotatedBoundingBox[] {
  const contours = findContours(mask.d, mask.w, mask.h, 'tree');
  let boxes: RotatedBoundingBox[] = [];
  contours.forEach((c, i) => {
    const r = minAreaRect(c);
    if (!validSize(r)) return;
    const box = new RotatedBoundingBox(r, c, i);
    const { minSize, maxSize } = opts;
    if (minSize && (box.size[0] < minSize[0] || box.size[1] < minSize[1])) return;
    if (maxSize) {
      if (maxSize[0] > 0 && box.size[0] > maxSize[0]) return;
      if (maxSize[1] > 0 && box.size[1] > maxSize[1]) return;
    }
    boxes.push(box);
  });
  if (opts.skipMerging) return boxes;
  if (opts.thicken !== undefined) boxes = boxes.map((b) => b.makeBoxThicker(opts.thicken as number));
  return mergeOverlapping(boxes).map((g) => {
    const all = concat(g.map((b) => b.contours));
    return new RotatedBoundingBox(minAreaRect(all), all);
  });
}

export function createRotatedBoundingBox(contour: Int32Array, debugId: number): RotatedBoundingBox {
  return new RotatedBoundingBox(minAreaRect(contour), contour, debugId);
}

/** homr create_bounding_ellipses: fitted ellipses per contour, merged where they overlap (then a min-area box). */
export function createBoundingEllipses(mask: Img, minSize?: [number, number], maxSize?: [number, number]): BoundingEllipse[] {
  const contours = findContours(mask.d, mask.w, mask.h, 'tree');
  const boxes: BoundingEllipse[] = [];
  contours.forEach((c, i) => {
    if (c.length / 2 < 5) return;
    const r = fitEllipse(c);
    if (!validSize(r)) return;
    const box = new BoundingEllipse(r, c, i);
    if (minSize && (box.size[0] < minSize[0] || box.size[1] < minSize[1])) return;
    if (maxSize && (box.size[0] > maxSize[0] || box.size[1] > maxSize[1])) return;
    boxes.push(box);
  });
  return mergeOverlapping(boxes).map((g) => {
    const all = concat(g.map((b) => b.contours));
    return new BoundingEllipse(minAreaRect(all), all);
  });
}

/** homr _merge_groups_optimized on single boxes: union-find over overlapping pairs, groups in order of first member. */
export function mergeOverlapping<T extends AngledBoundingBox>(boxes: T[]): T[][] {
  const n = boxes.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const rank = new Array<number>(n).fill(0);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (rank[ra] > rank[rb]) parent[rb] = ra;
    else if (rank[ra] < rank[rb]) parent[ra] = rb;
    else {
      parent[rb] = ra;
      rank[ra]++;
    }
  };
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (boxes[i].isOverlapping(boxes[j])) union(i, j);
  const groups = new Map<number, T[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let g = groups.get(r);
    if (!g) groups.set(r, (g = []));
    g.push(boxes[i]);
  }
  return [...groups.values()];
}
