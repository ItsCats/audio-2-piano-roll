/**
 * Hand-span (reach) pass: no hand is asked to hold or strike notes further apart than it can reach.
 *
 * Checked at every onset moment against everything that hand has SOUNDING then (notes struck
 * together plus notes still held from before), not only against the notes struck together: in
 * the transcriptions most over-stretched moments were a held note plus a new note more than an
 * octave away (band-instrumental-1, Hard: 29 % of left-hand onsets spanned more than an octave,
 * more than 4 in 5 of those because of a held note).
 *
 * Per moment and hand, while the span is too wide, the cheapest fix at either end of the hand:
 *  1. a note that is still held only through a short legato overlap (≤ SHORT_OVERLAP) is released
 *     just before the new onset (inaudible; not on Hard unless asked: Hard keeps the notes as
 *     transcribed and only reassigns);
 *  2. the note at the end facing the other hand (the left hand's top, the right hand's bottom)
 *     is moved to the other hand, if that hand stays within its own reach and finger count over
 *     the moved note's whole length, the note does not become that hand's outer voice (above the
 *     right hand's top note / below the left hand's bass) and the hands do not cross by more
 *     than a whole tone;
 *  3. Easy / Medium only: a longer held note is released at the new onset (a pianist lets go of
 *     it, the new note matters more than the tail of the old one); a held bass too, when the note
 *     at the other end of the hand is struck at this moment (the next note of a left-hand
 *     arpeggio over a held low note: the new note stays, the bass's tail goes; the pedal keeps it
 *     sounding anyway);
 *  4. Easy / Medium only: the least important outer note is dropped (inner voices, octave or
 *     unison doubles, short and quiet notes go first).
 * Melody notes (role 'melody': the sung line) always stay in the right hand and are never
 * released early or dropped; the lowest note the left hand holds (the bass) is never dropped,
 * only released early as in 3. A moment that still cannot be fixed (Hard, or only protected notes
 * left) is left as it is and counted.
 *
 * Reach per level: Easy 7 semitones (a fifth: a beginner's five-finger position), Medium 12 (an
 * octave: any adult hand), Hard 14 (a major ninth: most adult hands; tenths need large hands and
 * are usually rolled). Those are also the default `maxSpan`s.
 *
 * Measured (offline regeneration from saved base transcriptions: band-instrumental-1, 4 vocal songs,
 * 4 solo piano recordings, 6 MAESTRO pieces), left-hand / right-hand onsets spanning more than an
 * octave, before → after:
 *   Medium  every piece → 0 / 0 % (e.g. band-instrumental-1 8.5/2.3, piano-solo-2 15.8/6.7,
 *           MAESTRO Ballade 13.0/4.8); notes dropped 0–1.1 % (0.2 % typical), melody notes
 *           never. Dropped notes that are the lowest left-hand note struck at their onset (a new
 *           note over a held bass): before the bass could be released, 34 of 45 drops on the
 *           MAESTRO Ballade, 38 of 45 on piano-solo-2, 12 of 15 on piano-solo-3; now
 *           6 of 7, 2 of 4, 1 of 1. Medium LH bottom line vs the bass stem (raw chroma) about
 *           unchanged (vocal songs + band-instrumental-1 + piano-solo-1, solo piano, mean 0.628 → 0.626; releasing
 *           every held bass at once cost 0.619).
 *   Hard    band-instrumental-1 22.9/16.0 → 18.7/14.5, vocal-1 19.1/16.4 → 14.2/15.2, MAESTRO Ballade
 *           16.9/21.7 → 12.7/10.9, Mozart K280 7.9/10.1 → 3.0/3.7; no note dropped or shortened
 *           (what is left is mostly held notes a pianist would release under the pedal, and band
 *           chords too wide for both hands). Scores whose hands come from the file are not
 *           touched on Hard (difficulty.ts ArrangementOptions.handsFromScore).
 * Easy is one line per hand and does not use this pass.
 */
import type { Note } from './types';

export type PlayabilityLevel = 'easy' | 'medium' | 'hard';

export const MAX_SPAN: Record<PlayabilityLevel, number> = { easy: 7, medium: 12, hard: 14 };

/** Notes starting within this of a moment's first note are struck together (one moment). */
const TOL = 0.035;
/** A note counts as still sounding at a moment if it ends more than this after it. */
const EPS = 0.02;
/** A held note ending at most this long after a new onset only overlaps it legato. */
export const SHORT_OVERLAP = 0.12;
/** Released notes keep at least this length (else releasing counts as dropping). */
const MIN_DUR = 0.05;
/** How far the hands may cross after a reassignment (semitones). */
const CROSS = 2;

export interface PlayabilityOptions {
  /** Widest span one hand may hold at a moment, semitones (default: per level, MAX_SPAN). */
  maxSpan: number;
  /** Release notes held only by a short legato overlap. */
  trimShort: boolean;
  /** Release longer held notes at the new onset. */
  trimLong: boolean;
  /** Drop the least important outer notes. */
  drop: boolean;
  /** Most notes one hand may strike together after a reassignment. */
  maxStruck: number;
  /** Most notes one hand may hold at once after a reassignment. */
  maxSounding: number;
  /**
   * A held lowest left-hand note (the bass) may be released at a new left-hand onset once it has
   * sounded this long (s); Infinity: only when the note at the other end of the hand is struck at
   * that onset (with trimLong).
   */
  bassReleaseAfter: number;
}

export const LEVEL_OPTIONS: Record<PlayabilityLevel, PlayabilityOptions> = {
  // Easy: one line per hand (a reassigned note must not make a hand play two at once)
  easy: { maxSpan: MAX_SPAN.easy, trimShort: true, trimLong: true, drop: true, maxStruck: 1, maxSounding: 1, bassReleaseAfter: Infinity },
  // Medium: at most three notes per hand struck together (tune + two chord tones / bass + tones)
  medium: { maxSpan: MAX_SPAN.medium, trimShort: true, trimLong: true, drop: true, maxStruck: 3, maxSounding: 4, bassReleaseAfter: Infinity },
  // Hard: every note kept as transcribed, only hands change
  hard: { maxSpan: MAX_SPAN.hard, trimShort: false, trimLong: false, drop: false, maxStruck: 5, maxSounding: 5, bassReleaseAfter: Infinity },
};

export interface PlayabilityReport {
  /** hand moments checked (a hand striking at least one note) */
  checked: number;
  /** of those, wider than maxSpan before the pass */
  overBefore: number;
  /** left wider than maxSpan (nothing allowed could fix them) */
  unresolved: number;
  moved: number;
  trimmed: number;
  dropped: number;
  /** dropped notes per hand */
  droppedL: number;
  droppedR: number;
}

interface Work {
  n: Note;
  end: number;
  k: number; // moment index
  dropped: boolean;
}

/**
 * Keeps every hand within reach (see the module comment). Returns new notes in time order;
 * the input is not modified.
 */
export function enforcePlayability(notes: Note[], level: PlayabilityLevel, opts?: { maxSpan?: number }): Note[] {
  return playabilityPass(notes, { ...LEVEL_OPTIONS[level], ...(opts?.maxSpan != null ? { maxSpan: opts.maxSpan } : {}) }).notes;
}

/** enforcePlayability with explicit options and a report of what it did. */
export function playabilityPass(notes: Note[], options: Partial<PlayabilityOptions> = {}): { notes: Note[]; report: PlayabilityReport } {
  const o: PlayabilityOptions = { ...LEVEL_OPTIONS.hard, ...options };
  const report: PlayabilityReport = { checked: 0, overBefore: 0, unresolved: 0, moved: 0, trimmed: 0, dropped: 0, droppedL: 0, droppedR: 0 };
  const w: Work[] = [...notes]
    .sort((a, b) => a.start - b.start || a.midi - b.midi)
    .map((n) => {
      const c: Note = { ...n };
      if (c.role === 'melody') c.hand = 'R';
      return { n: c, end: c.start + c.dur, k: 0, dropped: false };
    });
  if (w.length < 2) return { notes: w.map((x) => x.n), report };

  // moments: onset clusters, anchored at (and timed by) their first note: a note counts as
  // sounding at a moment when it lasts past that first onset
  const time: number[] = [];
  const members: Work[][] = [];
  for (const x of w) {
    const k = members.length - 1;
    if (k >= 0 && x.n.start - time[k] <= TOL) {
      members[k].push(x);
      x.k = k;
    } else {
      time.push(x.n.start);
      members.push([x]);
      x.k = k + 1;
    }
  }
  const K = members.length;
  // notes that may sound at each moment (ends only shrink, so filtering later is enough)
  const active: Work[][] = [];
  let live: Work[] = [];
  for (let k = 0; k < K; k++) {
    live = live.concat(members[k]).filter((x) => x.end > time[k] + EPS);
    active.push(live);
  }

  const sounding = (h: Note['hand'], k: number, except?: Work): Work[] =>
    active[k].filter((x) => x !== except && !x.dropped && x.n.hand === h && x.end > time[k] + EPS);
  const spanOf = (xs: Work[]) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const x of xs) {
      lo = Math.min(lo, x.n.midi);
      hi = Math.max(hi, x.n.midi);
    }
    return xs.length ? hi - lo : 0;
  };

  /** Can x move to hand h2 for its whole length? */
  const canMove = (x: Work, h2: Note['hand']): boolean => {
    if (x.n.role === 'melody' && h2 === 'L') return false;
    const h = x.n.hand;
    for (let k = x.k; k < K && time[k] + EPS < x.end; k++) {
      const there = sounding(h2, k, x);
      if (there.length + 1 > o.maxSounding) return false;
      if (k === x.k && there.filter((y) => y.k === k).length + 1 > o.maxStruck) return false;
      let lo = x.n.midi;
      let hi = x.n.midi;
      for (const y of there) {
        lo = Math.min(lo, y.n.midi);
        hi = Math.max(hi, y.n.midi);
      }
      if (hi - lo > o.maxSpan) return false;
      // it may not become the other hand's outer voice (above the right hand's tune / below the
      // left hand's bass)
      if (there.length && (h2 === 'R' ? hi === x.n.midi && there.every((y) => y.n.midi < x.n.midi) : lo === x.n.midi && there.every((y) => y.n.midi > x.n.midi))) return false;
      // the hands may not cross by more than CROSS semitones
      for (const y of sounding(h, k, x)) {
        if (h2 === 'R' && y.n.midi - x.n.midi > CROSS) return false;
        if (h2 === 'L' && x.n.midi - y.n.midi > CROSS) return false;
      }
    }
    return true;
  };

  const importance = (x: Work, k: number, outer: boolean): number => {
    let doubled = false;
    for (const y of active[k]) {
      if (y !== x && !y.dropped && y.end > time[k] + EPS && y.n.midi % 12 === x.n.midi % 12) {
        doubled = true;
        break;
      }
    }
    return x.n.vel + 0.5 * Math.min(x.end - x.n.start, 1) + (doubled ? -0.6 : 0) + (outer ? 0.8 : 0);
  };

  type Option = { cost: number; apply: () => void };

  const optionsFor = (x: Work, side: 'top' | 'bottom', h: Note['hand'], k: number, otherEnd: Work): Option[] => {
    const out: Option[] = [];
    const other: Note['hand'] = h === 'L' ? 'R' : 'L';
    const melody = x.n.role === 'melody';
    const bass = h === 'L' && side === 'bottom';
    const held = x.k < k;
    const keptDur = time[k] - 0.005 - x.n.start;
    const overlap = x.end - time[k];
    if (held && !melody && keptDur >= MIN_DUR && o.trimShort && overlap <= SHORT_OVERLAP) {
      out.push({ cost: 0.05, apply: () => trim(x, keptDur) });
    }
    // only the note on the side facing the other hand changes hands (the left hand's top, the
    // right hand's bottom): the bass and the top voice stay where they are
    const inner = (h === 'L' && side === 'top') || (h === 'R' && side === 'bottom');
    if (inner && canMove(x, other)) {
      out.push({
        cost: 0.1 + (held ? 0.05 : 0),
        apply: () => {
          x.n.hand = other;
          report.moved++;
        },
      });
    }
    // the outer voices (the tune on top of the right hand, the bass) are cut short last
    const top = h === 'R' && side === 'top';
    // a held bass is let go when the note at the other end is struck right now (a new left-hand
    // note, e.g. the next note of an arpeggio), unless much of it is still to come: then a weak
    // or doubled new note goes instead (cost: 1.5 + the bass's remaining seconds, at most 2)
    if (held && !melody && keptDur >= MIN_DUR && o.trimLong && (!bass || keptDur >= o.bassReleaseAfter || otherEnd.k === k)) {
      const rest = bass ? Math.min(overlap, 2) : 0.5 * (overlap / (x.end - x.n.start));
      out.push({ cost: (top ? 3.5 : bass ? 1.5 : 1) + rest, apply: () => trim(x, keptDur) });
    }
    if (!melody && !bass && o.drop) {
      out.push({
        cost: 2 + importance(x, k, top),
        apply: () => {
          x.dropped = true;
          report.dropped++;
          if (h === 'L') report.droppedL++;
          else report.droppedR++;
        },
      });
    }
    return out;
  };

  const trim = (x: Work, dur: number) => {
    x.n.dur = dur;
    x.end = x.n.start + dur;
    report.trimmed++;
  };

  const resolve = (h: Note['hand'], k: number) => {
    let S = sounding(h, k);
    report.checked++;
    if (spanOf(S) <= o.maxSpan) return;
    report.overBefore++;
    for (let iter = 0; iter < 16 && spanOf(S) > o.maxSpan; iter++) {
      // the outer note at each end (of equal pitches, the least important one)
      let top = S[0];
      let bottom = S[0];
      for (const x of S) {
        if (x.n.midi > top.n.midi || (x.n.midi === top.n.midi && x.n.vel < top.n.vel)) top = x;
        if (x.n.midi < bottom.n.midi || (x.n.midi === bottom.n.midi && x.n.vel < bottom.n.vel)) bottom = x;
      }
      const opts = [...optionsFor(top, 'top', h, k, bottom), ...optionsFor(bottom, 'bottom', h, k, top)];
      if (!opts.length) {
        report.unresolved++;
        return;
      }
      opts.reduce((a, b) => (b.cost < a.cost ? b : a)).apply();
      S = sounding(h, k);
    }
    if (spanOf(S) > o.maxSpan) report.unresolved++;
  };

  for (let k = 0; k < K; k++) {
    for (const h of ['L', 'R'] as const) {
      if (members[k].some((x) => !x.dropped && x.n.hand === h)) resolve(h, k);
    }
  }
  return { notes: w.filter((x) => !x.dropped).map((x) => x.n), report };
}

/**
 * Measurement helper: per hand, the share of onsets at which that hand holds notes spanning more
 * than `limit` semitones (everything sounding at the onset, as enforcePlayability sees it).
 */
export function spanStats(notes: Note[], limit = 12): Record<Note['hand'], { onsets: number; over: number; maxSpan: number }> {
  const out = { L: { onsets: 0, over: 0, maxSpan: 0 }, R: { onsets: 0, over: 0, maxSpan: 0 } };
  for (const h of ['L', 'R'] as const) {
    const hn = notes.filter((n) => n.hand === h).sort((a, b) => a.start - b.start);
    let j = 0;
    let maxDur = 0;
    for (const n of hn) maxDur = Math.max(maxDur, n.dur);
    for (let i = 0; i < hn.length; i++) {
      const t = hn[i].start;
      while (j < hn.length && hn[j].start < t - maxDur) j++;
      let lo = Infinity;
      let hi = -Infinity;
      for (let q = j; q < hn.length && hn[q].start <= t + 0.01; q++) {
        const x = hn[q];
        if (x.start + x.dur > t + EPS) {
          lo = Math.min(lo, x.midi);
          hi = Math.max(hi, x.midi);
        }
      }
      if (hi < lo) continue;
      out[h].onsets++;
      if (hi - lo > limit) out[h].over++;
      out[h].maxSpan = Math.max(out[h].maxSpan, hi - lo);
    }
  }
  return out;
}
