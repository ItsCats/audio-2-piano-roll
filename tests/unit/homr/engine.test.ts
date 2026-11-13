import { describe, expect, it } from 'vitest';
import { assemble, estimateSecondsPerPage, homrDownloadBytes, homrModelSpec, homrReaderSupport, SheetReadError } from '../../../src/lib/omr/homr';
import { HOMR_MODELS } from '../../../src/lib/omr/homr/manifest';
import { pageImage, straighten } from '../../../src/lib/omr/homr/page';
import { img } from '../../../src/lib/omr/homr/cv';
import type { RunStats } from '../../../src/lib/omr/homr/protocol';

const stats: RunStats = { fromCache: true, reusedSession: false, loadMs: 0, createMs: 0, segmentMs: 0, encodeMs: 0, decodeMs: 0, steps: 0, threads: 1 };
const xml = '<score-partwise><part id="P1"><measure number="1"><note><pitch><step>C</step><octave>4</octave></pitch></note></measure></part></score-partwise>';

describe('homr reader: public API', () => {
  it('ships the three models in pieces under 10 MB, with their URLs versioned by sha256', () => {
    for (const m of Object.values(HOMR_MODELS)) {
      expect(m.parts.length).toBe(Math.ceil(m.bytes / 9_500_000));
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(homrDownloadBytes()).toBeLessThan(100e6);
    const spec = homrModelSpec('https://example.org/');
    expect(spec.segnet.parts?.[0]).toBe(`https://example.org/models/homr/segnet.fp16w.part1.bin?v=${HOMR_MODELS.segnet.sha256.slice(0, 8)}`);
    expect(spec.decoder.sha256).toBe(HOMR_MODELS.decoder.sha256);
  });

  it('says whether it can run, and how slowly on phones', () => {
    const desktop = homrReaderSupport({ ua: 'Mozilla/5.0 (X11; Linux x86_64)' }, 3, { worker: true, simd: true });
    expect(desktop).toMatchObject({ available: true, recommended: true, phone: false, downloadMB: 93 });
    const phone = homrReaderSupport({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', maxTouchPoints: 5, deviceMemory: 2, mobile: true }, 1, { worker: true, simd: true });
    expect(phone.available).toBe(true);
    expect(phone.recommended).toBe(false);
    expect(phone.reason).toMatch(/phone/);
    expect(homrReaderSupport(undefined, 1, { worker: true, simd: false }).available).toBe(false);
    expect(estimateSecondsPerPage(1, true)).toBeGreaterThan(estimateSecondsPerPage(3));
  });

  it('turns the worker result into warnings and user-facing errors', () => {
    const r = assemble({ musicXml: xml, pages: [{ staves: 4, systems: 2, ms: 1 }, { staves: 0, systems: 0, error: 'No staffs found', ms: 1 }], stats }, 2);
    expect(r.warnings).toEqual(['No music was found on page 2.']);
    expect(r).toMatchObject({ pages: 2, staves: 4, lines: 2 });
    expect(() => assemble({ musicXml: '', pages: [{ staves: 0, systems: 0, error: 'x', ms: 1 }], stats }, 1)).toThrow(SheetReadError);
    expect(() => assemble({ musicXml: '<score-partwise/>', pages: [{ staves: 2, systems: 1, ms: 1 }], stats }, 1)).toThrow(/No notes/);
  });

  it('takes gray, RGB or RGBA pages and straightens a photo to its corners', () => {
    const rgba = new Uint8Array(4 * 4 * 4).fill(200);
    rgba[3] = 0; // a transparent pixel is paper
    const p = pageImage({ w: 4, h: 4, channels: 4, data: rgba });
    expect(p.c).toBe(3);
    expect(Array.from(p.d.slice(0, 3))).toEqual([255, 255, 255]);
    // a rectangle drawn on a page comes out filling the straightened image
    const src = img(100, 80, 1, 255);
    for (let y = 20; y < 60; y++) for (let x = 10; x < 90; x++) src.d[y * 100 + x] = 0;
    const out = straighten(src, [[10, 20], [90, 20], [90, 60], [10, 60]]);
    expect([out.w, out.h]).toEqual([80, 40]);
    let dark = 0;
    for (const v of out.d) if (v < 128) dark++;
    expect(dark / out.d.length).toBeGreaterThan(0.9);
  });
});
