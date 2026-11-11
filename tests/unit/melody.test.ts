import { describe, expect, it } from 'vitest';
import type { Note, TempoInfo } from '../../src/lib/music/types';
import {
  dropIsolatedHolds,
  extractMelody,
  extractMelodyLine,
  fixOctaveOutliers,
  mergeMelody,
  phrases,
  reduceToLine,
  registerShift,
  removeMelodyCollisions,
  rightHandShifts,
  smoothLine,
  speechSections,
} from '../../src/lib/music/melody';
import { easyBassLine, easySungLine, generateEasy, generateHard, generateMedium, gridFactor, placeSungGroups } from '../../src/lib/music/difficulty';
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

/** duration-weighted median pitch */
function wMedian(notes: Note[]): number {
  const s = [...notes].sort((a, b) => a.midi - b.midi);
  const total = s.reduce((a, x) => a + x.dur, 0);
  let acc = 0;
  for (const x of s) if ((acc += x.dur) >= total / 2) return x.midi;
  return NaN;
}

describe('right-hand register of the sung line (Easy / Medium)', () => {
  // a low male line around G3 (median 55) in two phrases, bass around C3
  const t = tempo(120, 30);
  const phraseA = [55, 57, 55, 53, 55, 57, 59, 57];
  const phraseB = [52, 53, 55, 57, 55, 53, 52, 50];
  const sung: Note[] = [];
  phraseA.forEach((m, i) => sung.push(n(m, i * 0.5, 0.45, 0.85, 'R', 'melody')));
  phraseB.forEach((m, i) => sung.push(n(m, 6 + i * 0.5, 0.45, 0.85, 'R', 'melody')));
  const acc: Note[] = [];
  for (let b = 0; b < 20; b++) acc.push(n(48, b * 0.5, 0.45, 0.7, 'L'), n(43, b * 0.5, 0.45, 0.7, 'L'));
  const base = [...sung, ...acc];

  it('moves the whole line by octaves so its median sits in E4–E5', () => {
    const shifts = rightHandShifts(sung, []);
    expect(new Set(shifts.values())).toEqual(new Set([12]));
    // already comfortable: untouched; very high: down
    expect(new Set(rightHandShifts([67, 69, 71].map((m, i) => n(m, i)), []).values())).toEqual(new Set([0]));
    expect(new Set(rightHandShifts([86, 88, 84].map((m, i) => n(m, i)), []).values())).toEqual(new Set([-12]));
  });

  it('moves a phrase further up when it would sit on top of the left hand', () => {
    // a line around F4 (median 65, in range) over a left hand reaching up to C4
    const line = [65, 64, 67, 65, 64, 67].map((m, i) => n(m, i * 0.5, 0.45, 0.8));
    const left = [n(60, 0, 3, 0.7, 'L'), n(48, 0, 3, 0.7, 'L')];
    const s = rightHandShifts(line, left);
    expect(new Set(s.values())).toEqual(new Set([12]));
    // without the high left-hand note it stays
    expect(new Set(rightHandShifts(line, [n(48, 0, 3, 0.7, 'L')]).values())).toEqual(new Set([0]));
  });

  it('splits phrases at silences and keeps every phrase octave-consistent', () => {
    expect(phrases(sung, 1).map((p) => p.length)).toEqual([8, 8]);
    const s = rightHandShifts(sung, acc.filter((x) => x.hand === 'L'));
    for (const p of phrases(sung, 1)) expect(new Set(p.map((x) => s.get(x))).size).toBe(1);
  });

  for (const level of ['easy', 'medium'] as const) {
    it(`${level}: the sung line sits in the right-hand register, clear of the left hand, intervals intact`, () => {
      const out = level === 'easy' ? generateEasy(base, t, 12) : generateMedium(base, t);
      const rhMel = out.filter((x) => x.role === 'melody').sort((a, b) => a.start - b.start);
      expect(rhMel).toHaveLength(16);
      const med = wMedian(rhMel);
      expect(med).toBeGreaterThanOrEqual(64);
      expect(med).toBeLessThanOrEqual(76);
      const lh = out.filter((x) => x.hand === 'L');
      for (const m of rhMel) {
        const under = lh.filter((l) => l.start < m.start + m.dur && m.start < l.start + l.dur);
        for (const l of under) expect(m.midi - l.midi).toBeGreaterThanOrEqual(5);
      }
      // same melodic intervals as sung (octave-consistent transposition)
      const sungSorted = [...phraseA, ...phraseB];
      const d0 = rhMel[0].midi - sungSorted[0];
      expect(d0 % 12).toBe(0);
      expect(rhMel.map((x) => x.midi - d0)).toEqual(sungSorted);
    });
  }

  it('Medium chord tones move with their melody note; ones that would hit the left hand are dropped', () => {
    const m = n(55, 0, 0.45, 0.85, 'R', 'melody');
    const groups = [[m, n(52, 0, 0.45, 0.6), n(48, 0, 0.45, 0.6)]]; // a third and a fifth below G3
    const left = [n(48, 0, 1, 0.7, 'L'), n(60, 0, 1, 0.7, 'L')]; // left hand up to C4
    const [g] = placeSungGroups(groups, left);
    expect(g[0].midi).toBe(67);
    expect(g.slice(1).map((x) => x.midi)).toEqual([64]); // E4 stays, C4 (on the left hand's C4) goes
  });

  it('Hard keeps the sung pitch', () => {
    const hard = generateHard(base).filter((x) => x.role === 'melody');
    expect(hard.map((x) => x.midi)).toEqual(sung.map((x) => x.midi));
  });
});

describe('Easy rhythm: the sung line on 8th notes, Medium on 16ths', () => {
  const t = tempo(120, 20); // beat 0.5 s, 8th 0.25 s, 16th 0.125 s
  // a 16th-note run, then a long held note
  const run = [72, 74, 76, 77, 79, 77, 76, 74];
  const sung: Note[] = run.map((m, i) => n(m, i * 0.125, 0.12, 0.6 + (i % 2 ? 0 : 0.25), 'R', 'melody'));
  sung.push(n(72, 1.0, 1.3, 0.85, 'R', 'melody')); // held over five 8ths
  const acc = [n(48, 0, 2.5, 0.7, 'L')];
  const base = [...sung, ...acc];

  it('one note per 8th, on the 8th grid, the stronger note of each 8th wins', () => {
    const rh = generateEasy(base, t, 3).filter((x) => x.hand === 'R').sort((a, b) => a.start - b.start);
    expect(isMonophonic(rh)).toBe(true);
    for (const x of rh) expect(Math.abs(x.start / 0.25 - Math.round(x.start / 0.25))).toBeLessThan(1e-6);
    const runPart = rh.filter((x) => x.start < 1);
    expect(runPart).toHaveLength(4);
    expect(runPart.map((x) => x.midi)).toEqual([72, 76, 79, 76]); // the accented (on-8th) notes
  });

  it('a long note is held across 8ths (one note, ending on the grid), not re-struck', () => {
    const rh = generateEasy(base, t, 3).filter((x) => x.hand === 'R' && x.start >= 1);
    expect(rh).toHaveLength(1);
    expect(rh[0].midi).toBe(72);
    const end = rh[0].start + rh[0].dur;
    expect(Math.abs(end / 0.25 - Math.round(end / 0.25))).toBeLessThan(1e-6);
    expect(rh[0].dur).toBeGreaterThanOrEqual(1.2);
  });

  it('Medium keeps the 16ths', () => {
    const rh = generateMedium(base, t).filter((x) => x.role === 'melody' && x.start < 1);
    expect(rh.map((x) => x.midi)).toEqual(run);
  });

  it('easySungLine covers the notes a kept note replaced (legato)', () => {
    const line = easySungLine([n(60, 0, 0.1, 0.9, 'R', 'melody'), n(62, 0.1, 0.3, 0.5, 'R', 'melody')], t, 2);
    expect(line).toHaveLength(1);
    expect(line[0].midi).toBe(60);
    expect(line[0].dur).toBeGreaterThanOrEqual(0.4);
  });

  it('a slow, unreliable tempo estimate (likely half time) gets twice the grid', () => {
    expect(gridFactor({ ...tempo(65), confidence: 0.12 })).toBe(2);
    expect(gridFactor({ ...tempo(65), confidence: 0.9 })).toBe(1);
    expect(gridFactor({ ...tempo(120), confidence: 0.1 })).toBe(1);
    // at "60 BPM" (low confidence) a line of 0.5 s notes keeps every note on Easy
    const slow: TempoInfo = { ...tempo(60, 20), confidence: 0.2 };
    const line = [60, 62, 64, 65, 67, 65, 64, 62].map((m, i) => n(m + 12, i * 0.5, 0.45, 0.8, 'R', 'melody'));
    const rh = generateEasy([...line, n(48, 0, 4, 0.7, 'L')], slow, 5).filter((x) => x.hand === 'R');
    expect(rh).toHaveLength(8);
  });
});

describe('rap / speech-like sections', () => {
  /** sparse stream of short, weak syllables on two pitches */
  const rap = (t0: number, secs: number, vel = 0.65) => {
    const out: Note[] = [];
    for (let t = t0; t < t0 + secs; t += 0.3) out.push(n(out.length % 3 ? 60 : 62, t, 0.1, vel, 'R'));
    return out;
  };
  /** legato sung line */
  const sing = (t0: number, secs: number, pitches = [64, 65, 67, 69, 67, 65]) => {
    const out: Note[] = [];
    for (let i = 0; t0 + i * 0.5 < t0 + secs; i++) out.push(n(pitches[i % pitches.length], t0 + i * 0.5, 0.45, 0.85, 'R'));
    return out;
  };

  it('finds a rap verse between sung parts', () => {
    const line = [...sing(0, 8), ...rap(8, 10), ...sing(18, 8)];
    const sec = speechSections(line);
    expect(sec).toHaveLength(1);
    expect(sec[0][0]).toBeGreaterThan(7);
    expect(sec[0][0]).toBeLessThan(10);
    expect(sec[0][1]).toBeGreaterThan(16);
    expect(sec[0][1]).toBeLessThan(19.5);
  });

  it('does not take a sung monotone passage for speech', () => {
    expect(speechSections([...sing(0, 12, [60]), ...sing(12, 6)])).toEqual([]);
    // repeated syllables on one pitch, but sung (confident, filling the time)
    const chant: Note[] = [];
    for (let t = 0; t < 10; t += 0.25) chant.push(n(62, t, 0.22, 0.85, 'R'));
    expect(speechSections(chant)).toEqual([]);
  });

  it('keeps a harmonised chorus (weak, short line notes but a polyphonic vocal stem)', () => {
    const line = rap(0, 10);
    const stem = [...line, ...line.map((x) => n(x.midi - 4, x.start, x.dur + 0.1, 0.6, 'R')), ...line.map((x) => n(x.midi + 3, x.start, x.dur, 0.5, 'R'))];
    expect(speechSections(line, stem)).toEqual([]);
    expect(speechSections(line, line)).toHaveLength(1);
  });

  it('a short spoken interjection (< ~2 bars) stays in the line', () => {
    expect(speechSections([...sing(0, 8), ...rap(8, 2.5), ...sing(10.5, 8)])).toEqual([]);
  });

  it('extractMelody drops the rap verse and Easy plays the instruments’ tune there; Hard keeps the accompaniment', () => {
    const vocal = [...sing(0, 8), ...rap(8, 10), ...sing(18, 8)];
    const { line, speech } = extractMelody(vocal);
    expect(speech).toHaveLength(1);
    expect(line.some((x) => x.start > 9 && x.start < 16)).toBe(false);
    expect(line.filter((x) => x.start < 8).length).toBeGreaterThan(10);
    const t = tempo(120, 30);
    const acc: Note[] = [];
    for (let i = 0; i < 52; i++) acc.push(n(76 + (i % 4), i * 0.5, 0.45, 0.7, 'R'), n(48, i * 0.5, 0.45, 0.7, 'L'));
    const base = mergeMelody(acc, line, 26);
    const easy = generateEasy(base, t, 26).filter((x) => x.hand === 'R');
    const inRap = easy.filter((x) => x.start > 10 && x.start < 16);
    expect(inRap.length).toBeGreaterThanOrEqual(8);
    expect(inRap.every((x) => x.role !== 'melody' && x.midi >= 76)).toBe(true);
    expect(generateHard(base).filter((x) => x.start > 10 && x.start < 16 && x.midi >= 76).length).toBeGreaterThanOrEqual(10);
  });

  it('can be switched off', () => {
    const vocal = [...sing(0, 8), ...rap(8, 10), ...sing(18, 8)];
    const { line, speech } = extractMelody(vocal, { speech: null });
    expect(speech).toEqual([]);
    expect(line.some((x) => x.start > 9 && x.start < 16)).toBe(true);
  });
});

describe('isolated long holds', () => {
  it('drops a multi-second note with nothing sung around it, keeps held notes inside a phrase', () => {
    const line = [n(64, 0, 0.4), n(65, 0.5, 0.4), n(67, 1, 3.5), n(65, 4.6, 0.4), n(84, 8, 6.8), n(64, 17, 0.4)];
    const kept = dropIsolatedHolds(line);
    expect(kept.map((x) => x.midi)).toEqual([64, 65, 67, 65, 64]);
  });
});
