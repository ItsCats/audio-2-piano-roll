/**
 * Review fixes for the hands video: the sync worker's fallback keeps its input, the nudge slider keeps
 * its center, streamed decodes keep gaps where the file's timestamps put them, damaged stored data is
 * repaired or dropped, the logo stays clear of the picture-in-picture video, and the pre-drawn
 * watermark covers everything it draws.
 */
import { describe, expect, it } from 'vitest';
import { findOffset, type SyncInput } from '../../../src/lib/handcam/sync';
import { NUDGE_RANGE, nudgeTo, runMath } from '../../../src/lib/handcam/syncRun';
import { placeByTimestamp } from '../../../src/lib/transcription/decode';
import { defaultCalibration, edgeLimit, sanitizeCalibration, sanitizeHandVideo, whitesBetween } from '../../../src/lib/handcam/calibration';
import { NATIVE_FALLBACK_OFFSET } from '../../../src/lib/handcam/media';
import { logoClearOf, watermarkLayout, type Measure } from '../../../src/lib/watermark/layout';
import { watermarkArea } from '../../../src/lib/watermark/draw';
import { DEFAULT_WATERMARK, type WatermarkSettings } from '../../../src/lib/watermark/types';
import type { HandVideo } from '../../../src/lib/handcam/types';

/** an irregular melody and its clicks in a recording that starts `offset` s before the song */
function synthetic(offset: number, sr = 8000, seconds = 30): SyncInput {
  let s = 5;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const notes: { start: number; vel: number }[] = [];
  for (let t = 0.7; t < seconds - 3; t += 0.25 + rnd() * 0.45) notes.push({ start: t, vel: 0.5 + rnd() * 0.4 });
  const video = new Float32Array(seconds * sr);
  for (const n of notes) {
    const at = Math.round((n.start + offset) * sr);
    for (let i = 0; i < 0.3 * sr && at + i < video.length; i++) if (at + i >= 0) video[at + i] += n.vel * Math.exp(-i / (0.05 * sr)) * Math.sin((2 * Math.PI * 440 * i) / sr);
  }
  return { video, sr, t0: 0, ref: { kind: 'notes', notes } };
}

describe('sync worker fallback', () => {
  it('a worker that fails to load: the math runs here on the intact input', async () => {
    const input = synthetic(1.25);
    const expected = findOffset(synthetic(1.25));
    let posted: unknown = null;
    const fake = {
      onmessage: null as ((e: MessageEvent) => void) | null,
      onerror: null as ((e: Event) => void) | null,
      postMessage(msg: unknown, transfer?: Transferable[]) {
        posted = msg;
        // a real worker would detach transferred buffers here
        for (const t of transfer ?? []) if (t instanceof ArrayBuffer) structuredClone(t, { transfer: [t] });
        setTimeout(() => this.onerror?.(new Event('error')), 0);
      },
      terminate() {},
    };
    const r = await runMath(input, undefined, () => fake as unknown as Worker);
    expect(posted).not.toBeNull();
    expect(input.video.length).toBeGreaterThan(0);
    expect(r.offset).toBeCloseTo(expected.offset, 6);
    expect(Math.abs(r.offset - 1.25)).toBeLessThan(0.02);
  });
  it('no worker at all: the math runs here', async () => {
    const r = await runMath(synthetic(-0.6), undefined, () => {
      throw new Error('no workers');
    });
    expect(Math.abs(r.offset + 0.6)).toBeLessThan(0.02);
  });
});

const hv = (patch: Partial<HandVideo> = {}): HandVideo => ({
  v: 1,
  store: 'handcam',
  fileName: 'hands.mp4',
  mimeType: 'video/mp4',
  size: 1000,
  duration: 30,
  displayW: 1920,
  displayH: 1080,
  rotation: 0,
  offset: 2,
  addedAt: 1,
  ...patch,
});

describe('nudge', () => {
  it('with no sync yet the slider stays centered on the offset before the first nudge', () => {
    const a = nudgeTo(hv({ offset: 2 }), 2.3);
    expect(a.offset).toBe(2.3);
    expect(a.sync?.found).toBe(2);
    expect(a.sync?.method).toBe('manual');
    const b = nudgeTo(a, 2.5);
    expect(b.sync?.found).toBe(2);
    expect(b.offset).toBe(2.5);
  });
  it('keeps a found sync and stays within the slider range, in whole ms', () => {
    const found = hv({ offset: 1, sync: { method: 'notes', found: 1, confidence: 3, level: 'high' } });
    expect(nudgeTo(found, 1.0123).offset).toBe(1.012);
    expect(nudgeTo(found, 1.0123).sync?.method).toBe('notes');
    expect(nudgeTo(found, 99).offset).toBe(1 + NUDGE_RANGE);
    expect(nudgeTo(found, -99).offset).toBe(1 - NUDGE_RANGE);
  });
});

describe('streamed decode placement', () => {
  it('blocks that follow on are joined, a gap stays a gap', () => {
    const rate = 48000;
    const len = 1024;
    // timestamps rounded to 1 µs (as files store them), then a 0.5 s gap after block 3
    const ts = [0, 1, 2, 3, 4, 5].map((i) => Math.round(((i * len) / rate + (i >= 4 ? 0.5 : 0)) * 1e6) / 1e6);
    const at = placeByTimestamp(ts, ts.map(() => len), rate);
    expect(at.slice(0, 4)).toEqual([0, 1024, 2048, 3072]);
    expect(at[4]).toBe(4096 + 24000);
    expect(at[5]).toBe(5120 + 24000);
  });
  it('starts from the first block', () => {
    expect(placeByTimestamp([0.0213, 0.0213 + 1024 / 44100], [1024, 1024], 44100)).toEqual([0, 1024]);
    expect(placeByTimestamp([], [], 48000)).toEqual([]);
  });
  it('an unmeasured native import is taken as in step', () => {
    expect(NATIVE_FALLBACK_OFFSET).toBe(0);
  });
});

describe('stored hands video', () => {
  it('damaged entries are dropped', () => {
    expect(sanitizeHandVideo(null)).toBeUndefined();
    expect(sanitizeHandVideo({ store: 'elsewhere', displayW: 10, displayH: 10 })).toBeUndefined();
    expect(sanitizeHandVideo({ store: 'handcam', displayW: 0, displayH: 10 })).toBeUndefined();
  });
  it('a good entry is kept as is', () => {
    const cal = defaultCalibration({ frameTime: 3 });
    const good = hv({ calibration: cal, sync: { method: 'original', found: 2, confidence: 4.1, level: 'high' }, fps: 30, codec: 'avc' });
    expect(sanitizeHandVideo(good)).toEqual(good);
  });
  it('a damaged sync or calibration is dropped or repaired, the video kept', () => {
    const r = sanitizeHandVideo({ ...hv(), offset: Number.NaN, sync: { method: 'guess' }, calibration: 'x' });
    expect(r).toBeDefined();
    expect(r!.offset).toBe(0);
    expect(r!.sync).toBeUndefined();
    expect(r!.calibration).toBeUndefined();
  });
  it('key width set to its extremes survives a reload', () => {
    const cal = defaultCalibration();
    const n = whitesBetween(cal.lo, cal.hi);
    // Match at +1.5 and Key width at its widest: edgeL = -m - st/2, edgeR = -m + st/2
    const m = -1.5;
    const st = 0.03 * n;
    const extreme = { ...cal, edgeL: -m - st / 2, edgeR: -m + st / 2 };
    const back = sanitizeCalibration(extreme)!;
    expect(back.edgeL).toBeCloseTo(extreme.edgeL, 9);
    expect(back.edgeR).toBeCloseTo(extreme.edgeR, 9);
    expect(edgeLimit(cal.lo, cal.hi)).toBeGreaterThanOrEqual(1.5 + 0.015 * n);
    expect(sanitizeCalibration({ ...cal, edgeL: 50 })!.edgeL).toBeCloseTo(edgeLimit(cal.lo, cal.hi), 9);
  });
});

const measure: Measure = (text, font) => [...text].length * 0.6 * Number(/ ([\d.]+)px /.exec(font)![1]);
const wm = (patch: Partial<WatermarkSettings> = {}): WatermarkSettings => ({ ...DEFAULT_WATERMARK, enabled: true, text: 'youtube.com/yourname', ...patch });

describe('watermark and picture-in-picture', () => {
  it('the logo moves to the other side of the small video’s corner', () => {
    const logo = { mediaId: 'x', position: 'br' as const, size: 0.07, opacity: 0.8 };
    expect(logoClearOf(wm({ logo }), 'br').logo?.position).toBe('bl');
    expect(logoClearOf(wm({ logo: { ...logo, position: 'tl' } }), 'tl').logo?.position).toBe('tr');
    expect(logoClearOf(wm({ logo }), 'tl').logo?.position).toBe('br');
    expect(logoClearOf(wm({ logo }), null).logo?.position).toBe('br');
    expect(logoClearOf(wm(), 'br')).toEqual(wm());
  });
  it('the pre-drawn area covers the text, the logo and their shadow', () => {
    for (const [W, H] of [
      [1920, 1080],
      [720, 1280],
    ]) {
      const L = watermarkLayout(wm({ logo: { mediaId: 'x', position: 'tr', size: 0.08, opacity: 1 } }), W, H, measure, { logoAspect: 2 });
      const a = watermarkArea(L, true, W, H)!;
      for (const b of [L.bbox!, L.logo!]) {
        expect(a.x).toBeLessThanOrEqual(b.x - 6 * L.scale);
        expect(a.x + a.w).toBeGreaterThanOrEqual(Math.min(W, b.x + b.w + 6 * L.scale));
        expect(a.y).toBeLessThanOrEqual(Math.max(0, b.y - 6 * L.scale));
        expect(a.y + a.h).toBeGreaterThanOrEqual(Math.min(H, b.y + b.h + 6 * L.scale));
      }
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.y).toBeGreaterThanOrEqual(0);
      expect(a.x + a.w).toBeLessThanOrEqual(W);
      expect(a.y + a.h).toBeLessThanOrEqual(H);
      expect(Number.isInteger(a.x) && Number.isInteger(a.w)).toBe(true);
    }
    expect(watermarkArea(watermarkLayout(wm({ text: '' }), 1920, 1080, measure), false, 1920, 1080)).toBeNull();
  });
});
