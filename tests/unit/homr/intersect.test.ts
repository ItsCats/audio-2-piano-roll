// rotatedRectsIntersect (src/lib/omr/homr/geom.ts) against cv2.rotatedRectangleIntersection on rectangles
// that touch or almost touch, where OpenCV's float32 arithmetic decides (fixtures: tests/homr/make_fixtures.py).
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { rotatedRectsIntersect, type RotatedRect } from '../../../src/lib/omr/homr/geom';

const rows: { r1: RotatedRect; r2: RotatedRect; intersect: boolean }[] = JSON.parse(readFileSync(new URL('./fixtures/touch.json', import.meta.url), 'utf8'));

it('touching rectangles: same answer as cv2 (both orders)', () => {
  expect(rows.length).toBeGreaterThan(300);
  const wrong = rows.filter((r) => rotatedRectsIntersect(r.r1, r.r2) !== r.intersect || rotatedRectsIntersect(r.r2, r.r1) !== r.intersect);
  expect(wrong.map((r) => JSON.stringify(r))).toEqual([]);
});
