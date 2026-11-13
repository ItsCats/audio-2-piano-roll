// The port of OpenCV's Subdiv2D (src/lib/omr/homr/subdiv2d.ts) against cv2.Subdiv2D: the same triangles in
// the same order (homr's dewarping paints them in that order). Fixtures: tests/homr/make_fixtures.py.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Subdiv2D } from '../../../src/lib/omr/homr/subdiv2d';
import { delaunay } from '../../../src/lib/omr/homr/staffImage';
import type { Pt } from '../../../src/lib/omr/homr/geom';

interface Case {
  points: Pt[];
  rect: [number, number, number, number];
  triangles: number[][];
}
const cases: Case[] = JSON.parse(readFileSync(new URL('./fixtures/subdiv.json', import.meta.url), 'utf8'));

describe('Subdiv2D (cv2 parity)', () => {
  it('has fixtures', () => expect(cases.length).toBeGreaterThan(20));
  cases.forEach((c, i) => {
    it(`point set ${i} (${c.points.length} points): triangle list equal and in the same order`, () => {
      const sub = new Subdiv2D(c.rect);
      for (const [x, y] of c.points) sub.insert(x, y);
      const got = sub.getTriangleList().map((t) => t.flat());
      expect(got).toEqual(c.triangles);
    });
  });
  it('homr mesh triangles as point indices, in cv2 order', () => {
    for (const c of cases.slice(0, 12)) {
      const tris = delaunay(c.points);
      const want = c.triangles.map((t) => [0, 2, 4].map((k) => c.points.findIndex((p) => p[0] === t[k] && p[1] === t[k + 1])));
      expect(tris).toEqual(want);
    }
  });
});
