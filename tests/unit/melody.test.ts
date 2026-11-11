import { describe, expect, it } from 'vitest';
import type { Note, TempoInfo } from '../../src/lib/music/types';
import {
  extractMelodyLine,
  fixOctaveOutliers,
  mergeMelody,
  reduceToLine,
  registerShift,
  removeMelodyCollisions,
  smoothLine,
} from '../../src/lib/music/melody';
import { easyBassLine, generateEasy, generateHard, generateMedium } from '../../src/lib/music/difficulty';
import { regularBeats } from '../../src/lib/music/beats';

let id = 1;
const n = (midi: number, start: number, dur = 0.4, vel = 0.7, hand: Note['hand'] = 'R', role?: Note['role']): Note => ({
  id: id++,
  midi,
  start,
  dur,
  vel,
  hand,
  ...(role ? { role } : {}),
});
const tempo = (bpm = 120, seconds = 30): TempoInfo => ({
  bpm,
  beats: regularBeats(bpm, 0, seconds),
  beatsPerBar: 4,
  downbeatIndex: 0,
  confidence: 1,
  source: 'manual',
});

/** at most one note sounding at any time */
function isMonophonic(line: Note[]): boolean {
  const s = [...line].sort((a, b) => a.start - b.start);
  for (let i = 1; i < s.length; i++) if (s[i].start < s[i - 1].start + s[i - 1].dur - 1e-6) return false;
  return true;
}

describe('melody line: monophonic reduction', () => {
  it('keeps one note at a time and prefers the salient voice over harmonics and backing', () => {
    const notes: Note[] = [];
    const tune = [64, 65, 67, 69, 67, 65, 64, 62];
    tune.forEach((m, i) => {
      notes.push(n(m, i * 0.5, 0.45, 0.85)); // lead
      notes.push(n(m + 12, i * 0.5 + 0.01, 0.3, 0.35)); // octave harmonic, quieter, shorter
      notes.push(n(m - 4, i * 0.5 + 0.02, 0.45, 0.4)); // backing vocal a third below
    });
    const line = reduceToLine(notes);
    expect(isMonophonic(line)).toBe(true);
    expect(line.map((x) => x.midi)).toEqual(tune);
  });

  it('does not flip octaves when a harmonic briefly gets louder', () => {
    const notes: Note[] = [];
    for (let i = 0; i < 10; i++) {
      const m = 60 + (i % 3);
      const loudHarmonic = i === 5;
      notes.push(n(m, i * 0.4, 0.38, loudHarmonic ? 0.5 : 0.8));
      notes.push(n(m + 12, i * 0.4, 0.38, loudHarmonic ? 0.55 : 0.3));
    }
    const line = reduceToLine(notes);
    expect(line).toHaveLength(10);
    expect(line.every((x) => x.midi < 72)).toBe(true);
  });

  it('ignores notes outside the singing range and weak bleed between phrases', () => {
    const notes = [n(30, 0, 0.5, 0.9), n(62, 0, 0.5, 0.8), n(95, 0.6, 0.5, 0.9), n(64, 0.6, 0.5, 0.8), n(50, 3, 0.3, 0.18)];
    const line = reduceToLine(notes);
    expect(line.map((x) => x.midi)).toEqual([62, 64]);
  });

  it('starts a new phrase after a silence without penalising the jump', () => {
    const notes = [n(60, 0, 0.5, 0.8), n(62, 0.5, 0.5, 0.8), n(74, 3, 0.5, 0.8), n(76, 3.5, 0.5, 0.8)];
    expect(reduceToLine(notes).map((x) => x.midi)).toEqual([60, 62, 74, 76]);
  });
});

describe('melody line: smoothing', () => {
  it('merges vibrato splits and same-pitch fragments', () => {
    const line = [n(67, 0, 0.3), n(68, 0.31, 0.08), n(67, 0.4, 0.3), n(67, 0.72, 0.3), n(69, 1.2, 0.4)];
    const s = smoothLine(line);
    expect(s.map((x) => x.midi)).toEqual([67, 69]);
    expect(s[0].start).toBe(0);
    expect(s[0].start + s[0].dur).toBeCloseTo(1.02, 5);
  });

  it('folds a short scoop into the note it leads to', () => {
    const s = smoothLine([n(62, 0, 0.04), n(64, 0.045, 0.5)]);
    expect(s).toHaveLength(1);
    expect(s[0].midi).toBe(64);
    expect(s[0].start).toBe(0);
  });

  it('moves an isolated octave error back into the line', () => {
    const line = [60, 62, 64, 77, 64, 62, 60].map((m, i) => n(m, i * 0.5, 0.45));
    expect(fixOctaveOutliers(line).map((x) => x.midi)).toEqual([60, 62, 64, 65, 64, 62, 60]);
  });
});

describe('melody line: register', () => {
  it('transposes a low (male) line up an octave, a very low one two', () => {
    expect(registerShift([55, 57, 59, 55].map((m, i) => n(m, i)))).toBe(12);
    expect(registerShift([36, 38, 40].map((m, i) => n(m, i)))).toBe(24);
    // a line centred on B♭3–C4 is left alone (no octave flip right at the boundary)
    expect(registerShift([58, 60, 59].map((m, i) => n(m, i)))).toBe(0);
    expect(registerShift([64, 67, 69].map((m, i) => n(m, i)))).toBe(0);
    expect(registerShift([86, 88, 84].map((m, i) => n(m, i)))).toBe(-12);
  });

  it('extractMelodyLine marks the line as right-hand melody in a comfortable register', () => {
    const vocal = [53, 55, 57, 58, 57, 55, 53, 52, 53].map((m, i) => n(m, i * 0.5, 0.45, 0.8, 'L'));
    const line = extractMelodyLine(vocal);
    expect(line).toHaveLength(9);
    expect(line.every((x) => x.role === 'melody' && x.hand === 'R')).toBe(true);
    expect(line.map((x) => x.midi)).toEqual([65, 67, 69, 70, 69, 67, 65, 64, 65]);
  });
});

describe('melody + accompaniment', () => {
  it('removes accompaniment unisons and octave doubles of melody onsets, cuts held same-pitch notes', () => {
    const melody = [n(67, 1, 0.5, 0.8, 'R', 'melody'), n(69, 2, 0.5, 0.8, 'R', 'melody')];
    const acc = [
      n(67, 1.02, 0.4), // unison double → removed
      n(55, 1.0, 0.5), // octave below at the same onset → removed
      n(64, 1.0, 0.5), // chord tone → kept
      n(69, 1.5, 1.0), // same key held into the melody note → cut before it
      n(69, 2.2, 0.3), // same key struck while the melody holds it → removed
      n(43, 1.0, 1.0, 0.7, 'L'), // bass two octaves below → kept
    ];
    const kept = removeMelodyCollisions(acc, melody);
    expect(kept.map((x) => x.midi).sort()).toEqual([43, 64, 69]);
    const held = kept.find((x) => x.midi === 69)!;
    expect(held.start + held.dur).toBeLessThanOrEqual(2);
  });

  it('mergeMelody keeps the melody in the right hand even when it is low', () => {
    const melody = [n(52, 0, 0.5, 0.8, 'R', 'melody'), n(53, 0.5, 0.5, 0.8, 'R', 'melody')];
    const acc = [n(40, 0, 1, 0.7), n(72, 0, 1, 0.7), n(76, 0, 1, 0.7)];
    const merged = mergeMelody(acc, melody, 2);
    expect(merged.filter((x) => x.role === 'melody').every((x) => x.hand === 'R')).toBe(true);
    expect(merged.find((x) => x.midi === 40)!.hand).toBe('L');
    expect(merged).toHaveLength(5);
  });
});

describe('arrangements with a sung melody', () => {
  const t = tempo(120, 20);
  // melody in 8ths with a 16th passing note, chords on beats, bass on beats
  const melody: Note[] = [];
  const mel = [72, 74, 76, 77, 76, 74, 72, 71];
  mel.forEach((m, i) => melody.push(n(m, i * 0.5, 0.45, 0.8, 'R', 'melody')));
  melody.push(n(73, 0.06, 0.12, 0.5, 'R', 'melody')); // grace note in the same 8th slot as the first note
  const acc: Note[] = [];
  for (let b = 0; b < 8; b++) {
    acc.push(n(48, b * 0.5, 0.45, 0.7, 'L'));
    acc.push(n(64, b * 0.5, 0.45, 0.6, 'R'), n(67, b * 0.5, 0.45, 0.6, 'R'), n(79, b * 0.5, 0.45, 0.6, 'R')); // 79: above the melody
  }
  const base = [...melody, ...acc];

  it('Easy right hand is the melody line, one note at a time', () => {
    const easy = generateEasy(base, t, 4);
    const rh = easy.filter((x) => x.hand === 'R').sort((a, b) => a.start - b.start);
    expect(isMonophonic(rh)).toBe(true);
    expect(rh.map((x) => x.midi)).toEqual(mel); // accompaniment's 79 above the melody never wins
    expect(easy.filter((x) => x.hand === 'L').every((x) => x.midi % 12 === 0)).toBe(true);
  });

  it('Medium right hand = melody + up to two consonant tones below it', () => {
    const med = generateMedium(base, t);
    const rh = med.filter((x) => x.hand === 'R');
    for (const m of mel) expect(rh.some((x) => x.midi === m)).toBe(true);
    expect(rh.some((x) => x.midi === 79)).toBe(false);
    const byStart = new Map<number, number[]>();
    for (const x of rh) byStart.set(Math.round(x.start * 100), [...(byStart.get(Math.round(x.start * 100)) ?? []), x.midi]);
    for (const group of byStart.values()) {
      expect(group.length).toBeLessThanOrEqual(3);
      const top = Math.max(...group);
      expect(group.every((p) => p === top || (top - p > 0 && top - p < 12))).toBe(true);
    }
    expect([...byStart.values()].some((g) => g.length > 1)).toBe(true);
  });

  it('Hard keeps everything', () => {
    expect(generateHard(base)).toHaveLength(base.length);
  });

  it('without role notes Easy is unchanged (skyline of the right hand)', () => {
    const plain = base.map((x) => ({ ...x, role: undefined }));
    const rh = generateEasy(plain, t, 4).filter((x) => x.hand === 'R');
    expect(rh.filter((x) => x.midi === 79).length).toBeGreaterThanOrEqual(7);
  });
});

describe('Easy left hand bass line', () => {
  it('follows the lowest sounding note beat by beat and sustains repeated notes', () => {
    const t = tempo(120, 10);
    // bass: C2 pumping 8ths for 2 beats, then G1 for 2 beats; a tenor line above it
    const left: Note[] = [];
    for (let i = 0; i < 4; i++) left.push(n(36, i * 0.25, 0.2, 0.7, 'L'));
    for (let i = 0; i < 4; i++) left.push(n(31, 1 + i * 0.25, 0.2, 0.7, 'L'));
    left.push(n(55, 0, 2, 0.8, 'L'));
    const line = easyBassLine(left, t, 2);
    expect(line.map((x) => x.midi % 12)).toEqual([0, 7]);
    expect(line[0].start).toBeCloseTo(0, 5);
    expect(line[0].dur).toBeGreaterThan(0.9);
    expect(line[1].start).toBeCloseTo(1, 5);
  });

  it('a bass change on the second beat of a half bar is not lost', () => {
    const t = tempo(100, 10);
    const beat = 0.6;
    const left = [n(40, 0, beat * 0.9, 0.7, 'L'), n(45, beat, beat * 0.9, 0.7, 'L'), n(43, 2 * beat, beat * 0.9, 0.7, 'L'), n(38, 3 * beat, beat * 0.9, 0.7, 'L')];
    expect(easyBassLine(left, t, 4 * beat).map((x) => x.midi % 12)).toEqual([4, 9, 7, 2]);
  });
});

describe('instrumental stretches of a song with singing', () => {
  it('Easy/Medium right hand play the accompaniment top line where nobody sings for a long time', () => {
    const t = tempo(120, 40);
    const base: Note[] = [];
    // 8 s instrumental intro with a lead line on top, then 4 s of singing
    for (let i = 0; i < 16; i++) base.push(n(76 + (i % 3), i * 0.5, 0.45, 0.8), n(64, i * 0.5, 0.45, 0.5), n(48, i * 0.5, 0.45, 0.7, 'L'));
    for (let i = 0; i < 8; i++) base.push(n(72 + (i % 2), 8 + i * 0.5, 0.45, 0.8, 'R', 'melody'), n(79, 8 + i * 0.5, 0.45, 0.6), n(48, 8 + i * 0.5, 0.45, 0.7, 'L'));
    const rh = generateEasy(base, t, 12).filter((x) => x.hand === 'R');
    const intro = rh.filter((x) => x.start < 7);
    expect(intro.length).toBeGreaterThanOrEqual(12); // the lead line, not silence
    expect(intro.every((x) => x.midi >= 76)).toBe(true);
    const sungPart = rh.filter((x) => x.start >= 8);
    expect(sungPart.map((x) => x.midi)).toEqual([72, 73, 72, 73, 72, 73, 72, 73]); // the 79s above the singer stay out
    const med = generateMedium(base, t).filter((x) => x.hand === 'R');
    expect(med.some((x) => x.start < 7 && x.midi >= 76)).toBe(true);
    expect(med.some((x) => x.start >= 8 && x.midi === 79)).toBe(false);
  });
});
