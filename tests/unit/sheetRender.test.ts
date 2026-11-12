/** Sheet view hit-testing (no DOM needed: the measure boxes are set directly). */
import { describe, expect, it } from 'vitest';
import { SheetRenderer, type MeasureBox } from '../../src/lib/sheet/render';

function renderer(boxes: MeasureBox[]): SheetRenderer {
  const r = new SheetRenderer({} as HTMLElement);
  (r as unknown as { boxes: MeasureBox[] }).boxes = boxes;
  return r;
}
const box = (measure: number, x: number, top: number, bottom: number, t0: number): MeasureBox => ({
  measure,
  t0,
  t1: t0 + 2,
  x,
  w: 300,
  top,
  bottom,
  entries: [
    { t: t0, x: x + 20 },
    { t: t0 + 1, x: x + 160 },
  ],
});

describe('sheet tap to seek', () => {
  // two lines of three measures; the first line's padded box reaches into the second line
  const lines = [box(0, 0, 258, 390, 0), box(1, 300, 258, 390, 2), box(2, 600, 258, 390, 4), box(3, 0, 410, 542, 6), box(4, 300, 410, 542, 8), box(5, 600, 410, 542, 10)];
  const r = renderer(lines);
  it('a tap on the top of a line seeks in that line, not the one above', () => {
    expect(r.timeAtPoint(320, 426)).toBe(8);
    expect(r.timeAtPoint(465, 415)).toBe(9);
  });
  it('a tap just outside a line goes to the nearest line', () => {
    expect(r.timeAtPoint(20, 395)).toBe(0); // 5 px below line 1, 15 px above line 2
    expect(r.timeAtPoint(20, 406)).toBe(6);
    expect(r.timeAtPoint(20, 700)).toBeNull();
  });
});
