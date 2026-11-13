import { describe, expect, it } from 'vitest';
import {
  boundingRect,
  boxPoints,
  contourArea,
  convexHullIndices,
  ellipse2Poly,
  findContours,
  fitEllipse,
  intersectConvexConvexArea,
  minAreaRect,
  pointPolygonTest,
  rotatedRectsIntersect,
  truncPts,
  type RotatedRect,
} from '../../../src/lib/omr/homr/geom';
import { loadCvFixtures, unpack } from './fixtures';

const fx = loadCvFixtures();

describe('homr geometry vs cv2', () => {
  it('findContours (RETR_TREE / RETR_EXTERNAL, CHAIN_APPROX_SIMPLE) gives the same contours in the same order', () => {
    for (const c of fx.cases) {
      const m = unpack(c.mask);
      expect(findContours(m, c.w, c.h, 'tree').map((x) => Array.from(x))).toEqual(c.tree);
      expect(findContours(m, c.w, c.h, 'external').map((x) => Array.from(x))).toEqual(c.external);
    }
  });

  it('convexHull, minAreaRect, contourArea, boundingRect, fitEllipse', () => {
    let ellipses = 0;
    for (const c of fx.cases) {
      c.tree.forEach((pts: number[], i: number) => {
        const item = c.items[i];
        expect(convexHullIndices(pts).flatMap((k) => [pts[2 * k], pts[2 * k + 1]])).toEqual(item.hull);
        const r = minAreaRect(pts);
        expect([r[0], r[1]]).toEqual([item.rect[0], item.rect[1]]);
        // the angle can differ in the last bit of its float
        expect(r[2]).toBeCloseTo(item.rect[2], 4);
        expect(contourArea(pts)).toBeCloseTo(item.area, 6);
        expect(boundingRect(pts)).toEqual(item.brect);
        if (item.ellipse) {
          const e = fitEllipse(pts);
          ellipses++;
          if (item.ellipse[1][0] < 1) return; // degenerate (a line): homr drops these by size
          expect(e[0][0]).toBeCloseTo(item.ellipse[0][0], 2);
          expect(e[0][1]).toBeCloseTo(item.ellipse[0][1], 2);
          expect(e[1][0]).toBeCloseTo(item.ellipse[1][0], 2);
          expect(e[1][1]).toBeCloseTo(item.ellipse[1][1], 2);
          // circles (and degenerate fits) have no defined angle: OpenCV's SVD finds exact zeros there
          // where another least-squares solver has rounding noise
          if (Math.abs(item.ellipse[1][0] - item.ellipse[1][1]) > 1e-3 && item.ellipse[1][0] > 1) expect(((e[2] - item.ellipse[2] + 540) % 180) - 0).toBeCloseTo(0, 2);
        }
      });
    }
    expect(ellipses).toBeGreaterThan(50);
  });

  it('boxPoints, rotatedRectangleIntersection, intersectConvexConvex, pointPolygonTest, ellipse2Poly', () => {
    for (const r of fx.rects) {
      const r1 = r.r1 as RotatedRect;
      const p = boxPoints(r1).flat();
      p.forEach((v, i) => expect(v).toBeCloseTo(r.p1[i], 4));
      expect(rotatedRectsIntersect(r1, r.r2)).toBe(r.intersect);
      expect(intersectConvexConvexArea(boxPoints(r1), boxPoints(r.r2))).toBeCloseTo(r.area, 2);
      expect(pointPolygonTest(truncPts(boxPoints(r1)), r.pt[0], r.pt[1])).toBe(r.test);
      const e = ellipse2Poly([Math.trunc(r1[0][0]), Math.trunc(r1[0][1])], [Math.trunc(r1[1][0] / 2), Math.trunc(r1[1][1] / 2)], Math.trunc(r1[2]));
      expect(e).toEqual(r.ellipse);
    }
  });
});
