/**
 * Pitch spelling for a key: key signature (fifths), letter names on the line of fifths, the
 * minor-key leading tone, and which notes need a printed accidental in a measure.
 */
import type { KeyInfo } from '../music/types';

export const STEPS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'] as const;
export type Step = (typeof STEPS)[number];
const STEP_PC = [0, 2, 4, 5, 7, 9, 11];
/** Step index for line-of-fifths positions F C G D A E B (−1..5). */
const LOF_STEP = [3, 0, 4, 1, 5, 2, 6];

/** Major-key tonic pitch class → fifths (F♯/G♭ is written with 6 flats, like theory.ts prefersFlats). */
const MAJOR_FIFTHS: Record<number, number> = { 0: 0, 7: 1, 2: 2, 9: 3, 4: 4, 11: 5, 6: -6, 1: -5, 8: -4, 3: -3, 10: -2, 5: -1 };

export function keyFifths(key?: Pick<KeyInfo, 'tonic' | 'mode'> | null): number {
  if (!key || !Number.isFinite(key.tonic)) return 0;
  const t = ((Math.round(key.tonic) % 12) + 12) % 12;
  return MAJOR_FIFTHS[key.mode === 'minor' ? (t + 3) % 12 : t];
}

export interface Spelled {
  step: Step;
  alter: number;
  octave: number;
}

function fromLof(lof: number): { step: number; alter: number } {
  const k = lof + 1; // F = 0
  return { step: LOF_STEP[((k % 7) + 7) % 7], alter: Math.floor(k / 7) };
}

/** Spells a MIDI note in a key. `minorTonic` (pitch class) enables the leading-tone / raised-6th spelling. */
export function spell(midi: number, fifths: number, minorTonic?: number): Spelled {
  const pc = ((midi % 12) + 12) % 12;
  let lof: number;
  if (minorTonic !== undefined && pc === (minorTonic + 11) % 12) lof = fifths + 3 + 5;
  else if (minorTonic !== undefined && pc === (minorTonic + 9) % 12) lof = fifths + 3 + 3;
  else {
    // the spelling on the line of fifths closest to the key's centre (fifths + 2)
    const centre = fifths + 2;
    let best = 0;
    let bestD = Infinity;
    for (let x = -15; x <= 19; x++) {
      if ((((x * 7) % 12) + 12) % 12 !== pc) continue;
      const d = Math.abs(x - centre);
      if (d < bestD || (d === bestD && (fifths >= 0 ? x > best : x < best))) {
        best = x;
        bestD = d;
      }
    }
    lof = best;
  }
  const { step, alter } = fromLof(lof);
  const octave = Math.floor((midi - alter - STEP_PC[step]) / 12) - 1;
  return { step: STEPS[step], alter, octave };
}

/** Alteration of a letter in the key signature. */
export function keyAlter(step: Step | number, fifths: number): number {
  const s = typeof step === 'number' ? step : STEPS.indexOf(step);
  const order = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B
  if (fifths > 0) return order.slice(0, fifths).includes(s) ? 1 : 0;
  if (fifths < 0) return order.slice(7 + fifths).includes(s) ? -1 : 0;
  return 0;
}

export const ACCIDENTAL_NAME: Record<number, string> = { [-2]: 'flat-flat', [-1]: 'flat', 0: 'natural', 1: 'sharp', 2: 'double-sharp' };

/**
 * Accidentals inside one measure of one staff: call `need` in time order. Tracks the alteration
 * per letter and octave against the key signature; tie continuations print nothing and don't
 * change the state. Create a new tracker for every measure.
 */
export class AccidentalTracker {
  private state = new Map<string, number>();
  constructor(private fifths: number) {}
  need(sp: Spelled, tieContinuation: boolean): string | null {
    if (tieContinuation) return null;
    const k = sp.step + sp.octave;
    const cur = this.state.has(k) ? this.state.get(k)! : keyAlter(sp.step, this.fifths);
    if (cur === sp.alter) return null;
    this.state.set(k, sp.alter);
    return ACCIDENTAL_NAME[sp.alter] ?? null;
  }
}

/** Diatonic number (C0 = 0, D0 = 1 …) of a spelled note, for staff positions. */
export const diatonic = (sp: Spelled) => sp.octave * 7 + STEPS.indexOf(sp.step);
