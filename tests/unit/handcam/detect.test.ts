/** Automatic keyboard finding on synthetic camera frames: corners, key count and the fine match. */
import { describe, expect, it } from 'vitest';
import { autoMatch, darkKeys, findKeyboard, guessRange, rectify, type Gray } from '../../../src/lib/handcam/detect';
import { KEY_PRESETS, cornerHomography } from '../../../src/lib/handcam/calibration';
import { computeLayout } from '../../../src/lib/render/layout';
import { apply3, invert3 } from '../../../src/lib/geom/homography';

/** a camera frame: keyboard lo..hi between the corners, dark floor around it, optional hands */
function frame(quad: [number, number][], lo: number, hi: number, W = 640, H = 360, hands = false): Gray {
  const inv = invert3(cornerHomography(quad));
  const L = computeLayout(1, lo, hi);
  const d = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const p = apply3(inv, (x + 0.5) / W, (y + 0.5) / H);
      let v = 40;
      if (p.x >= 0 && p.x < 1 && p.y >= 0 && p.y < 1) {
        v = 240;
        for (let m = L.lo; m <= L.hi; m++) {
          const k = L.keys[m]!;
          if (k.black && p.y < 0.63 && p.x >= k.x && p.x < k.x + k.w) v = 25;
          if (!k.black && Math.abs(p.x - k.x) < 0.0012) v = Math.min(v, 140);
        }
      } else if (p.x >= 0 && p.x < 1 && p.y > -0.15 && p.y < 0) v = 15;
      if (hands && p.y > 0.6 && p.y < 1.6 && (Math.abs(p.x - 0.33) < 0.04 || Math.abs(p.x - 0.6) < 0.04)) v = 170;
      d[y * W + x] = v;
    }
  return { w: W, h: H, d };
}

const QUAD: [number, number][] = [
  [0.1, 0.4],
  [0.92, 0.37],
  [0.97, 0.63],
  [0.05, 0.66],
];

describe('keyboard detection', () => {
  it('finds the corners of a tilted keyboard (within 3% of the frame)', () => {
    const c = findKeyboard(frame(QUAD, 21, 108, 640, 360, true));
    expect(c).not.toBeNull();
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(c![i][0] - QUAD[i][0])).toBeLessThan(0.03);
      expect(Math.abs(c![i][1] - QUAD[i][1])).toBeLessThan(0.03);
    }
  });
  it('finds nothing in a frame without a keyboard', () => {
    const d = new Uint8Array(320 * 180).map((_, i) => 60 + ((i * 7) % 13));
    expect(findKeyboard({ w: 320, h: 180, d })).toBeNull();
  });
  for (const p of KEY_PRESETS) {
    it(`counts the black keys of ${p.label}`, () => {
      const strip = rectify(frame(QUAD, p.lo, p.hi, 1280, 720), QUAD, 1600, 120);
      expect(guessRange(strip, KEY_PRESETS)?.id).toBe(p.id);
    });
  }
  it('auto-match recovers corners that are half a key off', () => {
    // the user's corners sit 0.4 white keys inside on the left and 0.3 outside on the right
    const real = frame(QUAD, 21, 108, 1280, 720);
    const n = 52;
    const lerp = (a: [number, number], b: [number, number], t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const off: [number, number][] = [lerp(QUAD[0], QUAD[1], 0.4 / n), lerp(QUAD[0], QUAD[1], 1 + 0.3 / n), lerp(QUAD[3], QUAD[2], 1 + 0.3 / n), lerp(QUAD[3], QUAD[2], 0.4 / n)];
    const strip = rectify(real, off, 2000, 100);
    expect(darkKeys(strip).length).toBe(36);
    const m = autoMatch(strip, { lo: 21, hi: 108 })!;
    // the corners' left edge is 0.4 keys into the keyboard (edgeL +0.4), the right one 0.3 keys past it (edgeR +0.3)
    expect(Math.abs(m.edgeL - 0.4)).toBeLessThan(0.06);
    expect(Math.abs(m.edgeR - 0.3)).toBeLessThan(0.06);
  });
});
