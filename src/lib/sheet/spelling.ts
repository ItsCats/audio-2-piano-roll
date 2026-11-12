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

/**
 * Line-of-fifths positions that spell a pitch class with at most one sharp or flat (one or two;
 * every pitch class has one, so double sharps / flats are never needed).
 */
function candidates(pc: number): number[] {
  const out: number[] = [];
  for (let x = -8; x <= 12; x++) if ((((x * 7) % 12) + 12) % 12 === pc) out.push(x);
  return out;
}

const WHITE = new Set([0, 2, 4, 5, 7, 9, 11]);
/** Extra cost of E♯, B♯, F♭, C♭ when they are not in the key (a plain letter reads far easier). */
const AWKWARD = 4.5;

/** Cost of a spelling in a key: distance from the key's centre on the line of fifths. */
function lofCost(x: number, pc: number, fifths: number): number {
  const d = Math.abs(x - (fifths + 2));
  const alter = fromLof(x).alter;
  return d + (alter !== 0 && WHITE.has(pc) && d > 3 ? AWKWARD : 0);
}

function bestLof(pc: number, fifths: number, exclude?: number): number | undefined {
  let best: number | undefined;
  let bestC = Infinity;
  for (const x of candidates(pc)) {
    if (x === exclude) continue;
    const c = lofCost(x, pc, fifths);
    const better =
      best === undefined ||
      c < bestC - 1e-9 ||
      (Math.abs(c - bestC) < 1e-9 &&
        (Math.abs(fromLof(x).alter) < Math.abs(fromLof(best).alter) ||
          (Math.abs(fromLof(x).alter) === Math.abs(fromLof(best).alter) && (fifths >= 0 ? x > best : x < best))));
    if (better) {
      best = x;
      bestC = c;
    }
  }
  return best;
}

function lofOf(midi: number, fifths: number, minorTonic?: number): number {
  const pc = ((midi % 12) + 12) % 12;
  // minor keys: the raised 7th (leading tone) and raised 6th, unless that needs a double sharp
  if (minorTonic !== undefined && pc === (minorTonic + 11) % 12 && fifths + 8 <= 12) return fifths + 8;
  if (minorTonic !== undefined && pc === (minorTonic + 9) % 12 && fifths + 6 <= 12) return fifths + 6;
  return bestLof(pc, fifths)!;
}

function fromMidiLof(midi: number, lof: number): Spelled {
  const { step, alter } = fromLof(lof);
  const octave = Math.floor((midi - alter - STEP_PC[step]) / 12) - 1;
  return { step: STEPS[step], alter, octave };
}

/**
 * Spells a MIDI note in a key: the spelling nearest the key on the line of fifths, never with a
 * double sharp or flat, and E♯ / B♯ / F♭ / C♭ only when the key uses them. `minorTonic` (pitch
 * class) enables the leading-tone / raised-6th spelling.
 */
export function spell(midi: number, fifths: number, minorTonic?: number): Spelled {
  return fromMidiLof(midi, lofOf(midi, fifths, minorTonic));
}

/**
 * Spells the notes of a chord (ascending MIDI numbers). Like `spell`, but two notes never share a
 * letter in the same octave (F + F♯ is written F + G♭): one of them takes its other spelling.
 */
export function spellChord(midis: number[], fifths: number, minorTonic?: number): Spelled[] {
  const base = midis.map((m) => lofOf(m, fifths, minorTonic));
  const out = midis.map((m, i) => fromMidiLof(m, base[i]));
  const key = (s: Spelled) => s.octave * 7 + STEPS.indexOf(s.step);
  const clashes = (sp: Spelled[]) => {
    let n = 0;
    for (let i = 0; i < sp.length; i++) for (let j = i + 1; j < sp.length; j++) if (key(sp[i]) === key(sp[j]) && midis[i] !== midis[j]) n++;
    return n;
  };
  if (midis.length < 2 || midis.length > 10 || !clashes(out)) return out;
  // each note: its usual spelling, or its other single-accidental one at a cost; fewest clashes first
  const opts = midis.map((m, i) => {
    const pc = ((m % 12) + 12) % 12;
    const alt = bestLof(pc, fifths, base[i]);
    const o = [{ sp: out[i], cost: 0 }];
    if (alt !== undefined) o.push({ sp: fromMidiLof(m, alt), cost: 1 + Math.max(0, lofCost(alt, pc, fifths) - lofCost(base[i], pc, fifths)) });
    return o;
  });
  let best = out;
  let bestScore = clashes(out) * 1000;
  const cur: Spelled[] = new Array(midis.length);
  const walk = (i: number, cost: number) => {
    if (cost >= bestScore) return;
    if (i === midis.length) {
      const sc = clashes(cur) * 1000 + cost;
      if (sc < bestScore) {
        bestScore = sc;
        best = [...cur];
      }
      return;
    }
    for (const o of opts[i]) {
      cur[i] = o.sp;
      walk(i + 1, cost + o.cost);
    }
  };
  walk(0, 0);
  return best;
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
