/**
 * Pitch on the staff for sheet editing: one diatonic step in the key, a staff position (y) to a
 * pitch (clef, octave mark, key signature, accidentals written earlier in the measure), labels.
 */
import { buckets } from './voiceItems';
import { diatonic, keyAlter, spell, spellChord, STEPS } from './spelling';
import type { ClefSign, Score, Staff } from './types';
import { keyAt } from './keys';

const STEP_PC = [0, 2, 4, 5, 7, 9, 11];

/** MIDI number of a diatonic number (C0 = 0) with an alteration. */
export function diatonicToMidi(dn: number, alter: number): number {
  const octave = Math.floor(dn / 7);
  const step = ((dn % 7) + 7) % 7;
  return (octave + 1) * 12 + STEP_PC[step] + alter;
}

/** One letter up (+1) or down (−1) in the key (the note's written letter, then the key's alteration). */
export function stepInKey(midi: number, dir: 1 | -1, fifths: number, minorTonic?: number): number {
  const dn = diatonic(spell(midi, fifths, minorTonic)) + dir;
  const out = diatonicToMidi(dn, keyAlter(((dn % 7) + 7) % 7, fifths));
  // a chromatic note stepping onto its own pitch class (E♯ → F in C) keeps moving
  return out === midi ? out + dir : out;
}

/** "F♯4"-style label of a pitch spelled in the key. */
export function pitchLabel(midi: number, fifths = 0, minorTonic?: number): string {
  const sp = spell(midi, fifths, minorTonic);
  return `${sp.step}${sp.alter > 0 ? '♯'.repeat(sp.alter) : sp.alter < 0 ? '♭'.repeat(-sp.alter) : ''}${sp.octave}`;
}

/** Diatonic number of a clef's top staff line: G clef F5, F clef A3. */
export const TOP_LINE: Record<ClefSign, number> = { G: 38, F: 26 };

/** Diatonic number at a y on a staff (half a line gap per step from the top line). */
export function diatonicAtY(y: number, staffTop: number, gap: number, clef: ClefSign, ottava: 0 | 8 | -8 = 0): number {
  const steps = Math.round((staffTop - y) / (gap / 2));
  return TOP_LINE[clef] + steps + (ottava === 8 ? 7 : ottava === -8 ? -7 : 0);
}

/** y of a diatonic number on a staff (the inverse of diatonicAtY). */
export function yOfDiatonic(dn: number, staffTop: number, gap: number, clef: ClefSign, ottava: 0 | 8 | -8 = 0): number {
  const steps = dn - TOP_LINE[clef] - (ottava === 8 ? 7 : ottava === -8 ? -7 : 0);
  return staffTop - steps * (gap / 2);
}

/**
 * The alteration a new note at (staff, measure, pos) on letter `dn` gets: the accidental written
 * earlier in that measure on that staff for the same letter and octave, else the key signature.
 */
export function alterAt(score: Score, staff: Staff, m: number, pos: number, dn: number): number {
  const bk = buckets(score);
  const k = keyAt(score, m);
  let best: { pos: number; alter: number } | null = null;
  for (const v of [0, 1])
    for (const c of bk[staff - 1][v][m] ?? []) {
      const on = Math.max(c.on, score.time.measureStart(m));
      if (on >= pos) continue;
      spellChord(c.midis, keyAt(score, score.time.measureOf(c.on)).fifths, keyAt(score, score.time.measureOf(c.on)).minorTonic).forEach((sp) => {
        if (diatonic(sp) === dn && (!best || on >= best.pos)) best = { pos: on, alter: sp.alter };
      });
    }
  return best ? (best as { alter: number }).alter : keyAlter(((dn % 7) + 7) % 7, k.fifths);
}

/** Octave mark in force on a staff at a position. */
export function ottavaAt(score: Score, staff: Staff, pos: number): 0 | 8 | -8 {
  for (const o of score.ottavas) if (o.staff === staff && pos >= o.start && pos < o.stop) return o.shift;
  return 0;
}

export { STEPS };
