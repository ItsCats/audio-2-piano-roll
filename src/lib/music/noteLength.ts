/**
 * Note length of the high-accuracy piano model's notes: "as played" (a note ends when its key is let
 * go) and the sustain pedal heard in the recording, or "as heard" (a note lasts as long as it rings).
 *
 * The piano model (Kong et al. 2021, lib/pianoSpecialist) was trained on MAESTRO labels whose note
 * ends are extended by the sustain pedal, so its notes end where the SOUND stops: under the pedal a
 * whole harmony's notes stack up on the piano roll until the next pedal change, and the sheet and
 * practice mode show them as held. Under the pedal a key release makes no sound change, so the model
 * cannot hear it either; the key-up comes from rules, and the pedal is inferred from the note ends:
 *
 * 1. Key-up estimate: a note's key is let go at the next onset of the same hand (chord mates within
 *    35 ms do not count), at least 80 ms after its start, and never after its sound stops.
 * 2. Pedal-ups: where two or more notes (not re-strikes of the same key) stop sounding together
 *    (within 40 ms) and at least one of them sounds well past its key-up, the dampers fell: the
 *    pedal came up at the group's last end.
 * 3. A lone note sounding past its key-up (no pedal evidence) keeps its length: the finger held it.
 * 4. A note that sounds past a pedal-up had its key held through it: its key-up moves to that pedal-up.
 * 5. Before each pedal-up the pedal goes down 80 ms after the previous pedal-up (or at the first onset
 *    it carries), but not before a key the model heard stop without pedal (let go clearly before the
 *    hand's next onset, below the undamped top octave and a half) is released; notes it carries that
 *    were let go before it went down are held until just after.
 *
 * Played back with the piano engine's damper rules (`asHeard`), the as-played notes + pedal sound
 * like the model's notes (per-frame active-pitch F1 0.97 on the MAESTRO holdout, docs/TRANSCRIPTION.md
 * "Note length"). Onsets, pitches, velocities, hands and ids are never changed.
 */
import type { Hand, PedalRange } from './types';

/** The fields the note-length rules read. */
export interface LengthNote {
  start: number;
  dur: number;
  midi: number;
  hand: Hand;
}

export const AS_PLAYED = {
  /** onsets of the same hand this close together are one chord (they do not end each other) */
  chord: 0.035,
  /** shortest key-held length */
  minDur: 0.08,
  /** sound ends this close together stopped together (one pedal-up) */
  endTol: 0.04,
  /** a note sounds "past its key-up" when it rings this much longer */
  minExtra: 0.06,
  /** a sound end this close to the same key's next onset is a re-strike, not a damper */
  restrikeTol: 0.03,
  /** notes that must stop together for a pedal-up */
  kUp: 2,
  /** the pedal goes down at least this long after the previous pedal-up */
  downGap: 0.08,
  /** a note whose sound stops this much before the hand's next onset was let go without pedal */
  detach: 0.03,
  /** highest key with a damper that counts as let go without pedal (the top 1.5 octaves have none) */
  blockMaxMidi: 88,
  /** shortest pedal range kept */
  minPedal: 0.08,
  /** a carried key is held this long past the pedal going down */
  overlap: 0.02,
} as const;

export type AsPlayedOptions = { -readonly [K in keyof typeof AS_PLAYED]: number };

const round = (x: number) => Math.round(x * 1000) / 1000;

function lowerBound(arr: number[], x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The notes with new ends (others returned as they are, so ids and every other field are kept). */
function withEnds<T extends LengthNote>(notes: T[], ends: number[]): T[] {
  return notes.map((x, i) => (Math.abs(ends[i] - (x.start + x.dur)) < 1e-6 ? x : { ...x, dur: Math.max(0.01, round(ends[i] - x.start)) }));
}

/**
 * "As played": the notes (as the piano model hears them: they end where the sound stops) cut to
 * when their key is let go, and the sustain pedal that carries the rest of their sound. Needs the
 * hands (music/hands.ts assignHands). Pure, O(n log n) (plus the notes between two pedal changes).
 */
export function asPlayed<T extends LengthNote>(notes: T[], opts: Partial<AsPlayedOptions> = {}): { notes: T[]; pedal: PedalRange[] } {
  const r: AsPlayedOptions = { ...AS_PLAYED, ...opts };
  const n = notes.length;
  if (!n) return { notes: [], pedal: [] };
  const on = notes.map((x) => x.start);
  const s = notes.map((x) => x.start + x.dur);
  // the next onset of the same hand (chord mates excluded)
  const nx = new Array<number>(n).fill(Infinity);
  for (const h of ['L', 'R'] as const) {
    const idx = notes
      .map((x, i) => (x.hand === h ? i : -1))
      .filter((i) => i >= 0)
      .sort((a, b) => on[a] - on[b]);
    const o = idx.map((i) => on[i]);
    for (const i of idx) {
      const j = lowerBound(o, on[i] + r.chord);
      if (j < o.length) nx[i] = o[j];
    }
  }
  // 1. key-up estimates
  const a = notes.map((_, i) => Math.min(s[i], Math.max(on[i] + r.minDur, nx[i])));
  // re-strikes: the sound ends because the same key is struck again
  const nextSame = new Array<number>(n).fill(Infinity);
  const byPitch = notes.map((_, i) => i).sort((x, y) => notes[x].midi - notes[y].midi || on[x] - on[y]);
  for (let k = 0; k + 1 < byPitch.length; k++) {
    const x = byPitch[k];
    const y = byPitch[k + 1];
    if (notes[x].midi === notes[y].midi) nextSame[x] = on[y];
  }
  const restrike = s.map((e, i) => Math.abs(nextSame[i] - e) < r.restrikeTol);
  let carried = a.map((e, i) => s[i] > e + r.minExtra);
  // 2. pedal-ups: sound ends that cluster
  const atUp = new Array<boolean>(n).fill(false);
  const ups: number[] = [];
  const cand = notes
    .map((_, i) => i)
    .filter((i) => !restrike[i])
    .sort((x, y) => s[x] - s[y]);
  for (let k = 0; k < cand.length; ) {
    let m = k + 1;
    while (m < cand.length && s[cand[m]] - s[cand[m - 1]] < r.endTol) m++;
    const group = cand.slice(k, m);
    if (group.length >= r.kUp && group.some((i) => carried[i])) {
      let last = -Infinity;
      for (const i of group) {
        last = Math.max(last, s[i]);
        atUp[i] = true;
      }
      ups.push(last);
    }
    k = m;
  }
  ups.sort((x, y) => x - y);
  // 3. lone notes are held
  for (let i = 0; i < n; i++) if (carried[i] && !atUp[i] && !restrike[i]) a[i] = s[i];
  if (!ups.length) return { notes: withEnds(notes, a), pedal: [] };
  // 4. held through a pedal change
  for (let i = 0; i < n; i++) {
    if (!(s[i] > a[i] + r.minExtra)) continue;
    const j = lowerBound(ups, s[i] - r.endTol) - 1;
    if (j >= 0 && ups[j] > on[i] + 0.02 && ups[j] > a[i]) a[i] = Math.min(s[i], ups[j]);
  }
  carried = a.map((e, i) => s[i] > e + r.minExtra);
  // 5. pedal ranges
  const upOf = s.map((e) => lowerBound(ups, e - r.endTol));
  const blockers = notes
    .map((_, i) => i)
    .filter((i) => !carried[i] && !restrike[i] && !atUp[i] && s[i] < nx[i] - r.detach && notes[i].midi <= r.blockMaxMidi)
    .sort((x, y) => s[x] - s[y]);
  const bEnds = blockers.map((i) => s[i]);
  const needBy: number[][] = ups.map(() => []);
  for (let i = 0; i < n; i++) if (carried[i] && upOf[i] < ups.length) needBy[upOf[i]].push(i);
  const pedal: PedalRange[] = [];
  let prev = -Infinity;
  for (let k = 0; k < ups.length; k++) {
    const U = ups[k];
    const need = needBy[k];
    if (need.length) {
      let first = Infinity;
      for (const i of need) first = Math.min(first, on[i]);
      let D = Math.max(prev + r.downGap, first);
      // not before the last key let go without pedal in (D, U - endTol)
      let last = -Infinity;
      for (let b = lowerBound(bEnds, D); b < bEnds.length && bEnds[b] < U - r.endTol; b++) if (bEnds[b] > D) last = bEnds[b];
      if (last > -Infinity) D = Math.max(D, last + 0.01);
      // a carried key let go before the pedal went down was held until just after
      for (const i of need) if (a[i] < D + r.overlap) a[i] = Math.min(s[i], D + r.overlap);
      if (U - D >= r.minPedal) pedal.push({ start: Math.floor(D * 1000) / 1000, end: round(U) });
    }
    prev = U;
  }
  return { notes: withEnds(notes, a), pedal };
}

/**
 * "As heard": a key let go while the pedal is down sounds until the pedal comes up, or until the
 * same key is struck again (the piano engine's damper rules). The inverse of `asPlayed` for the
 * note-length switch: ends come back within 50 ms of the model's own for 93-98 % of notes.
 */
export function asHeard<T extends LengthNote>(notes: T[], pedal: PedalRange[]): T[] {
  // (overlapping ranges, e.g. edited by hand, are one pedal)
  const ped: PedalRange[] = [];
  for (const p of [...pedal].sort((x, y) => x.start - y.start)) {
    const last = ped[ped.length - 1];
    if (last && p.start <= last.end) last.end = Math.max(last.end, p.end);
    else ped.push({ start: p.start, end: p.end });
  }
  const starts = ped.map((p) => p.start);
  const ends = notes.map((x) => {
    const up = x.start + x.dur;
    // the pedal range holding the key-up: the last one starting at or before it
    const j = lowerBound(starts, up + 1e-9) - 1;
    return j >= 0 && ped[j].start <= up && up < ped[j].end ? ped[j].end : up;
  });
  const byPitch = notes.map((_, i) => i).sort((x, y) => notes[x].midi - notes[y].midi || notes[x].start - notes[y].start);
  for (let k = 0; k + 1 < byPitch.length; k++) {
    const x = byPitch[k];
    const y = byPitch[k + 1];
    if (notes[x].midi === notes[y].midi && ends[x] > notes[y].start) ends[x] = Math.max(notes[x].start + notes[x].dur, Math.min(ends[x], notes[y].start));
  }
  return notes.map((x, i) => (ends[i] === x.start + x.dur ? x : { ...x, dur: round(ends[i] - x.start) }));
}
