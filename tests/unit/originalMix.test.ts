/**
 * Original-recording mixing for video export: where each recording sample lands in the output file
 * (lead-in, ranges, chunking), fades, volume, soft clipping and the sound/speed rules.
 */
import { describe, expect, it } from 'vitest';
import {
  defaultOriginalVolume,
  effectiveRate,
  effectiveSound,
  exportTimeline,
  fadeGain,
  mixOriginal,
  neededSpan,
  originalEnvelope,
  originalGain,
  shouldDownmix,
  softClipInPlace,
  songFrameAt,
  trimOriginal,
  type OriginalSource,
} from '../../src/lib/export/originalMix';
import { DEFAULT_EXPORT, type ExportSettings } from '../../src/lib/export/types';

const SR = 48000;
const base: ExportSettings = { ...DEFAULT_EXPORT, fadeIn: 0, fadeOut: 0, leadIn: 2 };

/** A fake decoded recording: `seconds` long, impulses (value 0.5) at the given song frames. */
function impulses(seconds: number, frames: number[], channels = 2) {
  const len = Math.round(seconds * SR);
  const data = Array.from({ length: channels }, () => new Float32Array(len));
  for (const f of frames) for (const d of data) d[f] = 0.5;
  return { numberOfChannels: channels, length: len, sampleRate: SR, duration: seconds, getChannelData: (c: number) => data[c] };
}

/** Mix the whole output in pieces of `chunk` frames (lead-in block first, like videoExport). */
function render(src: OriginalSource, s: ExportSettings, range: { start: number; end: number }, gain = 1, chunk = 45 * SR): Float32Array[] {
  const tl = exportTimeline(s, range, 1, SR);
  const total = tl.leadFrames + tl.bodyFrames;
  const out = [new Float32Array(total), new Float32Array(total)];
  const piece = (f0: number, n: number) => {
    const chans = [new Float32Array(n), new Float32Array(n)];
    mixOriginal(chans, f0, n, src, tl, gain);
    out[0].set(chans[0], f0);
    out[1].set(chans[1], f0);
  };
  piece(0, tl.leadFrames);
  for (let f = 0; f < tl.bodyFrames; f += chunk) piece(tl.leadFrames + f, Math.min(chunk, tl.bodyFrames - f));
  return out;
}

const nonZero = (d: Float32Array) => {
  const r: number[] = [];
  for (let i = 0; i < d.length; i++) if (d[i] !== 0) r.push(i);
  return r;
};

describe('export timeline', () => {
  it('matches the video export numbers', () => {
    const tl = exportTimeline({ leadIn: 2, fadeIn: 0.5, fadeOut: 2 }, { start: 1.25, end: 11.25 }, 1);
    expect(tl.lead).toBe(2);
    expect(tl.tail).toBe(2);
    expect(tl.duration).toBeCloseTo(14);
    expect(tl.leadFrames).toBe(96000);
    expect(tl.startFrame).toBe(60000);
    expect(tl.bodyFrames).toBe(12 * SR);
    // short fade-out still leaves 1.5 s for ringing notes; speed changes the music length
    const slow = exportTimeline({ leadIn: 0, fadeIn: 0, fadeOut: 0 }, { start: 0, end: 10 }, 0.5);
    expect(slow.tail).toBe(1.5);
    expect(slow.duration).toBeCloseTo(21.5);
  });

  it('maps output frames to song frames', () => {
    const tl = exportTimeline(base, { start: 4.3, end: 9 }, 1);
    expect(songFrameAt(tl.leadFrames, tl)).toBe(tl.startFrame);
    expect(songFrameAt(0, tl)).toBe(Math.round(2.3 * SR));
  });
});

describe('mixOriginal alignment', () => {
  it('full range: a sound at song time t lands at lead + (t - start)', () => {
    const notes = [0.85, 1.3, 2.004, 5.5, 9.99];
    const src = trimOriginal(impulses(12, notes.map((t) => Math.round(t * SR))), { start: 0, end: 12 });
    const range = { start: 0.6, end: 12 };
    const out = render(src, base, range);
    const L = Math.round(2 * SR);
    const S = Math.round(0.6 * SR);
    expect(nonZero(out[0])).toEqual(notes.map((t) => L + Math.round(t * SR) - S));
    expect(nonZero(out[1])).toEqual(nonZero(out[0]));
  });

  it('custom range mid-song: the lead-in plays the recording from before the start', () => {
    const notes = [1.0, 2.5, 3.9, 4.3, 6.0, 8.95, 9.7, 11.5];
    const src = trimOriginal(impulses(12, notes.map((t) => Math.round(t * SR))), { start: 0, end: 12 });
    const range = { start: 4.3, end: 9 };
    const out = render(src, base, range);
    const tl = exportTimeline(base, range, 1);
    // heard: song time in [start - lead, end + tail] = [2.3, 10.5], and before the end of the file
    const heard = notes.filter((t) => t >= 2.3 && t < 10.5);
    expect(heard).toEqual([2.5, 3.9, 4.3, 6.0, 8.95, 9.7]);
    expect(nonZero(out[0])).toEqual(heard.map((t) => tl.leadFrames + Math.round(t * SR) - tl.startFrame));
  });

  it('a lead-in longer than the start is silent before song time 0', () => {
    const src = trimOriginal(impulses(5, [0, 100, SR]), { start: 0, end: 5 });
    const s = { ...base, leadIn: 3 };
    const out = render(src, s, { start: 1, end: 4 });
    const L = 3 * SR;
    const S = SR;
    expect(nonZero(out[0])).toEqual([L - S, L - S + 100, L]);
    expect(out[0].subarray(0, L - S).every((v) => v === 0)).toBe(true);
  });

  it('loop range and a trimmed source give the same result as the full source', () => {
    const frames = [Math.round(3.2 * SR), Math.round(5 * SR), Math.round(7.77 * SR), Math.round(12 * SR)];
    const rec = impulses(14, frames);
    const range = { start: 5, end: 8 };
    const full = render(trimOriginal(rec, { start: 0, end: 14 }), base, range);
    const span = neededSpan(range, 2, 1.5);
    expect(span).toEqual({ start: 3, end: 9.5 });
    const trimmed = trimOriginal(rec, span);
    expect(trimmed.offsetFrame).toBe(3 * SR);
    const out = render(trimmed, base, range);
    expect(nonZero(out[0])).toEqual(nonZero(full[0]));
    expect(nonZero(out[0])).toEqual([Math.round(0.2 * SR), 2 * SR, 2 * SR + Math.round(2.77 * SR)]);
  });

  it('chunk size does not change the output', () => {
    const rec = impulses(10, Array.from({ length: 40 }, (_, i) => 7919 * i + 13));
    const src = trimOriginal(rec, { start: 0, end: 10 });
    const s = { ...base, fadeIn: 0.5, fadeOut: 1 };
    const range = { start: 1.1, end: 8 };
    const a = render(src, s, range, 0.7, 1000);
    const b = render(src, s, range, 0.7);
    const c = render(src, s, range, 0.7, 1e9);
    expect(a[0]).toEqual(b[0]);
    expect(c[1]).toEqual(b[1]);
  });

  it('a source that ends before the export is silent afterwards', () => {
    const src = trimOriginal(impulses(3, [SR, 3 * SR - 1]), { start: 0, end: 3 });
    const out = render(src, base, { start: 0, end: 6 });
    expect(nonZero(out[0])).toEqual([3 * SR, 5 * SR - 1]);
  });

  it('mono sources feed both channels; volume scales the original', () => {
    const rec = impulses(4, [SR], 1);
    const src = trimOriginal(rec, { start: 0, end: 4 });
    expect(src.channels.length).toBe(1);
    const out = render(src, base, { start: 0, end: 4 }, 0.5);
    expect(out[0][3 * SR]).toBeCloseTo(0.25);
    expect(out[1][3 * SR]).toBeCloseTo(0.25);
  });

  it('downmixes to mono when asked or for more than two channels', () => {
    const rec = impulses(2, [10], 2);
    rec.getChannelData(1)[10] = 0.1;
    const m = trimOriginal(rec, { start: 0, end: 2 }, { mono: true });
    expect(m.channels.length).toBe(1);
    expect(m.channels[0][10]).toBeCloseTo(0.3);
    expect(trimOriginal(impulses(2, [10], 6), { start: 0, end: 2 }).channels.length).toBe(1);
    expect(shouldDownmix(300, 2, true)).toBe(true);
    expect(shouldDownmix(200, 2, true)).toBe(false);
    expect(shouldDownmix(300, 2, false)).toBe(false);
    expect(shouldDownmix(60, 6, false)).toBe(true);
  });

  it('refuses rates other than 100%', () => {
    const tl = exportTimeline(base, { start: 0, end: 4 }, 0.75);
    expect(() => mixOriginal([new Float32Array(4)], 0, 4, { channels: [new Float32Array(4)], offsetFrame: 0 }, tl, 1)).toThrow();
  });
});

describe('fades', () => {
  it('fadeGain is 0 at the start and the end, linear in between', () => {
    expect(fadeGain(0, 10, 1, 2)).toBe(0);
    expect(fadeGain(0.5, 10, 1, 2)).toBeCloseTo(0.5);
    expect(fadeGain(5, 10, 1, 2)).toBe(1);
    expect(fadeGain(9, 10, 1, 2)).toBeCloseTo(0.5);
    expect(fadeGain(10, 10, 1, 2)).toBe(0);
    expect(fadeGain(0, 10, 0, 0)).toBe(1);
  });

  it('the original follows the picture fade, plus a short ramp at the end when there is no fade-out', () => {
    const tl = exportTimeline({ leadIn: 2, fadeIn: 1, fadeOut: 0 }, { start: 0, end: 10 }, 1);
    expect(originalEnvelope(0, tl)).toBe(0);
    expect(originalEnvelope(0.5, tl)).toBeCloseTo(0.5);
    expect(originalEnvelope(5, tl)).toBe(1);
    expect(originalEnvelope(tl.duration - 0.15, tl)).toBeCloseTo(0.5);
    expect(originalEnvelope(tl.duration, tl)).toBe(0);
    // with a real fade-out the end ramp changes nothing
    const tl2 = exportTimeline({ leadIn: 2, fadeIn: 0, fadeOut: 2 }, { start: 0, end: 10 }, 1);
    expect(originalEnvelope(tl2.duration - 0.1, tl2)).toBeCloseTo(fadeGain(tl2.duration - 0.1, tl2.duration, 0, 2));
  });

  it('fades shape the mixed samples', () => {
    const len = 8 * SR;
    const ones = new Float32Array(len).fill(1);
    const src: OriginalSource = { channels: [ones], offsetFrame: 0 };
    const s = { ...base, leadIn: 2, fadeIn: 1, fadeOut: 2 };
    const out = render(src, s, { start: 2, end: 6 }); // lead-in plays song 0..2
    const tl = exportTimeline(s, { start: 2, end: 6 }, 1);
    expect(out[0][0]).toBe(0);
    expect(out[0][SR / 2]).toBeCloseTo(0.5, 4);
    expect(out[0][3 * SR]).toBe(1);
    // song ends at 8 s = output 8 s; the fade-out runs to the end of the file (8 s): silent from there
    expect(tl.duration).toBeCloseTo(8);
    expect(out[0][7 * SR]).toBeCloseTo(0.5, 4);
    expect(out[0][out[0].length - 1]).toBeCloseTo(0, 4);
  });
});

describe('soft clip', () => {
  it('leaves quiet samples alone and keeps loud ones within ±1', () => {
    const d = Float32Array.from([0, 0.5, -0.84, 0.85, 0.9, -1.2, 2, -5]);
    softClipInPlace(d);
    expect(Array.from(d.subarray(0, 4))).toEqual(Array.from(Float32Array.from([0, 0.5, -0.84, 0.85])));
    expect(d[4]).toBeGreaterThan(0.85);
    expect(d[4]).toBeLessThan(0.9);
    for (const v of d) expect(Math.abs(v)).toBeLessThanOrEqual(1);
    expect(d[5]).toBeLessThan(-0.85);
  });
});

describe('sound and speed rules', () => {
  it('falls back to piano without a recording or WebCodecs', () => {
    expect(effectiveSound({ sound: 'both' }, { hasOriginal: false, webCodecs: true })).toBe('piano');
    expect(effectiveSound({ sound: 'original' }, { hasOriginal: true, webCodecs: false })).toBe('piano');
    expect(effectiveSound({ sound: 'original' }, { hasOriginal: true, webCodecs: true })).toBe('original');
    expect(effectiveSound({ sound: undefined as unknown as 'piano' }, { hasOriginal: true, webCodecs: true })).toBe('piano');
  });

  it('locks speed to 100% when the original is included', () => {
    expect(effectiveRate({ rate: 0.75 }, 'piano')).toBe(0.75);
    expect(effectiveRate({ rate: 0.75 }, 'original')).toBe(1);
    expect(effectiveRate({ rate: 1.25 }, 'both')).toBe(1);
  });

  it('original volume follows the Studio when it is turned up', () => {
    expect(defaultOriginalVolume(0)).toBe(0.8);
    expect(defaultOriginalVolume(0.04)).toBe(0.8);
    expect(defaultOriginalVolume(0.6)).toBe(0.6);
    expect(defaultOriginalVolume(undefined)).toBe(0.8);
    expect(originalGain({ originalVolume: undefined }, 0.6)).toBe(0.6);
    expect(originalGain({ originalVolume: 1.2 }, 0.6)).toBe(1.2);
  });
});
