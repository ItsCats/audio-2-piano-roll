import { describe, expect, it } from 'vitest';
import { BASS_LINE, bassExplained, decodeBassLine, mergeBassLine, type BassPosteriors } from '../../src/lib/transcription/bassLine';
import { BP_FPS, BP_MIDI_OFFSET, BP_N_PITCHES, timeToFrame } from '../../src/lib/transcription/constants';
import type { Note } from '../../src/lib/music/types';

/** Synthetic bass-stem posteriors: `events` = [midi, start s, end s, level, onset?]. */
function post(seconds: number, events: [number, number, number, number, number?][]): BassPosteriors {
  const nFrames = Math.ceil(seconds * BP_FPS) + 1;
  const frames = new Float32Array(nFrames * BP_N_PITCHES);
  const onsets = new Float32Array(nFrames * BP_N_PITCHES);
  for (const [midi, a, b, level, onset = 0.9] of events) {
    const f = midi - BP_MIDI_OFFSET;
    const t0 = timeToFrame(a);
    const t1 = timeToFrame(b);
    for (let t = t0; t < t1; t++) frames[t * BP_N_PITCHES + f] = Math.max(frames[t * BP_N_PITCHES + f], level);
    onsets[t0 * BP_N_PITCHES + f] = onset;
  }
  return { nFrames, frames, onsets };
}

let id = 1;
const note = (midi: number, start: number, dur: number, hand: Note['hand'] = 'L'): Note => ({ id: id++, midi, start, dur, vel: 0.7, hand });

describe('bass line decoder', () => {
  it('keeps one note at a time: the stronger of two simultaneous pitches, never both', () => {
    const p = post(3, [
      [40, 0.5, 1.5, 0.8],
      [52, 0.5, 1.5, 0.45], // its octave above, weaker (overtone)
      [43, 1.6, 2.6, 0.7],
    ]);
    const line = decodeBassLine(p);
    expect(line.map((n) => n.midi)).toEqual([40, 43]);
    for (let i = 1; i < line.length; i++) expect(line[i].start).toBeGreaterThanOrEqual(line[i - 1].start + line[i - 1].dur - 1e-9);
    expect(line[0].start).toBeCloseTo(0.5, 1);
    expect(line[0].dur).toBeCloseTo(1, 1);
    expect(line.every((n) => n.hand === 'L')).toBe(true);
  });

  it('drops a soft-attack note without a clearly held pitch (a kick thump), keeps a clear one', () => {
    const p = post(3, [
      [36, 0.5, 0.7, 0.5, 0.2], // soft attack, wavering pitch: a kick leaking into the stem
      [40, 1.0, 2.0, 0.8, 0.2], // soft attack but a clearly held pitch: a slid/legato bass note
      [43, 2.2, 2.6, 0.5, 0.9], // clear attack
    ]);
    expect(decodeBassLine(p).map((n) => n.midi)).toEqual([40, 43]);
    expect(decodeBassLine(p, { weakOnset: 0 }).map((n) => n.midi)).toEqual([36, 40, 43]);
  });

  it('splits a run of one pitch only at a clear new attack', () => {
    // two struck notes back to back, and a long note with a weak onset blip in the middle
    const p = post(4, [
      [45, 0.2, 0.8, 0.8],
      [45, 0.8, 1.4, 0.8],
      [38, 2, 3.5, 0.8],
    ]);
    // weak blip inside the long note
    const blip = timeToFrame(2.7) * BP_N_PITCHES + (38 - BP_MIDI_OFFSET);
    (p.onsets as Float32Array)[blip] = 0.3;
    const line = decodeBassLine(p);
    expect(line.filter((n) => n.midi === 45)).toHaveLength(2);
    expect(line.filter((n) => n.midi === 38)).toHaveLength(1);
  });

  it('drops kick-like blips: too short or without a clear pitch', () => {
    const p = post(2, [
      [33, 0.5, 0.53, 0.9], // 30 ms
      [36, 1.0, 1.4, 0.32], // faint, under the clear-pitch test
    ]);
    expect(decodeBassLine(p, { silence: 0.2 })).toHaveLength(0);
  });

  it('ignores pitches outside its range', () => {
    const p = post(2, [[64, 0.5, 1.5, 0.9]]);
    expect(decodeBassLine(p)).toHaveLength(0);
    expect(BASS_LINE.maxMidi).toBeLessThan(64);
  });
});

describe('bass line merge', () => {
  it('replaces the low notes the bass stem explains and keeps chord notes from the other instruments', () => {
    const p = post(3, [[40, 0.5, 2, 0.8]]);
    const line = decodeBassLine(p);
    const restrike = note(40, 1.2, 0.3); // re-strike of the held bass note
    const octave = note(52, 0.5, 0.5); // octave duplicate
    const chord = note(60, 0.5, 1); // other instruments
    const lowChord = note(47, 0.5, 1); // a low chord tone the bass stem does not play
    const out = mergeBassLine([restrike, octave, chord, lowChord], line, p);
    expect(out).toContain(chord);
    expect(out).toContain(lowChord);
    expect(out).not.toContain(restrike);
    expect(out).not.toContain(octave);
    expect(out.filter((n) => n.midi === 40)).toHaveLength(1);
    expect(bassExplained(restrike, p, line)).toBe(true);
    expect(bassExplained(chord, p, line)).toBe(false);
  });

  it('changes nothing without a line', () => {
    const notes = [note(40, 0, 1)];
    expect(mergeBassLine(notes, [], post(1, []))).toBe(notes);
  });
});
