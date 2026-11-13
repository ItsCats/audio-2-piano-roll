import { describe, expect, it } from 'vitest';
import { gapCue, pitchContinues, pitchHeldEnd, pitchSupport, storedPitch, type StoredPitch } from '../../src/lib/transcription/stemPitch';
import type { Note } from '../../src/lib/music/types';

const HOP = 0.01;
/** A pitch track: `segs` = [midi, start s, end s, confidence]; silent elsewhere. */
function track(seconds: number, segs: [number, number, number, number?][]): StoredPitch {
  const n = Math.round(seconds / HOP);
  const f0 = new Float32Array(n);
  const per = new Float32Array(n);
  const rms = new Float32Array(n).fill(1e-4);
  for (const [midi, a, b, c = 0.9] of segs) {
    for (let i = Math.round(a / HOP); i < Math.min(n, Math.round(b / HOP)); i++) {
      f0[i] = 440 * 2 ** ((midi - 69) / 12);
      per[i] = c;
      rms[i] = 0.1;
    }
  }
  return storedPitch({ f0, periodicity: per, rms, hop: HOP });
}

let id = 1;
const note = (midi: number, start: number, dur: number, vel = 0.7, extra: Partial<Note> = {}): Note => ({ id: id++, midi, start, dur, vel, hand: 'R', ...extra });

describe('stem pitch cue', () => {
  it('measures agreement at the pitch and an octave away; quiet or unsure frames carry no pitch', () => {
    const p = track(3, [[72, 0, 1], [60, 1, 2], [65, 2, 3, 0.2]]);
    const a = pitchSupport(p, 72, 0.12, 0.45);
    expect(a.exact).toBe(1);
    const b = pitchSupport(p, 72, 1.12, 1.45);
    expect(b.exact).toBe(0);
    expect(b.down).toBe(1);
    expect(b.pc).toBe(1);
    expect(pitchSupport(p, 65, 2.12, 2.45).voiced).toBe(0);
  });

  it('reads a gap: frames with a pitch, those at the pitch class, the level fall', () => {
    const p = track(2, [[72, 0, 0.5], [60, 0.5, 0.6], [67, 0.6, 0.7]]);
    const c = gapCue(p, 72, 0.5, 0.69);
    expect(c.voiced).toBe(20);
    expect(c.agree).toBe(10);
    expect(c.dropDb).toBeCloseTo(0);
    // silence after 0.7 s: the level falls (rms 0.1 -> 1e-4 = 60 dB)
    expect(gapCue(p, 72, 0.7, 0.8).dropDb).toBeGreaterThan(50);
  });

  it('holds a note while the track stays at its pitch class, up to the limit; stops at another pitch or silence', () => {
    const p = track(3, [[74, 0, 1.2], [65, 1.2, 1.6]]);
    const n = note(74, 0, 0.3);
    expect(pitchHeldEnd(p, n, 2)).toBeCloseTo(1.2, 1);
    expect(pitchHeldEnd(p, n, 0.8)).toBeCloseTo(0.8);
    expect(pitchHeldEnd(p, note(62, 0, 0.3), 2)).toBeCloseTo(1.2, 1); // an octave apart: same pitch class
    expect(pitchHeldEnd(p, note(65, 0, 0.3), 2)).toBeCloseTo(0.3); // another pitch: not held
    expect(pitchHeldEnd(track(3, [[74, 0, 0.5]]), n, 2)).toBeCloseTo(0.5, 1); // silence ends it
    expect(pitchContinues(p, 74, 0.5)).toBe(true);
    expect(pitchContinues(p, 74, 1.25)).toBe(false);
  });

  it('ends a hold where the track moves to the same pitch class an octave away (the tune moved), not at a steady octave error', () => {
    // a G4 held while the track is at G4, then the track drops to G3: the hold ends there
    const p = track(3, [[67, 0, 0.6], [55, 0.6, 1.2]]);
    expect(pitchHeldEnd(p, note(67, 0, 0.3), 2)).toBeCloseTo(0.6, 1);
    // the track an octave below the note throughout (CREPE's octave error): held as before
    const q = track(3, [[55, 0, 1.2]]);
    expect(pitchHeldEnd(q, note(67, 0, 0.3), 2)).toBeCloseTo(1.2, 1);
    expect(pitchHeldEnd(p, note(67, 0, 0.3), 2, { on: true, stopAfter: 0.03, maxSilent: 0.08, maxDropDb: 12, sameOctave: false })).toBeCloseTo(1.2, 1);
  });

  it('ends a hold where the stem fades by more than maxDropDb, even at the same pitch', () => {
    // 74 throughout, the stem 20 dB quieter from 0.8 s (a fading phrase end)
    const n = Math.round(2 / HOP);
    const f0 = new Float32Array(n).fill(440 * 2 ** ((74 - 69) / 12));
    const per = new Float32Array(n).fill(0.9);
    const rms = new Float32Array(n).fill(0.1);
    for (let i = Math.round(0.8 / HOP); i < n; i++) rms[i] = 0.01;
    const p = storedPitch({ f0, periodicity: per, rms, hop: HOP });
    expect(pitchHeldEnd(p, note(74, 0, 0.3), 1.8)).toBeCloseTo(0.8, 1);
    expect(pitchHeldEnd(p, note(74, 0, 0.3), 1.8, { on: true, stopAfter: 0.03, maxSilent: 0.08, maxDropDb: 30, sameOctave: true })).toBeCloseTo(1.8, 1);
  });

  it('does not count a note struck an octave below as backing when the track is at that note', () => {
    // a held 79; at 1 s a 67 is struck and the track follows it (the tune stepped down an octave)
    const p = track(3, [[79, 0, 1], [67, 1, 2]]);
    expect(pitchContinues(p, 79, 1, 67)).toBe(false);
    // the track stays at 79 while a 67 is struck: backing under the held note
    const q = track(3, [[79, 0, 2]]);
    expect(pitchContinues(q, 79, 1, 67)).toBe(true);
    // a struck note of another pitch class: only the held note's pitch class counts
    expect(pitchContinues(q, 79, 1, 64)).toBe(true);
  });
});
