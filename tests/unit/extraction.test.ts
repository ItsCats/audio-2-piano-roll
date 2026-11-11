import { describe, expect, it } from 'vitest';
import { extractNotes, pitchThresholds, DEFAULT_EXTRACTION, type NoteExtractionOptions } from '../../src/lib/transcription/noteExtraction';
import { dequantize } from '../../src/lib/transcription/posteriors';

const P = 88;
const PIANO_LIKE: NoteExtractionOptions = { ...DEFAULT_EXTRACTION, onsetThreshold: 0.5, frameThreshold: 0.4, minNoteFrames: 6, inferOnsets: false, melodiaTrick: false };

function posteriors(n: number) {
  return { frames: new Float32Array(n * P), onsets: new Float32Array(n * P) };
}
function addNote(p: ReturnType<typeof posteriors>, midi: number, start: number, len: number, amp = 0.8, onset = 0.9) {
  const f = midi - 21;
  p.onsets[start * P + f] = onset;
  for (let t = start; t < start + len; t++) p.frames[t * P + f] = amp;
}
/** Deterministic pseudo-random smooth posteriors with decaying notes, for equivalence tests. */
function randomPosteriors(n: number, seed = 7) {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const p = posteriors(n);
  for (let k = 0; k < 160; k++) {
    const midi = 21 + Math.floor(rnd() * 88);
    const t0 = Math.floor(rnd() * (n - 60));
    const len = 5 + Math.floor(rnd() * 50);
    const amp = 0.2 + rnd() * 0.7;
    const f = midi - 21;
    // a broad onset peak: the next frame is often within 1/255 of the peak (a tie once quantised)
    const peak = 0.35 + rnd() * 0.6;
    const shape = [0.5, 1, 1 - rnd() * 0.002];
    for (let d = -1; d <= 1; d++) if (t0 + d >= 0) p.onsets[(t0 + d) * P + f] = Math.max(p.onsets[(t0 + d) * P + f], peak * shape[d + 1]);
    for (let t = t0; t < Math.min(n, t0 + len); t++) p.frames[t * P + f] = Math.max(p.frames[t * P + f], amp * Math.exp(-(t - t0) / (len * 0.8)));
  }
  return p;
}

describe('pitchThresholds', () => {
  it('is uniform (the scalar options) without a register curve', () => {
    const th = pitchThresholds(PIANO_LIKE);
    for (let f = 0; f < P; f++) {
      expect(th.onset[f]).toBe(0.5);
      expect(th.frame[f]).toBe(0.4);
      expect(th.minFrames[f]).toBe(6);
    }
  });

  it('ramps linearly from 1 inside the range to the given factors at the keyboard ends', () => {
    const th = pitchThresholds({ ...PIANO_LIKE, register: { lowMidi: 48, lowOnset: 0.6, lowFrame: 0.5, highMidi: 76, highFrame: 0.3, highMinFrames: 0.4 } });
    const at = (midi: number) => ({ o: th.onset[midi - 21], f: th.frame[midi - 21], m: th.minFrames[midi - 21] });
    expect(at(60)).toEqual({ o: 0.5, f: 0.4, m: 6 });
    expect(at(48)).toEqual({ o: 0.5, f: 0.4, m: 6 });
    expect(at(76)).toEqual({ o: 0.5, f: 0.4, m: 6 });
    expect(at(21).o).toBeCloseTo(0.3, 6);
    expect(at(21).f).toBeCloseTo(0.2, 6);
    expect(at(108).f).toBeCloseTo(0.12, 6);
    expect(at(108).m).toBe(2);
    expect(at(108).o).toBe(0.5); // no highOnset given
    // monotonic towards the ends
    for (let m = 22; m <= 48; m++) expect(at(m).f).toBeGreaterThanOrEqual(at(m - 1).f);
    for (let m = 77; m <= 108; m++) expect(at(m).f).toBeLessThanOrEqual(at(m - 1).f);
  });

  it('lets explicit per-pitch arrays override the scalar thresholds', () => {
    const onset = new Array(88).fill(0.7);
    const th = pitchThresholds({ ...PIANO_LIKE, onsetThresholdByPitch: onset });
    expect(th.onset[10]).toBe(0.7);
    expect(th.frame[10]).toBe(0.4);
  });
});

describe('extractNotes onset peaks', () => {
  it('detects a flat (two-frame) onset peak once, at its first frame', () => {
    const p = posteriors(100);
    addNote(p, 60, 20, 30);
    p.onsets[21 * P + 39] = 0.9; // equal neighbour, as after 8-bit quantisation
    const notes = extractNotes(p.frames, p.onsets, 100, PIANO_LIKE);
    expect(notes).toHaveLength(1);
    expect(notes[0].startFrame).toBe(20);
  });

  it('does not count a plateau that keeps rising as a peak', () => {
    const p = posteriors(100);
    addNote(p, 60, 20, 30);
    const f = 39;
    p.onsets[19 * P + f] = 0.6;
    p.onsets[20 * P + f] = 0.7;
    p.onsets[21 * P + f] = 0.7;
    p.onsets[22 * P + f] = 0.8;
    const notes = extractNotes(p.frames, p.onsets, 100, PIANO_LIKE);
    expect(notes).toHaveLength(1);
    expect(notes[0].startFrame).toBe(22);
  });

  it('re-detection on 8-bit quantised posteriors finds the same notes as on floats', () => {
    const n = 3000;
    const p = randomPosteriors(n);
    const q = (a: Float32Array) => dequantize(Uint8Array.from(a, (v) => Math.max(0, Math.min(255, Math.round(v * 255)))));
    const a = extractNotes(p.frames, p.onsets, n, PIANO_LIKE);
    const b = extractNotes(q(p.frames), q(p.onsets), n, PIANO_LIKE);
    expect(a.length).toBeGreaterThan(30);
    const key = (x: { midi: number; startFrame: number }) => `${x.midi}@${x.startFrame}`;
    const sa = new Set(a.map(key));
    const common = b.filter((x) => sa.has(key(x))).length;
    expect(common / a.length).toBeGreaterThan(0.97);
    expect(Math.abs(a.length - b.length)).toBeLessThanOrEqual(Math.ceil(a.length * 0.03));
  });
});

describe('extractNotes register curve', () => {
  it('changes nothing when every factor is 1', () => {
    const n = 2000;
    const p = randomPosteriors(n, 11);
    for (const base of [PIANO_LIKE, { ...DEFAULT_EXTRACTION }]) {
      const a = extractNotes(p.frames, p.onsets, n, base);
      const b = extractNotes(p.frames, p.onsets, n, { ...base, register: { lowMidi: 48, highMidi: 76, lowOnset: 1, lowFrame: 1, highFrame: 1, highMinFrames: 1 } });
      expect(b).toEqual(a);
    }
  });

  it('recovers a short, weak top-octave note without touching the middle register', () => {
    const p = posteriors(200);
    addNote(p, 100, 20, 5, 0.25); // C7: weak and short, as Basic Pitch outputs for the top octave
    addNote(p, 64, 60, 5, 0.25); // the same weak, short note in the middle register
    addNote(p, 60, 100, 40, 0.8);
    const plain = extractNotes(p.frames, p.onsets, 200, PIANO_LIKE);
    expect(plain.map((x) => x.midi)).toEqual([60]);
    const reg = extractNotes(p.frames, p.onsets, 200, { ...PIANO_LIKE, register: { lowMidi: 48, highMidi: 76, highFrame: 0.3, highMinFrames: 0.4 } });
    expect(reg.map((x) => x.midi).sort()).toEqual([100, 60]);
  });

  it('lowers the onset threshold for the bass when asked', () => {
    const p = posteriors(200);
    addNote(p, 26, 20, 40, 0.8, 0.4); // weak onset low D
    const plain = extractNotes(p.frames, p.onsets, 200, PIANO_LIKE);
    expect(plain).toHaveLength(0);
    const reg = extractNotes(p.frames, p.onsets, 200, { ...PIANO_LIKE, register: { lowMidi: 48, highMidi: 108, lowOnset: 0.6 } });
    expect(reg.map((x) => x.midi)).toEqual([26]);
  });
});
