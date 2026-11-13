import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { findSystems, type PageDump } from '../../../src/lib/omr/homr/pipeline';
import { masksFromClasses } from '../../../src/lib/omr/homr/preprocess';
import { generateXml } from '../../../src/lib/omr/homr/musicxml';
import { EncodedSymbol } from '../../../src/lib/omr/homr/vocabulary';
import { serialize } from '../../../src/lib/omr/homr/xml';
import type { Staff } from '../../../src/lib/omr/homr/model';
import { importMusicXml } from '../../../src/lib/score';
import { unpack } from './fixtures';

/**
 * Python homr's intermediate results on two generated pages (a clean page and its synthetic photo;
 * tests/homr/make_page_fixture.py): from the same segmentation, the TypeScript port must find the same
 * symbol boxes, staffs, notes and systems, and write the same MusicXML from the same symbols.
 */
type Box = [[number, number], [number, number], number];
interface StaffFx {
  points: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  sample: [number, number[]][];
  grand: boolean;
  notes: [number, number, number][];
}

const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/page-${name}.json`, import.meta.url), 'utf8'));

/**
 * Same number of boxes, in the same order, and the same values. The float32 arithmetic of OpenCV's
 * minAreaRect is not reproduced bit for bit: on a few long, thin contours (staff-line fragments) it
 * settles on a slightly different rectangle (size within 0.1 px), so up to 2 % of the boxes may differ
 * by up to 0.2 px; all others match to 1e-3 px (angles to 1e-4 degrees).
 */
function expectBoxes(ts: { box: Box }[], py: Box[], label: string) {
  expect(ts.length, label).toBe(py.length);
  let off = 0;
  ts.forEach((b, i) => {
    const [[cx, cy], [w, h], a] = b.box;
    const [[pcx, pcy], [pw, ph], pa] = py[i];
    const d = Math.abs(cx - pcx) + Math.abs(cy - pcy) + Math.abs(w - pw) + Math.abs(h - ph);
    if (d > 1e-3 || Math.abs(a - pa) > 1e-4) {
      off++;
      expect(d, `${label} ${i}`).toBeLessThan(0.2);
      expect(Math.abs(a - pa), `${label} ${i} angle`).toBeLessThan(0.1);
    }
  });
  expect(off, `${label}: boxes that differ`).toBeLessThanOrEqual(Math.max(1, Math.ceil(0.02 * ts.length)));
}

/**
 * The staff's extent, its line positions and its notes. The staffs are sampled every 10 px from the
 * anchors (clefs, bar lines); where an anchor is decided differently (a box at a threshold, see above)
 * a sample point or two can move, so the grid may differ by 2 points and the lines by 0.5 px.
 */
function expectStaff(ts: Staff, py: StaffFx, label: string) {
  expect(Math.abs(ts.grid.length - py.points), label).toBeLessThanOrEqual(2);
  expect(ts.minX).toBeCloseTo(py.minX, 6);
  expect(ts.maxX).toBeCloseTo(py.maxX, 6);
  expect(Math.abs(ts.minY - py.minY)).toBeLessThan(0.5);
  expect(Math.abs(ts.maxY - py.maxY)).toBeLessThan(0.5);
  expect(ts.isGrandstaff).toBe(py.grand);
  for (const [x, ys] of py.sample) {
    const p = ts.grid.find((g) => Math.abs(g.x - x) < 1e-6);
    if (!p) continue;
    p.y.forEach((y, j) => expect(Math.abs(y - ys[j])).toBeLessThan(0.5));
  }
  const notes = ts.getNotes().map((n) => [n.center[0], n.center[1], n.position]);
  expect(notes.length, `${label} notes`).toBe(py.notes.length);
  notes.forEach((n, k) => {
    expect(n[0]).toBeCloseTo(py.notes[k][0], 3);
    expect(n[1]).toBeCloseTo(py.notes[k][1], 3);
    expect(n[2]).toBe(py.notes[k][2]);
  });
}

const parseSymbol = (s: string) => {
  const [r, p, l, a, sl, pos] = s.split(' ');
  return new EncodedSymbol(r, p, l, a, sl, pos);
};

const normalizeXml = (x: string) => x.replace(/^<\?xml[^>]*\?>\s*/i, '').trim();

describe.each(['clean-gen00', 'photo-gen00'])('homr port vs Python homr on %s', (name) => {
  const fx = load(name);

  it('finds the same boxes, staffs, notes and systems from the same segmentation', { timeout: 60_000 }, () => {
    const pred = masksFromClasses(unpack(fx.classes), fx.w, fx.h);
    const dump: PageDump = {};
    const found = findSystems(pred, dump);
    const boxes = dump.boxes as unknown as Record<string, { box: Box }[]>;
    for (const k of ['noteheads', 'staff_fragments', 'clefs_keys', 'stems_rest', 'bar_lines', 'staff_fragments_broken']) expectBoxes(boxes[k], fx.boxes[k], k);
    expect(Math.abs((dump.unit as number) - fx.unit)).toBeLessThan(1e-4);
    expect(found.staffs.length).toBe(fx.staffs.length);
    found.staffs.forEach((s, i) => expectStaff(s, fx.staffs[i], `staff ${i}`));
    expect(found.multi.map((m) => m.staffs.length)).toEqual(fx.systems.map((r: StaffFx[]) => r.length));
    found.multi.forEach((m, i) => m.staffs.forEach((s, j) => expectStaff(s, fx.systems[i][j], `system ${i} staff ${j}`)));
  });

  it('writes the same MusicXML from the same symbols, and the score import reads it', () => {
    const voices: EncodedSymbol[][] = fx.voices.map((v: string[]) => v.map(parseSymbol));
    const xml = serialize(generateXml(voices));
    expect(normalizeXml(xml)).toBe(normalizeXml(fx.xml));
    const song = importMusicXml(xml);
    expect(song.notes.length).toBeGreaterThan(40);
    expect(song.notes.map((n) => n.midi)).toEqual(importMusicXml(fx.xml).notes.map((n) => n.midi));
  });
});
