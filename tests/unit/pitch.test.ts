import { describe, expect, it } from 'vitest';
import {
  CREPE_WINDOW,
  ViterbiDecoder,
  binRange,
  binToCents,
  centsToHz,
  frameCount,
  frameRms,
  hzToBin,
  localAverageHz,
  medianFilter,
  resample,
  writeFrame,
} from '../../src/lib/pitch/crepe';
import { f0ToNotes } from '../../src/lib/pitch/segment';
import { voicingMask } from '../../src/lib/pitch/index';
import { crepeMelodyLine } from '../../src/lib/pitch/line';
import { splitAtOnsets } from '../../src/lib/pitch/hybrid';
import type { Note } from '../../src/lib/music/types';

const sine = (hz: number, sr: number, n: number, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / sr));

/** dominant frequency by zero crossings (good enough for a clean sine) */
function zcHz(x: Float32Array, sr: number): number {
  let c = 0;
  for (let i = 1; i < x.length; i++) if (x[i - 1] < 0 && x[i] >= 0) c++;
  return (c * sr) / x.length;
}

const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12);

describe('CREPE bins', () => {
  it('maps bins to cents and Hz like torchcrepe', () => {
    expect(binToCents(0)).toBeCloseTo(1997.3794, 3);
    expect(centsToHz(binToCents(0))).toBeCloseTo(31.7, 1);
    // 220 Hz sits at bin ~168
    expect(hzToBin(220, Math.round)).toBe(168);
    const r = binRange(65, 1100);
    expect(r.lo).toBe(hzToBin(65));
    expect(r.hi).toBe(hzToBin(1100, Math.ceil));
    expect(r.hi - r.lo).toBeGreaterThan(240);
  });

  it('local average recovers a pitch between two bins', () => {
    const r = { lo: 100, hi: 200 };
    const act = new Float32Array(100);
    act[50] = 1;
    act[51] = 1; // bins 150 and 151 equally likely -> halfway (10 cents above bin 150)
    const hz = localAverageHz(act, 150, r);
    expect(1200 * Math.log2(hz / 10)).toBeCloseTo(binToCents(150) + 10, 5);
  });
});

describe('resample 22.05 -> 16 kHz', () => {
  it('keeps length, timebase and pitch of a sine', () => {
    const x = sine(440, 22050, 22050);
    const y = resample(x, 22050, 16000);
    expect(y.length).toBe(Math.floor((22050 - 1) * (320 / 441)) + 1);
    expect(zcHz(y.subarray(1000, 15000), 16000)).toBeCloseTo(440, -1);
    // amplitude preserved in the middle (passband)
    let peak = 0;
    for (let i = 2000; i < 14000; i++) peak = Math.max(peak, Math.abs(y[i]));
    expect(peak).toBeGreaterThan(0.48);
    expect(peak).toBeLessThan(0.52);
    // sample-exact timebase: output n corresponds to input time n / 16000
    const t = 0.5;
    expect(y[Math.round(t * 16000)]).toBeCloseTo(0.5 * Math.sin(2 * Math.PI * 440 * t), 2);
  });

  it('removes content above the new Nyquist', () => {
    const y = resample(sine(9500, 22050, 22050), 22050, 16000);
    let e = 0;
    for (let i = 1000; i < 15000; i++) e += y[i] * y[i];
    expect(Math.sqrt(e / 14000)).toBeLessThan(0.01);
  });
});

describe('framing', () => {
  it('centres frames on i*hop with zero padding and normalises like torchcrepe', () => {
    const x = Float32Array.from({ length: 4000 }, (_, i) => (i % 7) - 3 + 0.25);
    expect(frameCount(x.length, 160)).toBe(1 + Math.floor(4000 / 160));
    const out = new Float32Array(CREPE_WINDOW);
    writeFrame(x, 10, 160, out);
    let m = 0;
    for (const v of out) m += v;
    m /= CREPE_WINDOW;
    let s = 0;
    for (const v of out) s += (v - m) ** 2;
    expect(m).toBeCloseTo(0, 6);
    expect(Math.sqrt(s / (CREPE_WINDOW - 1))).toBeCloseTo(1, 5);
    // first frame: left half is padding (constant after normalisation)
    writeFrame(x, 0, 160, out);
    expect(out[0]).toBeCloseTo(out[511], 6);
    const rms = frameRms(x, 160);
    expect(rms.length).toBe(frameCount(x.length, 160));
  });

  it('frame RMS of silence is 0 and the normaliser does not divide by zero', () => {
    const out = new Float32Array(CREPE_WINDOW);
    const r = writeFrame(new Float32Array(3000), 5, 160, out);
    expect(r).toBe(0);
    expect(out.every((v) => Number.isFinite(v))).toBe(true);
  });
});

describe('Viterbi decoder', () => {
  const range = { lo: 0, hi: 100 };
  const peak = (b: number, w = 1) => Float32Array.from({ length: 100 }, (_, k) => Math.max(0, 1 - Math.abs(k - b) / (2 * w)));

  it('follows a slow glide', () => {
    const d = new ViterbiDecoder(range, 4);
    for (let t = 0; t < 60; t++) d.step(peak(20 + t));
    const p = d.finish();
    expect(p.length).toBe(60);
    for (let t = 5; t < 55; t++) expect(Math.abs(p[t] - (20 + t))).toBeLessThanOrEqual(1);
  });

  it('ignores a one-frame spike far away (transition reach ±11 bins)', () => {
    const d = new ViterbiDecoder(range, 8);
    for (let t = 0; t < 40; t++) d.step(t === 20 ? peak(80) : peak(30));
    const p = d.finish();
    expect(p[20]).toBe(30);
  });

  it('weak activations do not pull the path to the edge of the allowed range', () => {
    // CREPE emissions are weak (log-likelihood = activation in 0..1). Rows of the transition
    // matrix are normalised over all 360 bins as in torchcrepe, so the edge states of a
    // restricted range get no extra self-transition weight.
    const range = binRange(65, 1100);
    const W = range.hi - range.lo;
    const d = new ViterbiDecoder(range, 64);
    const target = 168 - range.lo; // ~220 Hz
    for (let t = 0; t < 200; t++) d.step(Float32Array.from({ length: W }, (_, k) => (Math.abs(k - target) <= 2 ? 0.35 : 0.02)));
    const p = d.finish();
    for (let t = 20; t < 180; t++) expect(Math.abs(p[t] - 168)).toBeLessThanOrEqual(2);
  });

  it('bridges uninformative frames and reaches a new held pitch after a jump', () => {
    const d = new ViterbiDecoder({ lo: 50, hi: 150 }, 8);
    const at = (b: number) => Float32Array.from({ length: 100 }, (_, k) => (k + 50 === b ? 1 : 0));
    for (let t = 0; t < 30; t++) d.step(at(70));
    for (let t = 0; t < 5; t++) d.step(null);
    for (let t = 0; t < 60; t++) d.step(at(130));
    const p = d.finish();
    expect(p[10]).toBe(70);
    expect(p[94]).toBe(130);
  });
});

describe('voicing + segmentation', () => {
  const hop = 0.01;
  const track = (midis: (number | null)[], per = 0.9) => {
    const f0 = new Float32Array(midis.length);
    const p = new Float32Array(midis.length);
    midis.forEach((m, i) => {
      f0[i] = m == null ? 0 : midiHz(m);
      p[i] = m == null ? 0 : per;
    });
    return { f0, p };
  };
  const repeat = (m: number | null, n: number) => Array.from({ length: n }, () => m);

  it('voicing needs both periodicity and loudness', () => {
    const per = Float32Array.from([0.9, 0.9, 0.9, 0.2, 0.2, 0.9, 0.9, 0.9]);
    const rms = Float32Array.from([1, 1, 1, 1, 1, 1e-3, 1e-3, 1]);
    expect(Array.from(voicingMask(per, rms, 0.5, -35))).toEqual([1, 1, 1, 0, 0, 0, 0, 1]);
  });

  it('splits at a held step, keeps the notes in order with rounded pitches', () => {
    const { f0, p } = track([...repeat(60, 30), ...repeat(62, 30), ...repeat(null, 10), ...repeat(64.2, 20)]);
    const notes = f0ToNotes(f0, p, hop);
    expect(notes.map((n) => n.midi)).toEqual([60, 62, 64]);
    expect(notes[0].start).toBeCloseTo(0, 5);
    expect(notes[1].start).toBeCloseTo(0.3, 1);
    expect(notes[2].start).toBeCloseTo(0.7, 5);
    expect(notes.every((n) => n.role === 'melody' && n.hand === 'R')).toBe(true);
    expect(notes[0].vel).toBeCloseTo(0.9, 5);
  });

  it('vibrato (±0.6 st at 6 Hz) stays one note', () => {
    const m = Array.from({ length: 100 }, (_, i) => 67 + 0.6 * Math.sin((2 * Math.PI * 6 * i) / 100));
    const { f0, p } = track(m);
    const notes = f0ToNotes(f0, p, hop);
    expect(notes.length).toBe(1);
    expect(notes[0].midi).toBe(67);
    expect(notes[0].dur).toBeCloseTo(1, 1);
  });

  it('bridges a short dropout inside a held note and drops tiny blips', () => {
    const { f0, p } = track([...repeat(65, 30), ...repeat(null, 3), ...repeat(65, 30), ...repeat(null, 20), ...repeat(72, 4), ...repeat(null, 20)]);
    const notes = f0ToNotes(f0, p, hop);
    expect(notes.length).toBe(1);
    expect(notes[0].dur).toBeCloseTo(0.63, 2);
  });

  it('a short neighbour between two equal pitches is merged (vibrato split)', () => {
    const { f0, p } = track([...repeat(60, 25), ...repeat(61, 9), ...repeat(60, 25)]);
    const notes = f0ToNotes(f0, p, hop);
    expect(notes.map((n) => n.midi)).toEqual([60]);
  });

  it('median filter', () => {
    expect(Array.from(medianFilter(Float32Array.from([1, 9, 1, 1, 5, 5, 5]), 3))).toEqual([9, 1, 1, 1, 5, 5, 5]);
  });
});

const note = (midi: number, start: number, dur: number, vel = 0.8): Note => ({ id: Math.round(start * 1000) + midi, midi, start, dur, vel, hand: 'R', role: 'melody' });

describe('CREPE melody line', () => {
  it('keeps a monophonic line (no polyphonic reduction), merges same-pitch fragments', () => {
    const c = [note(60, 0, 0.3), note(72, 0.31, 0.3), note(60, 0.62, 0.3), note(60, 0.93, 0.2), note(65, 1.2, 0.4)];
    const line = crepeMelodyLine(c);
    expect(line.map((n) => n.midi)).toEqual([60, 72, 60, 65]); // the octave leap stays (fixOctaves off)
    expect(line[2].dur).toBeCloseTo(0.51, 2);
    expect(line.every((n) => n.role === 'melody' && n.hand === 'R')).toBe(true);
  });

  it('moves an implausibly low line up by octaves and drops an isolated long hold', () => {
    const c = [note(45, 0, 0.4), note(47, 0.5, 0.4), note(48, 1, 0.4), note(45, 1.5, 0.4), note(84, 10, 5)];
    const line = crepeMelodyLine(c);
    expect(line.map((n) => n.midi)).toEqual([57, 59, 60, 57]);
  });
});

describe('split at Basic Pitch onsets', () => {
  it('splits a held note where a same-pitch-class onset starts inside it, leaving a gap', () => {
    const out = splitAtOnsets([note(64, 1, 1)], [note(52, 1.5, 0.3, 0.8), note(64, 1.05, 0.2, 0.9), note(67, 1.7, 0.2, 0.9)]);
    expect(out.length).toBe(2);
    expect(out[0].start).toBeCloseTo(1, 5);
    expect(out[0].dur).toBeCloseTo(0.47, 5);
    expect(out[1].start).toBeCloseTo(1.5, 5);
    expect(out[1].start + out[1].dur).toBeCloseTo(2, 5);
  });
});
