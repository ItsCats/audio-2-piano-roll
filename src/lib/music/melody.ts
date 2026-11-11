/**
 * Vocal melody line.
 *
 * Basic Pitch run on a separated vocal stem returns more than the sung line: harmonics and
 * octave doubles, backing vocals, vibrato split into neighbouring semitones, and bleed from the
 * accompaniment. This module reduces that to ONE playable right-hand line:
 *
 *   1. keep notes in a plausible singing range;
 *   2. monophonic reduction by dynamic programming over the notes (a Viterbi-like best path):
 *      each note earns its salience × the time it sounds, weak notes cost more than they add,
 *      and pitch jumps between close-by notes cost — octave/twelfth jumps a lot — so the path
 *      follows the most salient continuous line instead of flipping between octaves;
 *   3. merge vibrato splits and fragments, drop leftovers too short to play;
 *   4. fix isolated octave errors against the local register;
 *   5. transpose the whole line by octaves into a comfortable right-hand register
 *      (a male voice around G3 goes up to G4);
 *   6. mark the notes role 'melody', hand 'R'.
 *
 * mergeMelody() then combines the line with the accompaniment transcription: accompaniment
 * notes that would double-strike the melody (same key while it sounds, or a unison/octave
 * double of a melody onset) are removed, and the remaining notes get hands as usual.
 */
import type { Note } from './types';
import { newNoteId, sortNotes } from './cleanup';
import { assignHands } from './hands';

export interface MelodyOptions {
  /** Plausible sung range (MIDI). Notes outside it are ignored. */
  minMidi: number;
  maxMidi: number;
  /** Notes with a lower salience (velocity 0..1) cost more than they add to the line. */
  minSalience: number;
  /** Fixed cost per note (prefers sustained notes over a stream of fragments). */
  noteCost: number;
  /** Cost scale of pitch jumps between adjacent notes (per semitone). */
  jumpCost: number;
  /** Extra cost of an octave / twelfth / two-octave jump (typical harmonic errors). */
  octaveJumpCost: number;
  /** Shortest melody note kept (seconds). */
  minDur: number;
  /** Target register of the line's median after transposition (MIDI, inclusive). */
  registerLow: number;
  registerHigh: number;
}

export const DEFAULT_MELODY: MelodyOptions = {
  minMidi: 40, // E2
  maxMidi: 84, // C6
  minSalience: 0.4,
  noteCost: 0.01,
  jumpCost: 0.003,
  octaveJumpCost: 0.2,
  minDur: 0.07,
  registerLow: 57, // A3: a line centred on B♭3–C4 stays where it is (no octave flip at the boundary)
  registerHigh: 79, // G5
};

/** Octave doubles of the melody below this pitch are bass (left hand) and stay. */
const OCTAVE_DOUBLE_MIN = 55; // G3
const PHRASE_GAP = 0.5; // a silence this long starts a new phrase: no jump cost across it
const WINDOW_SEC = 3;
const WINDOW_NOTES = 48;

function salience(n: Note): number {
  return n.vel;
}

function jumpPenalty(a: Note, b: Note, o: MelodyOptions): number {
  const d = Math.abs(b.midi - a.midi);
  if (d === 0) return 0;
  const gap = Math.max(0, b.start - (a.start + a.dur));
  const near = Math.exp(-gap / 0.6);
  let c = o.jumpCost * d;
  if (d > 7) c += o.jumpCost * (d - 7); // big leaps are rare in sung lines
  if (d === 12 || d === 19 || d === 24) c += o.octaveJumpCost;
  return c * near;
}

/** Pick one note at a time: best-scoring path through the notes (see module comment). */
export function reduceToLine(notes: Note[], opts: Partial<MelodyOptions> = {}): Note[] {
  const o = { ...DEFAULT_MELODY, ...opts };
  const c = notes
    .filter((n) => n.midi >= o.minMidi && n.midi <= o.maxMidi && n.dur > 0)
    .sort((a, b) => a.start - b.start || b.vel - a.vel);
  const n = c.length;
  if (!n) return [];
  const own = (i: number, until: number) => (salience(c[i]) - o.minSalience) * Math.min(c[i].dur, until - c[i].start) - o.noteCost;
  const f = new Float64Array(n);
  const next = new Int32Array(n).fill(-1);
  const sufBest = new Float64Array(n + 1); // max(0, f[k]) for k >= index
  const sufArg = new Int32Array(n + 1).fill(-1);
  const starts = c.map((x) => x.start);
  const lowerBound = (t: number) => {
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (starts[m] < t) lo = m + 1;
      else hi = m;
    }
    return lo;
  };
  for (let i = n - 1; i >= 0; i--) {
    const a = c[i];
    const end = a.start + a.dur;
    // end the line here, or start a new phrase after a real silence
    let best = own(i, Infinity);
    let arg = -1;
    const after = lowerBound(end + PHRASE_GAP);
    if (sufArg[after] >= 0 && best + sufBest[after] > best) {
      best += sufBest[after];
      arg = sufArg[after];
    }
    // continue with a nearby note (this one is cut where the next begins)
    for (let k = i + 1, cnt = 0; k < n && cnt < WINDOW_NOTES && c[k].start - a.start < WINDOW_SEC; k++, cnt++) {
      if (c[k].start - a.start < 0.04) continue; // (near-)simultaneous: an alternative, not a successor
      const s = own(i, c[k].start) - jumpPenalty(a, c[k], o) + f[k];
      if (s > best) {
        best = s;
        arg = k;
      }
    }
    f[i] = best;
    next[i] = arg;
    if (best > sufBest[i + 1]) {
      sufBest[i] = best;
      sufArg[i] = i;
    } else {
      sufBest[i] = sufBest[i + 1];
      sufArg[i] = sufArg[i + 1];
    }
  }
  const out: Note[] = [];
  for (let i = sufArg[0]; i >= 0; i = next[i]) out.push({ ...c[i] });
  // cut overlaps
  for (let i = 0; i < out.length - 1; i++) {
    const gap = out[i + 1].start - out[i].start;
    if (out[i].dur > gap - 0.005) out[i].dur = Math.max(0.02, gap - 0.005);
  }
  return out;
}

/** Merge same-pitch fragments and vibrato splits (A, short neighbour, A), drop tiny leftovers. */
export function smoothLine(line: Note[], opts: Partial<MelodyOptions> = {}): Note[] {
  const o = { ...DEFAULT_MELODY, ...opts };
  let notes = line.map((n) => ({ ...n }));
  const absorb = (into: Note, n: Note) => {
    into.dur = Math.max(into.dur, n.start + n.dur - into.start);
    into.vel = Math.max(into.vel, n.vel);
  };
  // A, B(short, ±1–2 st), A  →  one long A
  for (let pass = 0; pass < 2; pass++) {
    const out: Note[] = [];
    for (let i = 0; i < notes.length; i++) {
      const prev = out[out.length - 1];
      const n = notes[i];
      const nx = notes[i + 1];
      if (
        prev &&
        nx &&
        n.dur < 0.15 &&
        nx.midi === prev.midi &&
        Math.abs(n.midi - prev.midi) <= 2 &&
        n.start - (prev.start + prev.dur) < 0.08 &&
        nx.start - (n.start + n.dur) < 0.08
      ) {
        absorb(prev, nx);
        i++;
        continue;
      }
      if (prev && prev.midi === n.midi && n.start - (prev.start + prev.dur) < 0.08) {
        absorb(prev, n);
        continue;
      }
      out.push(n);
    }
    notes = out;
  }
  // very short notes glued to a neighbour are glides/scoops into it
  const out: Note[] = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.dur < o.minDur) {
      const nx = notes[i + 1];
      if (nx && nx.start - (n.start + n.dur) < 0.05 && Math.abs(nx.midi - n.midi) <= 3) {
        nx.dur += nx.start - n.start;
        nx.start = n.start;
      }
      continue;
    }
    out.push(n);
  }
  return out;
}

function weightedMedian(notes: Note[]): number {
  if (!notes.length) return 0;
  const s = [...notes].sort((a, b) => a.midi - b.midi);
  const total = s.reduce((acc, n) => acc + n.dur, 0);
  let acc = 0;
  for (const n of s) {
    acc += n.dur;
    if (acc >= total / 2) return n.midi;
  }
  return s[s.length - 1].midi;
}

/** Move isolated notes that sit an octave away from the surrounding line back into it. */
export function fixOctaveOutliers(line: Note[], radius = 3): Note[] {
  const out = line.map((n) => ({ ...n }));
  for (let i = 0; i < out.length; i++) {
    const n = out[i];
    const ctx = line.filter((m, j) => j !== i && Math.abs(m.start - n.start) < radius);
    if (ctx.length < 3) continue;
    const ref = weightedMedian(ctx);
    if (n.midi - ref >= 9 && Math.abs(n.midi - 12 - ref) < n.midi - ref) n.midi -= 12;
    else if (ref - n.midi >= 9 && Math.abs(n.midi + 12 - ref) < ref - n.midi) n.midi += 12;
  }
  return out;
}

/** Octave shift (multiple of 12) that brings the line's median into the right-hand register. */
export function registerShift(line: Note[], low = DEFAULT_MELODY.registerLow, high = DEFAULT_MELODY.registerHigh): number {
  if (!line.length) return 0;
  const med = weightedMedian(line);
  let shift = 0;
  while (med + shift < low && shift < 24) shift += 12;
  while (med + shift > high && shift > -24) shift -= 12;
  return shift;
}

/** Full vocal-stem → melody line pipeline (see module comment). */
export function extractMelodyLine(vocalNotes: Note[], opts: Partial<MelodyOptions> = {}): Note[] {
  const o = { ...DEFAULT_MELODY, ...opts };
  let line = reduceToLine(vocalNotes, o);
  line = smoothLine(line, o);
  line = fixOctaveOutliers(line);
  line = smoothLine(line, o); // octave fixes can create new same-pitch neighbours
  const shift = registerShift(line, o.registerLow, o.registerHigh);
  return line.map((n) => ({ ...n, id: newNoteId(), midi: Math.min(108, Math.max(21, n.midi + shift)), hand: 'R' as const, role: 'melody' as const }));
}

/**
 * Remove accompaniment notes that collide with the melody: the same key while a melody note
 * sounds (cut short if it started clearly earlier, otherwise dropped) and unison / octave
 * doubles of a melody onset within `tol` seconds (octave doubles only above G3: lower ones are
 * the bass).
 */
export function removeMelodyCollisions(accomp: Note[], melody: Note[], tol = 0.06): Note[] {
  const mel = sortNotes(melody);
  const starts = mel.map((m) => m.start);
  const out: Note[] = [];
  for (const a0 of accomp) {
    const a = { ...a0 };
    let keep = true;
    // melody notes that could overlap a: start before a's end; scan back over a bounded window
    let hi = 0;
    while (hi < starts.length && starts[hi] < a.start + a.dur) hi++;
    for (let k = hi - 1; k >= 0; k--) {
      const m = mel[k];
      if (m.start + m.dur < a.start - 10) break;
      const overlaps = m.start < a.start + a.dur && a.start < m.start + m.dur;
      if (!overlaps) continue;
      const d = a.midi - m.midi;
      const together = Math.abs(a.start - m.start) <= tol;
      if (d === 0) {
        if (!together && a.start < m.start) {
          a.dur = m.start - a.start - 0.01;
          if (a.dur < 0.05) keep = false;
        } else keep = false;
      } else if (together && Math.abs(d) === 12 && a.midi >= OCTAVE_DOUBLE_MIN) keep = false;
      if (!keep) break;
    }
    if (keep) out.push(a);
  }
  return out;
}

function withoutRole(n: Note): Note {
  const c = { ...n };
  delete c.role;
  return c;
}

/** Accompaniment + melody line → one note list with hands; the melody always stays in the right hand. */
export function mergeMelody(accomp: Note[], melody: Note[], duration: number): Note[] {
  const acc = accomp.map(withoutRole);
  if (!melody.length) return assignHands(sortNotes(acc), duration);
  const all = assignHands(sortNotes([...removeMelodyCollisions(acc, melody), ...melody]), duration);
  return all.map((n) => (n.role === 'melody' ? { ...n, hand: 'R' as const } : n));
}
