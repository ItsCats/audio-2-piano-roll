/** Watermark layout: spaced capitals, every position, scaling with the frame, margins, logo and band. */
import { describe, expect, it } from 'vitest';
import { DIM_ALPHA, TRACKING_EM, watermarkBand, watermarkLayout, type Measure } from '../../../src/lib/watermark/layout';
import { DEFAULT_WATERMARK, sanitizeWatermark, watermarkActive, type WatermarkSettings } from '../../../src/lib/watermark/types';

/** every character is 0.6 em wide */
const measure: Measure = (text, font) => {
  const px = Number(/ ([\d.]+)px /.exec(font)![1]);
  return [...text].length * 0.6 * px;
};
const wm = (patch: Partial<WatermarkSettings> = {}): WatermarkSettings => ({ ...DEFAULT_WATERMARK, enabled: true, text: 'youtube.com/yourname', ...patch });
const inside = (b: { x: number; y: number; w: number; h: number }, W: number, H: number, m: number) => b.x >= m - 1e-6 && b.y >= m * 0.5 && b.x + b.w <= W - m + 1e-6 && b.y + b.h <= H;

describe('watermark layout', () => {
  it('spaced capitals: uppercase, even tracking, the name brighter', () => {
    const L = watermarkLayout(wm(), 1920, 1080, measure);
    expect(L.px).toBeCloseTo(26, 6);
    expect(L.glyphs.map((g) => g.ch).join('')).toBe('YOUTUBE.COM/YOURNAME');
    const step = 0.6 * 26 + TRACKING_EM * 26;
    for (let i = 1; i < L.glyphs.length; i++) expect(L.glyphs[i].x - L.glyphs[i - 1].x).toBeCloseTo(step, 6);
    expect(L.glyphs[11].ch).toBe('/');
    expect(L.glyphs[11].alpha).toBe(DIM_ALPHA);
    expect(L.glyphs[12].alpha).toBe(1);
    // centered
    const total = 20 * 0.6 * 26 + 19 * TRACKING_EM * 26;
    expect(L.bbox!.w).toBeCloseTo(total, 6);
    expect(L.bbox!.x + L.bbox!.w / 2).toBeCloseTo(960, 6);
    expect(L.runs).toEqual([]);
  });
  it('plain text keeps its case and draws as runs', () => {
    const L = watermarkLayout(wm({ spaced: false, highlightName: false, text: 'My Channel' }), 1920, 1080, measure);
    expect(L.glyphs).toEqual([]);
    expect(L.runs).toEqual([{ text: 'My Channel', x: (1920 - 10 * 0.6 * 26) / 2, alpha: 1 }]);
  });
  it('scales with the frame and stays inside the safe margins in every position', () => {
    for (const [W, H] of [
      [1280, 720],
      [1920, 1080],
      [1080, 1920],
      [1080, 1080],
    ]) {
      const m = 0.04 * Math.min(W, H);
      for (const position of ['bc', 'bl', 'br', 'tl', 'tr'] as const) {
        const L = watermarkLayout(wm({ position }), W, H, measure);
        expect(L.px).toBeCloseTo(26 * (Math.min(W, H) / 1080), 6);
        expect(inside(L.bbox!, W, H, m)).toBe(true);
        if (position[0] === 'b') expect(L.baseline).toBeCloseTo(H - m, 6);
        if (position === 'bl' || position === 'tl') expect(L.bbox!.x).toBeCloseTo(m, 6);
        if (position === 'br' || position === 'tr') expect(L.bbox!.x + L.bbox!.w).toBeCloseTo(W - m, 6);
      }
    }
  });
  it('sits in the reserved band (hands video) or above the Studio keyboard', () => {
    const band = watermarkBand(wm(), 1920, 1080);
    expect(band).toBe(Math.round(2.6 * 26));
    const L = watermarkLayout(wm(), 1920, 1080, measure, { band });
    expect(L.bbox!.y).toBeGreaterThan(1080 - band);
    expect(L.bbox!.y + L.bbox!.h).toBeLessThan(1080);
    const K = watermarkLayout(wm(), 1920, 1080, measure, { avoidBottom: 160 });
    expect(K.bbox!.y + K.bbox!.h).toBeLessThan(1080 - 160);
    // a top watermark needs no band
    expect(watermarkBand(wm({ position: 'tr' }), 1920, 1080)).toBe(0);
    expect(watermarkBand({ ...wm(), enabled: false }, 1920, 1080)).toBe(0);
  });
  it('a logo in the same corner goes next to the text without overlapping', () => {
    const w = wm({ position: 'br', logo: { mediaId: 'x', position: 'br', size: 0.07, opacity: 0.8 } });
    const L = watermarkLayout(w, 1920, 1080, measure, { logoAspect: 2 });
    const lg = L.logo!;
    expect(lg.h).toBeCloseTo(0.07 * 1080, 6);
    expect(lg.w).toBeCloseTo(2 * lg.h, 6);
    expect(lg.x + lg.w).toBeLessThanOrEqual(L.bbox!.x);
    expect(L.bbox!.x + L.bbox!.w).toBeCloseTo(1920 - 0.04 * 1080, 6);
    // a logo in another corner
    const T = watermarkLayout(wm({ logo: { mediaId: 'x', position: 'tl', size: 0.1, opacity: 1 } }), 1920, 1080, measure);
    expect(T.logo).toEqual({ x: 0.04 * 1080, y: 0.04 * 1080, w: 108, h: 108 });
    // a bottom logo makes the band tall enough
    expect(watermarkBand(wm({ text: '', logo: { mediaId: 'x', position: 'bl', size: 0.1, opacity: 1 } }), 1920, 1080)).toBeGreaterThan(108);
  });
  it('sanitizes stored settings', () => {
    const s = sanitizeWatermark({ enabled: true, text: 'x'.repeat(200), size: 99, color: 'red', position: 'mid', font: 'comic', logo: { mediaId: '' } });
    expect(s.text.length).toBe(80);
    expect(s.size).toBe(3);
    expect(s.color).toBe(DEFAULT_WATERMARK.color);
    expect(s.position).toBe('bc');
    expect(s.font).toBe(DEFAULT_WATERMARK.font);
    expect(s.logo).toBeNull();
    expect(watermarkActive(sanitizeWatermark(null))).toBe(false);
    expect(watermarkActive({ ...DEFAULT_WATERMARK, enabled: true, text: '  ' })).toBe(false);
  });
});
