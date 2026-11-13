/**
 * Hands video geometry: homographies, frame rotations, the lanes over the camera's keys (88/76/61
 * keys and the fine match), and where the straightened keyboard goes in the exported frame.
 */
import { describe, expect, it } from 'vitest';
import { UNIT_SQUARE, applyPt, apply3, chain, displayToCoded, homography, invert3, mul3, orientedToDisplay, IDENTITY } from '../../../src/lib/geom/homography';
import { homography as omrHomography } from '../../../src/lib/omr/image';
import {
  KEY_PRESETS,
  calibratedLayout,
  cornersValid,
  coverMatrix,
  defaultCalibration,
  frameMatrix,
  keyboardAspect,
  notesOutside,
  outputGeometry,
  pipRect,
  sanitizeCalibration,
  uvToOutput,
  viewWindow,
  whiteIndex,
  whitesBetween,
} from '../../../src/lib/handcam/calibration';
import { computeLayout } from '../../../src/lib/render/layout';
import { isBlack } from '../../../src/lib/music/theory';

const close = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('homography', () => {
  const quad: [number, number][] = [
    [70, 140],
    [585, 128],
    [622, 222],
    [28, 240],
  ];
  it('maps the four corners exactly and round-trips through its inverse', () => {
    const H = homography(UNIT_SQUARE, quad);
    UNIT_SQUARE.forEach((p, i) => {
      const q = applyPt(H, p);
      close(q[0], quad[i][0], 1e-6);
      close(q[1], quad[i][1], 1e-6);
    });
    const Hi = invert3(H);
    for (const p of [[0.3, 0.7], [0.5, 0.5], [0.91, 0.12]] as [number, number][]) {
      const back = applyPt(Hi, applyPt(H, p));
      close(back[0], p[0], 1e-9);
      close(back[1], p[1], 1e-9);
    }
    const I = mul3(H, Hi);
    I.forEach((v, i) => close(v / I[8], IDENTITY[i], 1e-9));
  });
  it('is the same function the sheet-music reader uses', () => {
    expect(omrHomography(UNIT_SQUARE, quad)).toEqual(homography(UNIT_SQUARE, quad));
  });
  it('display → coded for every rotation (corner checks, normalized)', () => {
    // display corner → coded corner: a frame turned clockwise by r for display
    const cases: Record<number, [number, number][]> = {
      0: [[0, 0], [1, 0], [1, 1], [0, 1]],
      // 90°: the display's top-left is the coded bottom-left
      90: [[0, 1], [0, 0], [1, 0], [1, 1]],
      180: [[1, 1], [0, 1], [0, 0], [1, 0]],
      270: [[1, 0], [1, 1], [0, 1], [0, 0]],
    };
    for (const [r, exp] of Object.entries(cases)) {
      const M = displayToCoded(Number(r));
      UNIT_SQUARE.forEach((p, i) => {
        const q = applyPt(M, p);
        close(q[0], exp[i][0]);
        close(q[1], exp[i][1]);
      });
    }
  });
  it('90° matches the pixel rule cx = dy, cy = ch − dx', () => {
    const cw = 360, ch = 640; // coded portrait, display 640×360
    const dx = 123, dy = 45;
    const q = apply3(displayToCoded(90), dx / ch, dy / cw);
    close(q.x * cw, dy, 1e-9);
    close(q.y * ch, ch - dx, 1e-9);
  });
  it('turn and mirror', () => {
    close(applyPt(orientedToDisplay(180, false), [0.2, 0.3])[0], 0.8);
    close(applyPt(orientedToDisplay(180, false), [0.2, 0.3])[1], 0.7);
    close(applyPt(orientedToDisplay(0, true), [0.2, 0.3])[0], 0.8);
    close(applyPt(orientedToDisplay(0, true), [0.2, 0.3])[1], 0.3);
    // both: a vertical flip
    const p = applyPt(orientedToDisplay(180, true), [0.2, 0.3]);
    close(p[0], 0.2);
    close(p[1], 0.7);
    // rotation composed with mirror: still maps the unit square onto itself
    const M = chain(displayToCoded(270), orientedToDisplay(0, true));
    for (const c of UNIT_SQUARE) {
      const q = applyPt(M, c);
      expect([0, 1]).toContain(Math.round(q[0]));
      expect([0, 1]).toContain(Math.round(q[1]));
    }
  });
});

describe('keys and lanes', () => {
  it('white key counts of the presets', () => {
    expect(KEY_PRESETS.map((p) => whitesBetween(p.lo, p.hi))).toEqual([52, 45, 36]);
    expect(KEY_PRESETS.map((p) => p.hi - p.lo + 1)).toEqual([88, 76, 61]);
    expect(whiteIndex(21, 21)).toBe(0);
    expect(whiteIndex(21, 22)).toBe(0); // A#0 → under A0
    expect(whiteIndex(21, 108)).toBe(51);
  });
  for (const p of KEY_PRESETS) {
    it(`calibrated layout for ${p.label} matches the Studio keyboard`, () => {
      const cal = defaultCalibration({ lo: p.lo, hi: p.hi });
      const g = outputGeometry(1920, 1080, cal);
      const L = calibratedLayout(cal, g);
      const ref = computeLayout(g.Kw, p.lo, p.hi);
      const n = whitesBetween(p.lo, p.hi);
      close(L.whiteW, g.Kw / n, 1e-9);
      close(L.keys[p.lo]!.x, g.x0, 1e-9);
      close(L.keys[p.hi]!.x + L.keys[p.hi]!.w, g.x0 + g.Kw, 1e-6);
      for (let m = p.lo; m <= p.hi; m++) {
        close(L.keys[m]!.x - g.x0, ref.keys[m]!.x, 1e-6);
        close(L.keys[m]!.w, ref.keys[m]!.w, 1e-9);
        expect(L.keys[m]!.black).toBe(isBlack(m));
      }
      expect(L.keys[p.lo - 1]).toBeNull();
      expect(L.keys[p.hi + 1] ?? null).toBeNull();
    });
  }
  it('the fine match moves and stretches the lanes', () => {
    const base = defaultCalibration();
    const g = outputGeometry(1920, 1080, base);
    const L0 = calibratedLayout(base, g);
    // edges half a key further out on both sides: the same span holds 53 white keys
    const wide = defaultCalibration({ edgeL: -0.5, edgeR: 0.5 });
    const L1 = calibratedLayout(wide, { ...g });
    close(L1.whiteW, g.s / 53, 1e-9);
    close(L1.keys[21]!.x, g.x0 + 0.5 * L1.whiteW, 1e-9);
    // shifting both edges by +0.25 key: every lane moves left by 0.25 white keys
    const shifted = calibratedLayout(defaultCalibration({ edgeL: 0.25, edgeR: 0.25 }), g);
    close(shifted.keys[60]!.x, L0.keys[60]!.x - 0.25 * L0.whiteW, 1e-9);
  });
  it('counts notes outside the keys', () => {
    expect(notesOutside({ lo: 36, hi: 96 }, [{ midi: 30 }, { midi: 60 }, { midi: 100 }])).toBe(2);
  });
});

describe('output geometry', () => {
  it('88 keys at 1080p: a key about 235 px long, the hit line near the middle (like the reference)', () => {
    const cal = defaultCalibration();
    const g = outputGeometry(1920, 1080, cal, { wmBand: 70 });
    close(keyboardAspect(cal), (52 * 23.5) / 150, 1e-9);
    expect(g.kh).toBeGreaterThan(230);
    expect(g.kh).toBeLessThan(240);
    expect(g.Kw).toBe(1920);
    close(g.yTop + g.bandH + g.wmBand, 1080, 1e-9);
    expect(g.yTop / 1080).toBeGreaterThan(0.4);
    expect(g.yTop / 1080).toBeLessThan(0.55);
  });
  it('keeps at least 40% for the notes (shrinks and centers the keyboard)', () => {
    const cal = defaultCalibration({ lo: 48, hi: 72, hands: 2.5 }); // two octaves: a tall band
    const g = outputGeometry(1920, 1080, cal, { wmBand: 50 });
    close(g.yTop, 0.4 * 1080, 1e-6);
    expect(g.Kw).toBeLessThan(1920);
    close(g.x0, (1920 - g.Kw) / 2, 1e-9);
    close(g.yTop + g.bandH + 50, 1080, 1e-6);
  });
  it('portrait and square have side margins; portrait keeps 45%', () => {
    const cal = defaultCalibration({ view: 'song' });
    const p = outputGeometry(1080, 1920, cal, { song: { lo: 55, hi: 79 } });
    expect(p.yTop / 1920).toBeGreaterThanOrEqual(0.45 - 1e-9);
    expect(p.Kw).toBeLessThanOrEqual(1080 * 0.96 + 1e-6);
    const sq = outputGeometry(1080, 1080, defaultCalibration());
    close(sq.Kw, 1080 * 0.96, 1e-6);
  });
  it('"just the keys in this song" shows the song’s range plus two white keys', () => {
    const cal = defaultCalibration({ view: 'song' });
    const [ua, ub] = viewWindow(cal, { lo: 60, hi: 72 });
    close(ua, (whiteIndex(21, 60) - 2) / 52);
    close(ub, (whiteIndex(21, 72) + 3) / 52);
    expect(viewWindow(defaultCalibration(), { lo: 60, hi: 72 })).toEqual([0, 1]);
    // the visible keys fill the frame width
    const g = outputGeometry(1920, 1080, cal, { song: { lo: 60, hi: 72 } });
    const L = calibratedLayout(cal, g);
    expect(L.keys[60]!.x).toBeGreaterThan(0);
    expect(L.keys[72]!.x + L.keys[72]!.w).toBeLessThan(1920);
    close(L.keys[60]!.x, g.x0 + 2 * L.whiteW, 1e-6); // C4 starts two white keys in
  });
  it('the frame matrix sends the hit line to the back edge of the camera keyboard', () => {
    const corners: [number, number][] = [[0.1, 0.4], [0.9, 0.38], [0.95, 0.6], [0.05, 0.62]];
    const cal = defaultCalibration({ corners });
    const g = outputGeometry(1280, 720, cal);
    for (const rot of [0, 90, 180, 270]) {
      const M = frameMatrix(cal, g, rot, g.yTop);
      // band canvas (0,0) = output (x0, yTop) = (u 0, v 0) = back-left corner
      const tex = applyPt(M, [g.x0, 0]);
      const disp = applyPt(invert3(displayToCoded(rot)), tex);
      close(disp[0], 0.1, 1e-9);
      close(disp[1], 0.4, 1e-9);
      // the front-right corner
      const fr = applyPt(invert3(displayToCoded(rot)), applyPt(M, [g.x0 + g.Kw, g.kh]));
      close(fr[0], 0.95, 1e-9);
      close(fr[1], 0.6, 1e-9);
    }
    const T = uvToOutput(g);
    close(applyPt(T, [0.5, 0])[1], g.yTop);
  });
  it('cover matrix crops the frame to fill the box', () => {
    const M = coverMatrix(100, 100, 640, 360, 0);
    close(applyPt(M, [0, 0])[0], (1 - 360 / 640) / 2, 1e-9);
    close(applyPt(M, [100, 100])[1], 1, 1e-9);
  });
  it('picture-in-picture rectangle', () => {
    const r = pipRect(1920, 1080, 'br', 0.3, 16 / 9, 60);
    expect(r.w).toBe(576);
    expect(r.x + r.w).toBe(1920 - 32);
    expect(r.y + r.h).toBe(1080 - 32 - 60);
    expect(pipRect(1920, 1080, 'tl', 0.3, 16 / 9).x).toBe(32);
  });
  it('validates corners and sanitizes stored calibrations', () => {
    expect(cornersValid(defaultCalibration().corners)).toBe(true);
    expect(cornersValid([[0, 0], [1, 0], [0, 1], [1, 1]])).toBe(false); // crossed
    const s = sanitizeCalibration({ lo: 22, hi: 106, hitV: 9, corners: 'x', view: 'nope' })!;
    expect(s.lo).toBe(21);
    expect(s.hi).toBe(107);
    expect(s.hitV).toBe(0.5);
    expect(s.view).toBe('all');
    expect(sanitizeCalibration(null)).toBeUndefined();
  });
});
