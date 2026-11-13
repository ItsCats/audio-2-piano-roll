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
 *   3. merge vibrato splits and fragments, drop leftovers too short to play and isolated
 *      multi-second holds (instrument bleed);
 *   4. fix isolated octave errors against the local register;
 *   5. drop rap / spoken sections (speechSections): there the arrangements play the instruments'
 *      tune like in an instrumental stretch;
 *   6. transpose the whole line by octaves only when it is implausibly low or high for a melody
 *      (median below A3 / above G5). Easy and Medium move it further into the right-hand register
 *      phrase by phrase (rightHandShifts); Hard keeps this pitch;
 *   7. mark the notes role 'melody', hand 'R'.
 *
 * mergeMelody() then combines the line with the accompaniment transcription: accompaniment
 * notes that would double-strike the melody (same key while it sounds, or a unison/octave
 * double of a melody onset) are removed, and the remaining notes get hands as usual.
 *
 * instrumentLine() runs the same reduction over the accompaniment's right hand for songs (or
 * stretches) without singing: the instruments' tune that Easy / Medium follow there.
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
  /** Extra cost per semitone of a leap beyond an octave (0 for sung lines; see TuneOptions). */
  leapCost?: number;
  /** Shortest melody note kept (seconds). */
  minDur: number;
  /** Target register of the line's median after transposition (MIDI, inclusive). */
  registerLow: number;
  registerHigh: number;
  /** Rap / speech detection (see speechSections); null disables it. */
  speech: SpeechOptions | null;
}

/**
 * Rap / speech-like singing. Measured on SCNet vocal stems of 5 songs against the CREPE
 * reference (tests/accuracy/melody_eval.py): in rap verses the stem's melody line is a sparse
 * stream of short, low-confidence notes (line covers < ~half the time, mean velocity < ~0.75 vs
 * 0.82–0.90 for singing) and the stem is monophonic. Choruses with stacked harmonies also give
 * low CREPE periodicity and weak notes but are clearly polyphonic (≥ 1.5 simultaneous vocal notes),
 * so polyphony keeps them; held / confident sung notes keep monotone sung passages.
 * The thresholds assume Basic Pitch vocal-stem notes (velocity from model confidence + loudness).
 * For a monophonic pitch-tracker source (CREPE notes, velocity = periodicity, unvoiced rap frames
 * already give no notes) pass `speech: null` or retune: polyphony is always 1 there.
 */
export interface SpeechOptions {
  /** analysis window half-width (s) */
  halfWindow: number;
  /** analysis hop (s) */
  hop: number;
  /** a window is speech-like when the line's mean velocity (duration-weighted) is below this, */
  maxVel: number;
  /** ...the line sounds for less than this fraction of the window, */
  maxCoverage: number;
  /** ...and the vocal stem's notes overlap less than this on average (1 = monophonic) */
  maxPolyphony: number;
  /** ...and its notes are short (median duration below this, s: syllables, not held notes) */
  maxNoteDur: number;
  /** windows with fewer line notes are not judged */
  minNotes: number;
  /** shortest speech section (s): about two bars, like an instrumental gap; shorter ones stay sung */
  minSection: number;
  /** speech-like stretches less than this apart (s) form one section */
  bridge: number;
}

export const DEFAULT_SPEECH: SpeechOptions = {
  halfWindow: 2,
  hop: 0.25,
  maxVel: 0.75,
  maxCoverage: 0.55,
  maxPolyphony: 1.5,
  maxNoteDur: 0.25,
  minNotes: 3,
  minSection: 4,
  bridge: 2,
};

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
  speech: DEFAULT_SPEECH,
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
  if (d > 12 && o.leapCost) c += o.leapCost * (d - 12);
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

/**
 * Move isolated notes that sit an octave away from the surrounding line back into it: a note at
 * least `minDist` semitones from the (duration-weighted) median of the notes within `radius` s
 * moves by an octave when that brings it closer.
 */
export function fixOctaveOutliers(line: Note[], radius = 3, minDist = 9): Note[] {
  const out = line.map((n) => ({ ...n }));
  for (let i = 0; i < out.length; i++) {
    const n = out[i];
    const ctx = line.filter((m, j) => j !== i && Math.abs(m.start - n.start) < radius);
    if (ctx.length < 3) continue;
    const ref = weightedMedian(ctx);
    if (n.midi - ref >= minDist && Math.abs(n.midi - 12 - ref) < n.midi - ref) n.midi -= 12;
    else if (ref - n.midi >= minDist && Math.abs(n.midi + 12 - ref) < ref - n.midi) n.midi += 12;
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

/**
 * Rap / speech-like sections of a vocal melody line (see SpeechOptions): time ranges [start, end)
 * where, in a window around each point, the line is sparse and low-confidence and the vocal stem
 * monophonic. `vocal` are the stem's notes before line reduction (for polyphony); without them
 * the stem counts as monophonic.
 */
export function speechSections(line: Note[], vocal: Note[] = line, opts: Partial<SpeechOptions> = {}): [number, number][] {
  const o = { ...DEFAULT_SPEECH, ...opts };
  if (line.length < o.minNotes) return [];
  const FPS = 50;
  let end = 0;
  for (const n of line) end = Math.max(end, n.start + n.dur);
  const nF = Math.ceil(end * FPS) + 1;
  // per frame: line coverage + velocity, vocal-stem polyphony; prefix sums for window means
  const cov = new Float64Array(nF + 1);
  const vel = new Float64Array(nF + 1);
  const poly = new Float64Array(nF);
  const frame = (t: number) => Math.max(0, Math.min(nF, Math.round(t * FPS)));
  for (const n of line) for (let f = frame(n.start); f < frame(n.start + n.dur); f++) {
    cov[f + 1] = 1;
    vel[f + 1] = n.vel;
  }
  for (const n of vocal) for (let f = frame(n.start); f < Math.min(nF, frame(n.start + n.dur)); f++) poly[f]++;
  const polySum = new Float64Array(nF + 1);
  const polyCnt = new Float64Array(nF + 1);
  for (let f = 0; f < nF; f++) {
    cov[f + 1] += cov[f];
    vel[f + 1] += vel[f];
    polySum[f + 1] = polySum[f] + poly[f];
    polyCnt[f + 1] = polyCnt[f] + (poly[f] > 0 ? 1 : 0);
  }
  const mids = line.map((n) => ({ t: n.start + n.dur / 2, dur: n.dur })).sort((a, b) => a.t - b.t);
  const dursIn = (a: number, b: number) => mids.filter((x) => x.t >= a && x.t < b).map((x) => x.dur);
  const runs: [number, number][] = [];
  let runStart = -1;
  const close = (t: number) => {
    if (runStart >= 0) {
      const last = runs[runs.length - 1];
      // a short break (a sung phrase end, a breath) inside a rap verse does not split it
      if (last && runStart - last[1] < o.bridge) last[1] = t;
      else runs.push([runStart, t]);
    }
    runStart = -1;
  };
  for (let c = line[0].start; c <= end; c += o.hop) {
    const f0 = frame(c - o.halfWindow);
    const f1 = frame(c + o.halfWindow);
    const len = Math.max(1, f1 - f0);
    const covered = cov[f1] - cov[f0];
    let speech = false;
    const durs = covered > 0 ? dursIn(c - o.halfWindow, c + o.halfWindow) : [];
    if (durs.length >= o.minNotes) {
      const meanVel = (vel[f1] - vel[f0]) / covered;
      const pc = Math.max(1, polyCnt[Math.min(nF, f1)] - polyCnt[f0]);
      const meanPoly = (polySum[Math.min(nF, f1)] - polySum[f0]) / pc;
      durs.sort((a, b) => a - b);
      const medDur = durs[Math.floor(durs.length / 2)];
      speech = meanVel < o.maxVel && covered / len < o.maxCoverage && meanPoly < o.maxPolyphony && medDur < o.maxNoteDur;
    }
    if (speech && runStart < 0) runStart = Math.max(0, c - o.hop / 2);
    if (!speech) close(c - o.hop / 2);
  }
  close(end);
  return runs.filter(([a, b]) => b - a >= o.minSection);
}

/**
 * Drops isolated very long notes: a note held longer than `maxHold` s with no other line note
 * within `isolation` s before or after it. On the vocal stems these are sustained instrument
 * bleed or reverb tails (a 6.8 s C6 in vocal-5 while nobody sings), not sung notes — every
 * such note in the 5 test songs (4 of them, 3–7 s) sat on unvoiced reference frames.
 */
export function dropIsolatedHolds(line: Note[], maxHold = 3, isolation = 1): Note[] {
  const s = [...line].sort((a, b) => a.start - b.start);
  return s.filter((n, i) => {
    if (n.dur <= maxHold) return true;
    const prev = s[i - 1];
    const next = s[i + 1];
    const near = (prev && n.start - (prev.start + prev.dur) < isolation) || (next && next.start - (n.start + n.dur) < isolation);
    return !!near;
  });
}

/** The line without the notes whose middle lies in one of the sections. */
export function dropSections(line: Note[], sections: [number, number][]): Note[] {
  if (!sections.length) return line;
  return line.filter((n) => {
    const mid = n.start + n.dur / 2;
    return !sections.some(([a, b]) => mid >= a && mid < b);
  });
}

export interface MelodyExtraction {
  /** the melody line (role 'melody', hand 'R') */
  line: Note[];
  /** rap / speech-like sections that were taken out of it */
  speech: [number, number][];
}

/** Full vocal-stem → melody line pipeline (see module comment), with the speech sections found. */
export function extractMelody(vocalNotes: Note[], opts: Partial<MelodyOptions> = {}): MelodyExtraction {
  const o = { ...DEFAULT_MELODY, ...opts };
  let line = reduceToLine(vocalNotes, o);
  line = smoothLine(line, o);
  line = fixOctaveOutliers(line);
  line = smoothLine(line, o); // octave fixes can create new same-pitch neighbours
  line = dropIsolatedHolds(line);
  const speech = o.speech ? speechSections(line, vocalNotes, o.speech) : [];
  line = dropSections(line, speech);
  const shift = registerShift(line, o.registerLow, o.registerHigh);
  return {
    line: line.map((n) => ({ ...n, id: newNoteId(), midi: Math.min(108, Math.max(21, n.midi + shift)), hand: 'R' as const, role: 'melody' as const })),
    speech,
  };
}

/** Full vocal-stem → melody line pipeline (see module comment). */
export function extractMelodyLine(vocalNotes: Note[], opts: Partial<MelodyOptions> = {}): Note[] {
  return extractMelody(vocalNotes, opts).line;
}

export interface RightHandRegister {
  /** target range of the line's (duration-weighted) median, MIDI inclusive: E4–E5 */
  low: number;
  high: number;
  /** a phrase's low notes stay at least this many semitones above the left hand around it */
  clearance: number;
  /** a silence this long (s) separates phrases */
  phraseGap: number;
  /** a phrase is never moved up so that its median goes above this (unless the left hand forces it) */
  maxMedian: number;
}

export const DEFAULT_RH_REGISTER: RightHandRegister = { low: 64, high: 76, clearance: 5, phraseGap: 1, maxMedian: 84 };

function weightedQuantile(items: { midi: number; w: number }[], q: number): number {
  const s = [...items].sort((a, b) => a.midi - b.midi);
  const total = s.reduce((acc, x) => acc + x.w, 0);
  let acc = 0;
  for (const x of s) {
    acc += x.w;
    if (acc >= total * q - 1e-9) return x.midi;
  }
  return s[s.length - 1]?.midi ?? 0;
}

/** Phrases of a (time-sorted) line: runs of notes separated by silences of at least `gap` s. */
export function phrases(line: Note[], gap: number): Note[][] {
  const out: Note[][] = [];
  let end = -Infinity;
  for (const n of [...line].sort((a, b) => a.start - b.start)) {
    if (!out.length || n.start - end >= gap) out.push([]);
    out[out.length - 1].push(n);
    end = Math.max(end, n.start + n.dur);
  }
  return out;
}

/**
 * Octave shift for every note of a melody line that puts it where a right hand plays a tune
 * (Easy / Medium): the whole line moves by octaves so its median lands in [low, high], then
 * each phrase moves up further while its low notes would sit less than `clearance` semitones
 * above the left-hand notes sounding during it. Whole phrases move together, so the line keeps
 * its shape. Returns a Map note → shift (multiples of 12).
 */
export function rightHandShifts(line: Note[], left: Note[], opts: Partial<RightHandRegister> = {}): Map<Note, number> {
  const o = { ...DEFAULT_RH_REGISTER, ...opts };
  const out = new Map<Note, number>();
  if (!line.length) return out;
  const med = weightedMedian(line);
  let global = 0;
  let best = Infinity;
  for (let k = -3; k <= 3; k++) {
    const m = med + 12 * k;
    if (m < o.low || m > o.high) continue;
    const cost = Math.abs(k) * 100 + Math.abs(m - (o.low + o.high) / 2);
    if (cost < best) [best, global] = [cost, 12 * k];
  }
  if (best === Infinity) global = med < o.low ? 12 * Math.ceil((o.low - med) / 12) : -12 * Math.ceil((med - o.high) / 12);
  const lh = [...left].sort((a, b) => a.start - b.start);
  for (const ph of phrases(line, o.phraseGap)) {
    const t0 = ph[0].start;
    const t1 = Math.max(...ph.map((n) => n.start + n.dur));
    const over: { midi: number; w: number }[] = [];
    for (const l of lh) {
      if (l.start >= t1) break;
      const w = Math.min(t1, l.start + l.dur) - Math.max(t0, l.start);
      if (w > 0) over.push({ midi: l.midi, w });
    }
    const pm = ph.map((n) => ({ midi: n.midi, w: Math.max(0.01, n.dur) }));
    const low = weightedQuantile(pm, 0.1);
    const phMed = weightedQuantile(pm, 0.5);
    let s = global;
    const lhTop = over.length ? weightedQuantile(over, 0.9) : -Infinity;
    if (over.length) {
      while (low + s - lhTop < o.clearance && phMed + s + 12 <= o.maxMedian) s += 12;
    }
    // the line-wide shift must not push an already high phrase (often instrument bleed in the
    // vocal stem) above maxMedian either: undo upward octaves while the left hand stays clear
    while (s > 0 && phMed + s > o.maxMedian && low + s - 12 - lhTop >= o.clearance) s -= 12;
    for (const n of ph) out.set(n, s);
  }
  return out;
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

/** An accompaniment note never carries the sung line's role (other roles are kept). */
function withoutRole(n: Note): Note {
  if (n.role !== 'melody') return n;
  const c = { ...n };
  delete c.role;
  return c;
}

/**
 * Accompaniment + melody line → one note list with hands; the melody always stays in the right hand.
 * Hard-only notes (role 'lead') go to the right hand and do not take part in the hand split, so the
 * notes Easy and Medium are built from get the same hands with or without them.
 */
export function mergeMelody(accomp: Note[], melody: Note[], duration: number): Note[] {
  const all = accomp.map(withoutRole);
  const hardOnly = all.filter((n) => n.role === 'lead').map((n) => ({ ...n, hand: 'R' as const }));
  const acc = hardOnly.length ? all.filter((n) => n.role !== 'lead') : all;
  let merged: Note[];
  if (!melody.length) merged = assignHands(sortNotes(acc), duration);
  else {
    merged = assignHands(sortNotes([...removeMelodyCollisions(acc, melody), ...melody]), duration);
    merged = merged.map((n) => (n.role === 'melody' ? { ...n, hand: 'R' as const } : n));
  }
  return hardOnly.length ? sortNotes([...merged, ...(melody.length ? removeMelodyCollisions(hardOnly, melody) : hardOnly)]) : merged;
}

/**
 * Instruments' tune: ONE smooth lead line through the accompaniment, for songs without a singer
 * and for the instrumental stretches / rap sections of songs with one (Easy and Medium right
 * hand follow it there, like they follow the sung line elsewhere).
 *
 * The same best-path reduction as the sung line (reduceToLine: credit = salience × sounding time,
 * per-note cost, pitch-jump costs with extra cost for octave / twelfth jumps), over the right
 * hand's notes plus left-hand notes high enough to belong to the tune. An instrument's salience
 * is its velocity plus a bonus for being the top voice at its onset (in piano writing the tune is
 * usually on top; more when it is also the loudest note struck with it), minus a penalty per
 * voice sounding above it (inner / accompanying voices). A note counts as the top voice only until
 * a higher one enters while it sounds: its credited length ends there, so a held pad or chord tone
 * on top at its own onset does not outweigh the melody entering above it.
 * Because jumps cost, the line no longer hops between a band's piano chord tops and the lead
 * instrument below them (the per-cluster skyline did: C5↔D6 on every chord in band-instrumental-1).
 * Same-pitch repeats are kept (instruments re-strike notes; sung lines are merged instead).
 */
export interface TuneOptions {
  /** salience bonus of a note with no tune candidate sounding above it at its onset */
  topBonus: number;
  /** extra bonus for a top voice that is also the loudest note struck with it (±40 ms) */
  loudTopBonus: number;
  /** salience penalty per candidate voice sounding above it (at most 3 counted) */
  belowPenalty: number;
  /** left-hand notes at or above this pitch are tune candidates too */
  leftMin: number;
  /** reduceToLine costs (see MelodyOptions) */
  minSalience: number;
  noteCost: number;
  jumpCost: number;
  octaveJumpCost: number;
  /** extra cost per semitone of a leap beyond an octave: a lead line rarely leaps that far, a
   * band's chord tops sit there (piano voicings an octave or more above the lead) */
  leapCost: number;
  /** move isolated octave errors back into the line (fixOctaveOutliers) */
  fixOctaves: boolean;
  /**
   * stem pitch cue (Note.tune, separated band songs): salience + cueBonus × (tune − cueCenter); a
   * note the lead stem's pitch track confirms gains, one it contradicts loses. Notes without the
   * cue are unchanged.
   */
  cueBonus: number;
  cueCenter: number;
}

/**
 * Tuned on onset-level, duration-independent measures (tests/accuracy/inst_eval.py onsetPC and
 * legatoRCA; 6 MAESTRO pieces, 4 solo piano recordings, band-instrumental-1; 200+ settings): the
 * landscape is flat (the best settings differ by < 0.01), a stronger penalty for voices above
 * (0.15 → 0.3) is the one consistent gain (MAESTRO Easy onsetPC +0.01).
 */
export const DEFAULT_TUNE: TuneOptions = {
  topBonus: 0.15,
  loudTopBonus: 0.15,
  belowPenalty: 0.3,
  leftMin: 67, // G4
  minSalience: 0.2,
  noteCost: 0.01,
  jumpCost: 0.0015,
  octaveJumpCost: 0.1,
  leapCost: 0.01,
  fixOctaves: false,
  cueBonus: 0.5,
  cueCenter: 0.3,
};

/** A higher candidate starting at least this long (s) after a sounding note, at least TOP_ENTRY_VEL × its velocity, ends that note's time as the top voice. */
const TOP_ENTRY_MIN = 0.1;
const TOP_ENTRY_VEL = 0.7;

/** Tune candidates (see instrumentLine): right-hand notes and left-hand notes >= leftMin. */
export function tuneCandidates(accomp: Note[], leftMin = DEFAULT_TUNE.leftMin): Note[] {
  const rh = accomp.filter((n) => n.hand === 'R' || n.midi >= leftMin);
  // only if the song has (almost) no right-hand part: the upper register of everything
  return rh.length > accomp.length * 0.1 ? rh : accomp.filter((n) => n.midi >= 57);
}

/** The instruments' tune through `candidates` (see TuneOptions); notes keep their velocity, hand 'R'. */
export function instrumentLine(candidates: Note[], opts: Partial<TuneOptions> = {}): Note[] {
  const o = { ...DEFAULT_TUNE, ...opts };
  const c = sortNotes(candidates);
  if (!c.length) return [];
  let maxDur = 0;
  for (const n of c) maxDur = Math.max(maxDur, n.dur);
  const byId = new Map<number, Note>();
  const weighted: Note[] = [];
  let j = 0;
  for (let i = 0; i < c.length; i++) {
    const n = c[i];
    const t = n.start + 0.02;
    while (j < c.length && c[j].start < t - maxDur) j++;
    const above = new Set<number>();
    let loudest = true;
    for (let k = j; k < c.length && c[k].start < n.start + 0.04; k++) {
      const m = c[k];
      if (m === n) continue;
      if (m.midi > n.midi && m.start + m.dur > t + 0.03) above.add(m.midi);
      if (Math.abs(m.start - n.start) <= 0.04 && m.vel > n.vel) loudest = false;
    }
    const cue = n.tune === undefined ? 0 : o.cueBonus * (n.tune - o.cueCenter);
    const sal = n.vel + cue + (above.size ? -o.belowPenalty * Math.min(3, above.size) : o.topBonus + (loudest ? o.loudTopBonus : 0));
    // a note is only the top voice until a higher voice enters while it sounds: its credit ends
    // there (else a held pad / chord tone that is on top at its own onset outweighs the melody
    // entering above it, and the line holds it and skips the tune)
    let dur = n.dur;
    for (let k = i + 1; k < c.length && c[k].start < n.start + dur; k++) {
      const m = c[k];
      if (m.midi > n.midi && m.start >= n.start + TOP_ENTRY_MIN && m.vel >= n.vel * TOP_ENTRY_VEL) {
        dur = m.start - n.start;
        break;
      }
    }
    byId.set(n.id, n);
    weighted.push({ ...n, vel: sal, dur });
  }
  let line = reduceToLine(weighted, {
    minMidi: 21,
    maxMidi: 108,
    minSalience: o.minSalience,
    noteCost: o.noteCost,
    jumpCost: o.jumpCost,
    octaveJumpCost: o.octaveJumpCost,
    leapCost: o.leapCost,
  });
  // original velocities and lengths back (a note still ends where the next line note starts)
  line = line.map((n, i) => {
    const src = byId.get(n.id);
    const next = line[i + 1];
    const dur = src ? Math.max(n.dur, next ? Math.min(src.dur, next.start - n.start - 0.005) : src.dur) : n.dur;
    return { ...n, vel: src?.vel ?? n.vel, dur, hand: 'R' as const };
  });
  if (o.fixOctaves) line = fixOctaveOutliers(line);
  return line;
}
