/**
 * Original-recording mixing for video export: where each recording sample lands in the output file
 * (lead-in, ranges, chunking), fades, volume, the limiter, memory use and the sound/speed rules.
 */
import { describe, expect, it } from 'vitest';
import {
  COPY_SPAN_UP_TO_SECONDS,
  LIMIT_CEILING,
  createLimiter,
  defaultOriginalVolume,
  effectiveRate,
  effectiveSound,
  exportTimeline,
  fadeGain,
  flushTinyInPlace,
  mixOriginal,
  neededSpan,
  originalEnvelope,
  originalGain,
  shouldDownmix,
  songFrameAt,
  trimOriginal,
  type OriginalSource,
} from '../../src/lib/export/originalMix';
import { DEFAULT_EXPORT, type ExportSettings } from '../../src/lib/export/types';
import { ownFadeGain, timelineFadeGain } from '../../src/lib/audio/fade';
import { exportRange } from '../../src/lib/export/videoExport';
import { STALL_MESSAGE, finalizeTimeoutMs, guardStep } from '../../src/lib/export/guard';
import type { Song } from '../../src/lib/music/types';

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

describe('limiter', () => {
  const peak = (d: Float32Array) => d.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

  it('leaves a mix below the ceiling untouched', () => {
    const d = Float32Array.from({ length: SR }, (_, i) => 0.85 * Math.sin(i * 0.05));
    const before = d.slice();
    createLimiter(SR).process([d, d.slice()]);
    expect(d).toEqual(before);
  });

  it('keeps every sample at or below about -1 dB, on both channels with the same gain', () => {
    const n = SR;
    const l = Float32Array.from({ length: n }, (_, i) => 1.4 * Math.sin(i * 0.05) * (i > SR / 2 ? 1 : 0.3));
    const r = l.map((v) => v * 0.5);
    const l0 = l.slice();
    const r0 = r.slice();
    createLimiter(SR).process([l, r]);
    expect(LIMIT_CEILING).toBeLessThanOrEqual(0.9);
    expect(peak(l)).toBeLessThanOrEqual(LIMIT_CEILING + 1e-6);
    // same gain on both channels: the stereo balance doesn't move
    for (let i = 0; i < n; i += 997) if (Math.abs(l0[i]) > 0.01) expect(l[i] / l0[i]).toBeCloseTo(r[i] / r0[i], 5);
    // quiet part before the loud one is untouched (outside the look-ahead window)
    expect(l[1000]).toBe(l0[1000]);
  });

  it('turns down smoothly ahead of a peak, with no delay, and recovers after it', () => {
    const n = SR;
    const d = new Float32Array(n).fill(0.5);
    d[SR / 2] = 1.5; // one spike
    const g = d.slice();
    createLimiter(SR).process([g]);
    expect(Math.abs(g[SR / 2])).toBeLessThanOrEqual(LIMIT_CEILING + 1e-6);
    // gain falls gradually over the 5 ms before the spike (no step)
    let maxStep = 0;
    for (let i = SR / 2 - 400; i < SR / 2 + 400; i++) maxStep = Math.max(maxStep, Math.abs(g[i + 1] / d[i + 1] - g[i] / d[i]));
    expect(maxStep).toBeLessThan(0.01);
    expect(g[SR / 2 - 300]).toBe(0.5);
    // and is back to (almost) full volume half a second later
    expect(g[n - 1]).toBeGreaterThan(0.49);
  });

  it('carries its gain from one block to the next', () => {
    const make = () => Float32Array.from({ length: 2 * SR }, (_, i) => (i < SR ? 1.3 : 0.6) * Math.sin(i * 0.02));
    const whole = make();
    createLimiter(SR).process([whole]);
    const split = make();
    const lim = createLimiter(SR);
    lim.process([split.subarray(0, SR)]);
    lim.process([split.subarray(SR)]);
    // the release after the loud first second continues in the second block
    for (let i = SR; i < SR + 2000; i += 50) expect(split[i]).toBeCloseTo(whole[i], 5);
    expect(peak(split)).toBeLessThanOrEqual(LIMIT_CEILING + 1e-6);
  });

  it('sets inaudibly small values to zero (the WASM AAC encoder can stall on them)', () => {
    const d = Float32Array.from([1e-38, -5e-26, 3e-9, -9e-7, 1.1e-6, -0.5, 0]);
    flushTinyInPlace(d);
    expect(Array.from(d)).toEqual(Array.from(Float32Array.from([0, 0, 0, 0, 1.1e-6, -0.5, 0])));
  });
});

describe('memory', () => {
  it('a long span is kept as views into the decoded buffer (no second copy)', () => {
    const rec = impulses(COPY_SPAN_UP_TO_SECONDS + 10, [5, 2 * SR]);
    const src = trimOriginal(rec, { start: 1, end: COPY_SPAN_UP_TO_SECONDS + 5 });
    expect(src.channels[0].buffer).toBe(rec.getChannelData(0).buffer);
    expect(src.channels[1].buffer).toBe(rec.getChannelData(1).buffer);
    expect(src.offsetFrame).toBe(SR);
    expect(src.channels[0][SR]).toBe(0.5); // song frame 2 s
  });

  it('a short span is copied so the full decode can be freed', () => {
    const rec = impulses(COPY_SPAN_UP_TO_SECONDS + 10, [2 * SR]);
    const src = trimOriginal(rec, { start: 1, end: 20 });
    expect(src.channels[0].buffer).not.toBe(rec.getChannelData(0).buffer);
    expect(src.channels[0].length).toBe(19 * SR + 1);
  });

  it('a long mono downmix is done in place in channel 0', () => {
    const rec = impulses(COPY_SPAN_UP_TO_SECONDS + 10, [3 * SR]);
    rec.getChannelData(1)[3 * SR] = 0.1;
    const src = trimOriginal(rec, { start: 0, end: COPY_SPAN_UP_TO_SECONDS + 10 }, { mono: true });
    expect(src.channels.length).toBe(1);
    expect(src.channels[0].buffer).toBe(rec.getChannelData(0).buffer);
    expect(src.channels[0][3 * SR]).toBeCloseTo(0.3);
  });

  it('views and copies mix to the same output', () => {
    const rec = impulses(COPY_SPAN_UP_TO_SECONDS + 10, [Math.round(20.3 * SR), Math.round(41 * SR)]);
    const range = { start: 20, end: 45 };
    const a = render(trimOriginal(rec, neededSpan(range, 2, 1.5), { copyUpToSeconds: 0 }), base, range);
    const b = render(trimOriginal(rec, neededSpan(range, 2, 1.5), { copyUpToSeconds: 1e9 }), base, range);
    expect(nonZero(a[0])).toEqual(nonZero(b[0]));
    expect(nonZero(a[0]).length).toBe(2);
  });
});

describe('piano fade on the video timeline', () => {
  it('with a lead-in the piano fades in with the picture, not after the lead-in', () => {
    const lead = 2;
    const tl = exportTimeline({ leadIn: lead, fadeIn: 0.5, fadeOut: 2 }, { start: 1, end: 11 }, 1);
    // piano output time p is file time lead + p
    const piano = (p: number) => timelineFadeGain(lead + p, tl.duration, tl.fadeIn, tl.fadeOut);
    // first piano note at range.start + 0.25 (file time 2.25 s) is at full volume, like the original
    expect(piano(0.25)).toBe(1);
    expect(piano(0.25)).toBe(originalEnvelope(lead + 0.25, tl));
    // the old curve measured from the start of the piano: half volume there
    expect(ownFadeGain(0.25, tl.duration - lead, 0.5, 2)).toBeCloseTo(0.5);
    // fade-out: piano, original and picture all reach 0 at the end of the file
    for (const o of [tl.duration - 1.5, tl.duration - 0.5]) expect(piano(o - lead)).toBeCloseTo(fadeGain(o, tl.duration, 0.5, 2));
    expect(piano(tl.duration - lead)).toBe(0);
  });
});

describe('export range', () => {
  const song = {
    duration: 100,
    arrangements: { hard: { notes: [{ start: 12, dur: 1 }, { start: 14, dur: 1 }] } },
  } as unknown as Song;
  const settings = { ...DEFAULT_EXPORT, range: 'full' } as ExportSettings;

  it('full song with piano only starts just before the first note', () => {
    expect(exportRange({ song, settings, loop: null })).toEqual({ start: 11.75, end: 100 });
  });

  it('full song with the original starts at 0, so a long intro is kept', () => {
    expect(exportRange({ song, settings, loop: null }, 'original')).toEqual({ start: 0, end: 100 });
    expect(exportRange({ song, settings, loop: null }, 'both')).toEqual({ start: 0, end: 100 });
  });

  it('custom and loop ranges are the same whatever the sound', () => {
    const custom = { ...settings, range: 'custom', customStart: 20, customEnd: 30 } as ExportSettings;
    expect(exportRange({ song, settings: custom, loop: null }, 'both')).toEqual({ start: 20, end: 30 });
    const loop = { ...settings, range: 'loop' } as ExportSettings;
    expect(exportRange({ song, settings: loop, loop: { start: 5, end: 9 } }, 'original')).toEqual({ start: 5, end: 9 });
  });
});

describe('stall guard', () => {
  it('passes results and errors through', async () => {
    await expect(guardStep(Promise.resolve(3), undefined, 1000)).resolves.toBe(3);
    await expect(guardStep(Promise.reject(new Error('x')), undefined, 1000)).rejects.toThrow('x');
  });

  it('gives up with a plain message when a step never finishes', async () => {
    const never = new Promise<void>(() => {});
    await expect(guardStep(never, undefined, 20)).rejects.toThrow(STALL_MESSAGE);
  });

  it('stops at once when the export is cancelled', async () => {
    const ac = new AbortController();
    const p = guardStep(new Promise<void>(() => {}), ac.signal, 60_000);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await expect(guardStep(Promise.resolve(1), ac.signal, 60_000)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('allows longer files more time to finish', () => {
    expect(finalizeTimeoutMs(10)).toBeGreaterThanOrEqual(60_000);
    expect(finalizeTimeoutMs(1200)).toBeGreaterThan(finalizeTimeoutMs(10));
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
