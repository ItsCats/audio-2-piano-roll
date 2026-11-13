// cv2.fillPoly (homr autocrop: the sheet's convex hull) and cv2.fillConvexPoly (homr dewarping: triangles)
// ported in src/lib/omr/homr/cv.ts, pixel for pixel against OpenCV 4.14 (fixtures: tests/homr/make_fixtures.py).
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fillConvexPoly, fillPoly, img } from '../../../src/lib/omr/homr/cv';
import { unpack } from './fixtures';

const rows: { op: 'fillPoly' | 'fillConvexPoly'; w: number; h: number; pts: [number, number][]; d: string }[] = JSON.parse(
  readFileSync(new URL('./fixtures/fill.json', import.meta.url), 'utf8'),
);

it('fillPoly and fillConvexPoly: identical masks', () => {
  expect(rows.length).toBe(160);
  const wrong: string[] = [];
  for (const [i, r] of rows.entries()) {
    const m = r.op === 'fillPoly' ? img(r.w, r.h, 1, 1) : img(r.w, r.h);
    if (r.op === 'fillPoly') fillPoly(m, r.pts, 0);
    else fillConvexPoly(m, r.pts, 255);
    const want = unpack(r.d);
    let n = 0;
    for (let k = 0; k < want.length; k++) if (want[k] !== m.d[k]) n++;
    if (n) wrong.push(`${i} ${r.op} ${r.w}x${r.h} ${JSON.stringify(r.pts)}: ${n} px`);
  }
  expect(wrong).toEqual([]);
});
