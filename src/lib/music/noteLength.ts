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
 *    35 ms do not count), at least 80 ms after its start, and never after its sound stops. A melody
 *    note (the top of the right hand) played clearly louder than the notes under it is held until the
 *    next note at or above it.
 * 2. Pedal-ups: where notes (not re-strikes of the same key, not notes the model closed at its 6 s
 *    limit) stop sounding together (within 40 ms) and at least two of them sound well past their
 *    key-up, the dampers fell: the pedal came up at the group's last end. (One such note is a key the
 *    hand held, released with the others: a cadence, a chord let go.)
 * 3. A lone note sounding past its key-up (no pedal evidence) keeps its length: the finger held it.
 *    A note ringing on past a pedal-up had its key down through it (when that is at most 1.5 s more).
 * 4. Before each pedal-up the pedal goes down where the least sound is wrong: after the previous
 *    pedal-up (+80 ms) and the first onset it carries, but later if keys the model heard stop inside
 *    (they would ring on under the pedal) weigh more than holding the carried keys longer. A carried
 *    key let go before the pedal went down is held until just after (at most 1.5 s longer).
 * 5. A lone note that rings inside a pedal range was carried by the pedal, not held: cut to its key-up
 *    (a note the model closed at its 6 s limit: when a pedal is down after its key-up).
 *
 * Played back with the piano engine's damper rules (`asHeard`), the as-played notes + pedal sound
 * like the model's notes (per-frame active-pitch F1 0.98 on 15 MAESTRO pieces, docs/TRANSCRIPTION.md
 * "Note length"). Onsets, pitches, velocities, hands and ids are never changed.
 */
import type { Hand, PedalRange } from './types';

/** The fields the note-length rules read. */
export interface LengthNote {
  start: number;
  dur: number;
  midi: number;
  hand: Hand;
  /** loudness 0..1 (without it a melody note is not told from the notes under it) */
  vel?: number;
}

export const AS_PLAYED = {
  /** onsets of the same hand this close together are one chord (they do not end each other) */
  chord: 0.035,
  /** shortest key-held length */
  minDur: 0.08,
  /** a right-hand top note this much louder than every note under it (at least voiceGap semitones lower) is a held melody note */
  voiceVel: 0.1,
  voiceGap: 3,
  /** sound ends this close together stopped together (one pedal-up) */
  endTol: 0.04,
  /** a note sounds "past its key-up" when it rings this much longer */
  minExtra: 0.06,
  /** a sound end this close to the same key's next onset is a re-strike, not a damper */
  restrikeTol: 0.03,
  /** notes that must stop together for a pedal-up */
  kUp: 2,
  /** of which at least this many sound past their key-up */
  kCarried: 2,
  /** the model closes a note it hears no end for after this long (postprocess.ts MAX_NOTE_FRAMES) */
  capDur: 6,
  capTol: 0.006,
  /** the pedal goes down at least this long after the previous pedal-up */
  downGap: 0.08,
  /** a note whose sound stops this much before the hand's next onset was let go cleanly (full weight) */
  detach: 0.03,
  /** weight of a legato note's wrong ringing (against a detached note's 1) when placing the pedal-down */
  ringLegato: 0.5,
  /** weight of each second a carried key must be held longer, when placing the pedal-down */
  holdCost: 1,
  /** a carried key is held at most this much longer to reach the pedal (else it is damped there) */
  holdMax: 1.5,
  /** a note ringing past a pedal-up had its key down through it, if that is at most this much longer */
  throughMax: 1.5,
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

/** Melody hold (rule 1): the next onset at or above right-hand top note i, if every note before it is clearly under and quieter; else null. */
function melodyEnd<T extends LengthNote>(notes: T[], idx: number[], o: number[], i: number, j: number, s: number, r: AsPlayedOptions): number | null {
  const x = notes[i];
  if (x.vel === undefined || x.hand !== 'R') return null;
  for (let c = lowerBound(o, x.start - r.chord); c < o.length && o[c] < x.start + r.chord; c++) if (notes[idx[c]].midi > x.midi) return null;
  let c = j;
  for (; c < o.length && o[c] < s && c < j + 64; c++) {
    const q = notes[idx[c]];
    if (q.midi > x.midi - r.voiceGap) break;
    if ((q.vel ?? 1) > x.vel - r.voiceVel) return null;
  }
  if (c === j || c >= j + 64) return null;
  if (c === o.length || o[c] >= s) return Infinity;
  return notes[idx[c]].midi >= x.midi ? o[c] : null;
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
  // the next onset of the same hand (chord mates excluded), or the next melody note
  const nx = new Array<number>(n).fill(Infinity);
  for (const h of ['L', 'R'] as const) {
    const idx = notes
      .map((x, i) => (x.hand === h ? i : -1))
      .filter((i) => i >= 0)
      .sort((a, b) => on[a] - on[b]);
    const o = idx.map((i) => on[i]);
    for (const i of idx) {
      const j = lowerBound(o, on[i] + r.chord);
      if (j === o.length) continue;
      nx[i] = o[j];
      if (r.voiceVel > 0 && h === 'R' && o[j] < s[i]) {
        const m = melodyEnd(notes, idx, o, i, j, s[i], r);
        if (m !== null) nx[i] = m;
      }
    }
  }
  // 1. key-up estimates
  const a = notes.map((_, i) => Math.min(s[i], Math.max(on[i] + r.minDur, nx[i])));
  const a1 = a.slice();
  // re-strikes: the sound ends because the same key is struck again
  const nextSame = new Array<number>(n).fill(Infinity);
  const byPitch = notes.map((_, i) => i).sort((x, y) => notes[x].midi - notes[y].midi || on[x] - on[y]);
  for (let k = 0; k + 1 < byPitch.length; k++) {
    const x = byPitch[k];
    const y = byPitch[k + 1];
    if (notes[x].midi === notes[y].midi) nextSame[x] = on[y];
  }
  const restrike = s.map((e, i) => Math.abs(nextSame[i] - e) < r.restrikeTol);
  // notes the model closed at its length limit: their end is not a sound end
  const capped = notes.map((x) => Math.abs(x.dur - r.capDur) < r.capTol);
  const carried = a.map((e, i) => s[i] > e + r.minExtra);
  // 2. pedal-ups: sound ends that cluster
  const atUp = new Array<boolean>(n).fill(false);
  const ups: number[] = [];
  const cand = notes
    .map((_, i) => i)
    .filter((i) => !restrike[i] && !capped[i])
    .sort((x, y) => s[x] - s[y]);
  for (let k = 0; k < cand.length; ) {
    let m = k + 1;
    while (m < cand.length && s[cand[m]] - s[cand[m - 1]] < r.endTol) m++;
    const group = cand.slice(k, m);
    if (group.length >= r.kUp && group.filter((i) => carried[i]).length >= r.kCarried) {
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
  const lone = carried.map((c, i) => c && !atUp[i] && !restrike[i]);
  for (let i = 0; i < n; i++) if (lone[i]) a[i] = s[i];
  if (!ups.length) return { notes: withEnds(notes, a), pedal: [] };
  // a note ringing past a pedal-up had its key down through it (if not much longer)
  for (let i = 0; i < n; i++) {
    if (lone[i] || !(s[i] > a[i] + r.minExtra)) continue;
    const j = lowerBound(ups, s[i] - r.endTol) - 1;
    if (j >= 0 && ups[j] > on[i] + 0.02 && ups[j] > a[i] && ups[j] - a[i] <= r.throughMax) a[i] = Math.min(s[i], ups[j]);
  }
  // 4. pedal ranges
  const upOf = s.map((e) => lowerBound(ups, e - r.endTol));
  // keys the model heard stop (not under the pedal): weighted by how cleanly they stop
  const ended = notes
    .map((_, i) => i)
    .filter((i) => (!carried[i] || lone[i]) && !restrike[i] && !atUp[i] && !capped[i] && notes[i].midi <= r.blockMaxMidi)
    .sort((x, y) => s[x] - s[y]);
  const eEnds = ended.map((i) => s[i]);
  const eW = ended.map((i) => (s[i] < nx[i] - r.detach ? 1 : r.ringLegato));
  const needBy: number[][] = ups.map(() => []);
  for (let i = 0; i < n; i++) if (carried[i] && !lone[i] && upOf[i] < ups.length) needBy[upOf[i]].push(i);
  const pedal: PedalRange[] = [];
  let prev = -Infinity;
  for (let k = 0; k < ups.length; k++) {
    const U = ups[k];
    const need = needBy[k];
    if (need.length) {
      let first = Infinity;
      for (const i of need) first = Math.min(first, on[i]);
      const lo = Math.max(prev + r.downGap, first);
      // pedal-down D: least (ringing of the keys heard stopping after D) + holdCost x (carried keys held longer)
      const hold = (d: number) => {
        let c = 0;
        for (const i of need) c += Math.max(0, Math.min(s[i], d + r.overlap) - a[i]);
        return c;
      };
      const cands: number[] = [];
      const ring: number[] = [];
      for (let b = lowerBound(eEnds, lo); b < eEnds.length && eEnds[b] < U - r.endTol; b++) {
        if (eEnds[b] <= lo || eW[b] <= 0) continue;
        cands.push(eEnds[b] + 0.01);
        ring.push(eW[b] * (U - eEnds[b]));
      }
      let left = ring.reduce((x, y) => x + y, 0);
      let D = lo;
      let best = left + r.holdCost * hold(lo);
      for (let c = 0; c < cands.length; c++) {
        left -= ring[c];
        const cost = left + r.holdCost * hold(cands[c]);
        if (cost < best - 1e-9) {
          best = cost;
          D = cands[c];
        }
      }
      // a carried key let go before the pedal went down was held until just after (if not much longer)
      for (const i of need) if (a[i] < D + r.overlap && D + r.overlap - a[i] <= r.holdMax) a[i] = Math.min(s[i], D + r.overlap);
      if (U - D >= r.minPedal) pedal.push({ start: Math.floor(D * 1000) / 1000, end: round(U) });
    }
    prev = U;
  }
  // 5. a lone note that rings inside a pedal range: the pedal, not the finger, kept it sounding
  const ps = pedal.map((p) => p.start);
  for (let i = 0; i < n; i++) {
    if (!lone[i]) continue;
    const j = lowerBound(ps, s[i] - r.minExtra) - 1;
    // (a note closed at the model's limit has no real end: the pedal need only be down after its key-up)
    if (j < 0 || (capped[i] ? pedal[j].end <= a1[i] + r.minExtra : pedal[j].end < s[i] - r.endTol)) continue;
    const k = Math.max(a1[i], pedal[j].start + r.overlap);
    if (k < s[i] - r.minExtra) a[i] = k;
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
