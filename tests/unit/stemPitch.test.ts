import { describe, expect, it } from 'vitest';
import { clearAboveTune, fixLineOctaves, gapCue, noteSupport, pitchContinues, pitchHeldEnd, storedPitch, tagTune, type StoredPitch } from '../../src/lib/transcription/stemPitch';
import { instrumentLine } from '../../src/lib/music/melody';
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
    const a = noteSupport(p, note(72, 0.1, 0.5));
    expect(a.exact).toBe(1);
    const b = noteSupport(p, note(72, 1.1, 0.5));
    expect(b.exact).toBe(0);
    expect(b.down).toBe(1);
    expect(noteSupport(p, note(65, 2.1, 0.5)).voiced).toBe(0);
  });

  it('tags notes in the tune register only where the track has a pitch', () => {
    const p = track(2, [[72, 0, 1]]);
    const [on, off, low, silent, octave] = tagTune([note(72, 0.1, 0.4), note(76, 0.1, 0.4), note(40, 0.1, 0.4), note(72, 1.3, 0.4), note(60, 0.1, 0.4)], p);
    expect(on.tune).toBe(1);
    expect(off.tune).toBe(0);
    // the pitch class counts (CREPE-tiny on a mixed stem often reports the octave below)
    expect(octave.tune).toBe(1);
    expect(tagTune([note(60, 0.1, 0.4)], p, { minMidi: 55, minVoiced: 0.4, pitchClass: false })[0].tune).toBe(0);
    expect(low.tune).toBeUndefined();
    expect(silent.tune).toBeUndefined();
  });

  it('lets the tune line prefer the note the stem confirms over a louder one on top', () => {
    // a louder accompaniment note above the lead at each step; the stem hears the lead
    const lead = [note(67, 0, 0.45, 0.5), note(69, 0.5, 0.45, 0.5), note(71, 1, 0.45, 0.5)];
    const acc = [note(74, 0, 0.45, 0.8), note(76, 0.5, 0.45, 0.8), note(74, 1, 0.45, 0.8)];
    const plain = instrumentLine([...lead, ...acc]);
    expect(plain.map((n) => n.midi)).toEqual([74, 76, 74]);
    const p = track(2, [[67, 0, 0.5], [69, 0.5, 1], [71, 1, 1.5]]);
    const cued = instrumentLine(tagTune([...lead, ...acc], p), { cueBonus: 1 });
    expect(cued.map((n) => n.midi)).toEqual([67, 69, 71]);
  });

  it('moves a tune-line note the track hears an octave higher, per phrase where the note itself is unclear', () => {
    const p = track(3, [[76, 0, 0.5], [79, 0.5, 0.9], [77, 1.0, 1.04]]);
    const a = note(64, 0, 0.45);
    const b = note(67, 0.5, 0.45);
    const c = note(65, 1.0, 0.4); // only 4 frames of pitch: follows the phrase
    const other = note(60, 2, 0.5); // not on the line: untouched
    const out = fixLineOctaves([a, b, c, other], new Set([a.id, b.id, c.id]), p);
    expect(out.map((n) => n.midi)).toEqual([76, 79, 77, 60]);
    expect(out[0].id).toBe(a.id);
    expect(out[3]).toBe(other);
  });

  it('does not move a note onto a pitch another note already plays then', () => {
    const p = track(1, [[76, 0, 0.5]]);
    const a = note(64, 0, 0.45);
    const up = note(76, 0, 0.45, 0.3);
    const out = fixLineOctaves([a, up], new Set([a.id]), p);
    expect(out[0]).toBe(a);
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

  it('ends a hold where the stem fades by more than maxDropDb, even at the same pitch', () => {
    // 74 throughout, the stem 20 dB quieter from 0.8 s (a fading phrase end)
    const n = Math.round(2 / HOP);
    const f0 = new Float32Array(n).fill(440 * 2 ** ((74 - 69) / 12));
    const per = new Float32Array(n).fill(0.9);
    const rms = new Float32Array(n).fill(0.1);
    for (let i = Math.round(0.8 / HOP); i < n; i++) rms[i] = 0.01;
    const p = storedPitch({ f0, periodicity: per, rms, hop: HOP });
    expect(pitchHeldEnd(p, note(74, 0, 0.3), 1.8)).toBeCloseTo(0.8, 1);
    expect(pitchHeldEnd(p, note(74, 0, 0.3), 1.8, { on: true, stopAfter: 0.03, maxSilent: 0.08, maxDropDb: 30 })).toBeCloseTo(1.8, 1);
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

  it('drops (or lowers) a note the track does not hear struck above a confirmed tune note', () => {
    const tune = note(72, 0, 0.5, 0.6, { tune: 1 });
    const above = note(76, 0.01, 0.5, 0.8, { tune: 0 });
    const doubled = note(84, 0.01, 0.5, 0.8, { tune: 1 }); // the tune's own pitch class: kept
    const unknown = note(79, 0.01, 0.5, 0.8); // no cue: kept
    const ids = new Set([tune.id]);
    const notes = [tune, above, doubled, unknown];
    expect(clearAboveTune(notes, ids, { mode: 'off', minTune: 0.5, maxTune: 0.1, window: 0.06, octaveOnly: false })).toBe(notes);
    const dropped = clearAboveTune(notes, ids, { mode: 'drop', minTune: 0.5, maxTune: 0.1, window: 0.06, octaveOnly: false });
    expect(dropped.map((n) => n.midi)).toEqual([72, 84, 79]);
    const lowered = clearAboveTune(notes, ids, { mode: 'lower', minTune: 0.5, maxTune: 0.1, window: 0.06, octaveOnly: false });
    expect(lowered.map((n) => n.midi)).toEqual([72, 64, 84, 79]);
  });
});
