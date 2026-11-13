/**
 * Hands video auto-sync on synthetic recordings with known offsets: against an "original recording"
 * (other sample rate, other noise) and against the song's notes; a strictly periodic song must give a
 * low match, and a different performance (tempo drift) must be flagged.
 */
import { describe, expect, it } from 'vitest';
import { ENV_RATE, Resampler, findOffset, notesEnvelope, onsetEnvelope, prepEnvelope, resample, xcorr } from '../../../src/lib/handcam/sync';

interface N {
  start: number;
  midi: number;
  vel: number;
}

/** an irregular melody over `seconds` */
function song(seconds: number, seed = 1): N[] {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const out: N[] = [];
  for (let t = 0.6; t < seconds - 1; t += 0.22 + rnd() * 0.5) out.push({ start: t, midi: 48 + Math.floor(rnd() * 30), vel: 0.4 + rnd() * 0.5 });
  return out;
}

/** decaying piano-ish tones at the note starts (+ offset), with noise */
function render(notes: N[], sr: number, seconds: number, offset: number, noise: number, seed = 7, stretch = 1): Float32Array {
  const n = Math.round(seconds * sr);
  const d = new Float32Array(n);
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5);
  for (let i = 0; i < n; i++) d[i] = noise * rnd();
  for (const note of notes) {
    const f = 440 * 2 ** ((note.midi - 69) / 12);
    const s0 = Math.round((note.start * stretch + offset) * sr);
    const len = Math.round(0.5 * sr);
    for (let i = 0; i < len; i++) {
      const k = s0 + i;
      if (k < 0 || k >= n) continue;
      const t = i / sr;
      const a = 0.35 * note.vel * Math.exp(-t / 0.18) * Math.min(1, t / 0.002);
      d[k] += a * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t) + 0.25 * Math.sin(6 * Math.PI * f * t));
    }
  }
  return d;
}

describe('resampler', () => {
  it('keeps a tone and its timing', () => {
    const sr = 48000;
    const x = new Float32Array(sr);
    x[24000] = 1; // impulse at 0.5 s
    const y = resample(x, sr, 8000);
    expect(Math.abs(y.length - 8000)).toBeLessThanOrEqual(2);
    let bi = 0;
    for (let i = 0; i < y.length; i++) if (y[i] > y[bi]) bi = i;
    expect(bi).toBe(4000);
    // streaming gives the same as one block
    const r = new Resampler(sr, 8000);
    const parts = [r.push(x.subarray(0, 10007)), r.push(x.subarray(10007, 30011)), r.push(x.subarray(30011)), r.flush()];
    const z = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) {
      z.set(p, o);
      o += p.length;
    }
    expect(z.length).toBe(y.length);
    for (let i = 0; i < y.length; i++) expect(Math.abs(z[i] - y[i])).toBeLessThan(1e-6);
  });
});

describe('envelopes and correlation', () => {
  it('finds a known lag between two impulse trains', () => {
    const notes = song(30);
    const ref = prepEnvelope(notesEnvelope(notes, 3000), 3);
    const vid = prepEnvelope(notesEnvelope(notes.map((n) => ({ ...n, start: n.start + 1.37 })), 3500), 3);
    const r = xcorr(ref, vid);
    expect(Math.abs(r.lag / ENV_RATE - 1.37)).toBeLessThan(0.006);
    expect(r.ratio).toBeGreaterThan(1.8);
  });
  it('the envelope does not start with a spike', () => {
    const e = onsetEnvelope(render(song(5), 8000, 5, 0, 0.05), 8000);
    expect(e[0]).toBe(0);
  });
});

describe('findOffset', () => {
  const notes = song(40);
  for (const [offset, vidSr, refSr] of [
    [-3.21, 48000, 44100],
    [0, 44100, 48000],
    [4.567, 48000, 22050],
    [2.345, 22050, 44100],
  ] as const) {
    it(`against the original: ${offset} s (video ${vidSr} Hz, original ${refSr} Hz) within 5 ms`, () => {
      const vidLen = 48;
      // the video starts `offset` before/after the song; t0 = video time of its first sample
      const t0 = 0;
      const video = render(notes, vidSr, vidLen, offset + 4, 0.03, 11); // video time = song time + offset + 4 (the camera started 4 s early)
      const original = render(notes, refSr, 42, 0, 0.01, 5);
      const r = findOffset({ video, sr: vidSr, t0, ref: { kind: 'audio', samples: original, sr: refSr } });
      expect(Math.abs(r.offset - (offset + 4))).toBeLessThan(0.005);
      expect(r.level).toBe('high');
      expect(r.method).toBe('original');
      expect(r.drift).toBe(false);
    });
  }
  it('against the notes, within 20 ms; t0 is added', () => {
    for (const [offset, sr] of [
      [2.345, 48000],
      [-1.5, 44100],
    ] as const) {
      const video = render(notes, sr, 46, offset + 2, 0.03, 13);
      const r = findOffset({ video, sr, t0: -0.0065, ref: { kind: 'notes', notes } });
      expect(Math.abs(r.offset - (offset + 2 - 0.0065))).toBeLessThan(0.02);
      expect(r.level).not.toBe('low');
      expect(r.method).toBe('notes');
    }
  });
  it('a strictly periodic song gives a low match', () => {
    const beat: N[] = [];
    for (let t = 1; t < 30; t += 0.5) beat.push({ start: t, midi: 60, vel: 0.8 });
    const video = render(beat, 16000, 34, 3.1, 0.02, 3);
    const r = findOffset({ video, sr: 16000, t0: 0, ref: { kind: 'notes', notes: beat } });
    expect(r.level).toBe('low');
  });
  it('a different performance (2% slower) is flagged as drifting', () => {
    const video = render(notes, 16000, 50, 1, 0.02, 3, 1.02);
    const r = findOffset({ video, sr: 16000, t0: 0, ref: { kind: 'notes', notes } });
    expect(r.drift).toBe(true);
  });
});
