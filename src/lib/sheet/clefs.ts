/**
 * Clefs and octave marks. A staff changes clef only at a bar line, only when that saves enough
 * ledger lines over at least two bars (dynamic programming with a switch cost and a minimum run
 * length, so a wobbling melody never flip-flops). Octave marks (8va / 8vb) cover runs of very
 * high / very low notes, decided per run of notes rather than per measure.
 */
import { diatonic, spell } from './spelling';
import type { Chord, ClefSign, Ottava, StaffVoices } from './types';

/** Lines above and below each clef's staff, as diatonic numbers (C0 = 0). */
const STAFF_RANGE: Record<ClefSign, [number, number]> = { G: [30, 38], F: [18, 26] }; // E4–F5, G2–A3

export function ledgerLines(midi: number, clef: ClefSign, fifths = 0): number {
  const dn = diatonic(spell(midi, fifths));
  const [lo, hi] = STAFF_RANGE[clef];
  if (dn > hi) return Math.floor((dn - hi) / 2);
  if (dn < lo) return Math.floor((lo - dn) / 2);
  return 0;
}

const SWITCH_COST = 8;
/** Per bar in the staff's other clef, so a change has to pay off clearly. */
const AWAY_COST = 1;
const MIN_RUN = 2;

/** Clef per measure for one staff. `notesPerMeasure[m]` = MIDI numbers shown in measure m. */
export function chooseClefs(notesPerMeasure: number[][], defaultClef: ClefSign, allowChanges: boolean, fifths = 0): ClefSign[] {
  const n = notesPerMeasure.length;
  if (!allowChanges || !n) return new Array(n).fill(defaultClef);
  const clefs: ClefSign[] = ['G', 'F'];
  const cost = notesPerMeasure.map((ms) => clefs.map((c) => ms.reduce((s, x) => s + ledgerLines(x, c, fifths), 0) + (c === defaultClef ? 0 : AWAY_COST)));
  // state = clef index * 2 + (run length capped at MIN_RUN) - 1
  const S = clefs.length * MIN_RUN;
  const INF = 1e18;
  let dp = new Array(S).fill(INF);
  const back: Int8Array[] = [];
  for (let c = 0; c < 2; c++) dp[c * MIN_RUN] = cost[0][c] + (clefs[c] === defaultClef ? 0 : SWITCH_COST);
  for (let m = 1; m < n; m++) {
    const nd = new Array(S).fill(INF);
    const bk = new Int8Array(S).fill(-1);
    for (let s = 0; s < S; s++) {
      if (dp[s] >= INF) continue;
      const c = Math.floor(s / MIN_RUN);
      const r = (s % MIN_RUN) + 1;
      // stay
      const st = c * MIN_RUN + Math.min(r + 1, MIN_RUN) - 1;
      const v = dp[s] + cost[m][c];
      if (v < nd[st]) {
        nd[st] = v;
        bk[st] = s;
      }
      // switch (only after a run of MIN_RUN bars)
      if (r >= MIN_RUN) {
        const c2 = 1 - c;
        const s2 = c2 * MIN_RUN;
        const v2 = dp[s] + cost[m][c2] + SWITCH_COST;
        if (v2 < nd[s2]) {
          nd[s2] = v2;
          bk[s2] = s;
        }
      }
    }
    dp = nd;
    back.push(bk);
  }
  // prefer ending after a full run
  const endPenalty = (st: number) => ((st % MIN_RUN) + 1 >= MIN_RUN || n < MIN_RUN ? 0 : SWITCH_COST * 2);
  let best = 0;
  for (let st = 1; st < S; st++) if (dp[st] + endPenalty(st) < dp[best] + endPenalty(best)) best = st;
  const out: ClefSign[] = new Array(n);
  let s = best;
  for (let m = n - 1; m >= 0; m--) {
    out[m] = clefs[Math.floor(s / MIN_RUN)];
    if (m > 0) s = back[m - 1][s];
  }
  return out;
}

/**
 * Octave marks for one staff. A run is a sequence of consecutive onsets (both voices) whose notes
 * are all ≥ E5 (76) with at least one ≥ E6 (88) in a treble clef → 8va, or all ≤ E2 (40) with at
 * least one ≤ G1 (31) in a bass clef → 8vb. Runs need 2+ notes, must stay within one clef, and no
 * other note may sound across their edges. Marks the start/stop chords and returns the runs.
 */
export function findOttavas(sv: StaffVoices, clefAt: (pos: number) => ClefSign, clefChangeAfter: (pos: number) => number): Ottava[] {
  const all: { c: Chord; v: number }[] = [];
  sv.voices.forEach((voice, v) => voice.forEach((c) => all.push({ c, v })));
  all.sort((a, b) => a.c.on - b.c.on || a.v - b.v);
  const onsets: { on: number; items: { c: Chord; v: number }[] }[] = [];
  for (const it of all) {
    const last = onsets[onsets.length - 1];
    if (last && last.on === it.c.on) last.items.push(it);
    else onsets.push({ on: it.c.on, items: [it] });
  }
  const runs: Ottava[] = [];
  const qualifies = (g: (typeof onsets)[number], clef: ClefSign) => {
    const ms = g.items.flatMap((x) => x.c.midis);
    return clef === 'G' ? ms.every((m) => m >= 76) : ms.every((m) => m <= 40);
  };
  /** The octave mark for onsets i..k, or null when it can't have one. */
  const tryRun = (i: number, k: number, clef: ClefSign, limit: number) => {
    const items = onsets.slice(i, k + 1).flatMap((g) => g.items);
    const ms = items.flatMap((x) => x.c.midis);
    const extreme = clef === 'G' ? ms.some((m) => m >= 88) : ms.some((m) => m <= 31);
    if (ms.length < 2 || !extreme) return null;
    const start = onsets[i].on;
    const stopItem = items.reduce((a, b) => (b.c.off > a.c.off || (b.c.off === a.c.off && b.v < a.v) ? b : a));
    const stop = stopItem.c.off;
    if (stop > limit) return null;
    const inRun = new Set(items.map((x) => x.c));
    if (all.some((x) => !inRun.has(x.c) && x.c.on < stop && x.c.off > start)) return null;
    return { start, stop, stopItem };
  };
  let i = 0;
  while (i < onsets.length) {
    const clef = clefAt(onsets[i].on);
    if (!qualifies(onsets[i], clef)) {
      i++;
      continue;
    }
    let j = i;
    const limit = clefChangeAfter(onsets[i].on);
    while (j + 1 < onsets.length && onsets[j + 1].on < limit && qualifies(onsets[j + 1], clef)) j++;
    // the whole run, else the run cut back to where nothing sounds across the cut (e.g. a long
    // held note joined the end of the run and clashes with what follows), at most a few tries
    const cuts: number[] = [j];
    let stop = -Infinity;
    for (let k = i; k < j; k++) {
      for (const it of onsets[k].items) stop = Math.max(stop, it.c.off);
      if (stop <= onsets[k + 1].on) cuts.push(k);
    }
    cuts.sort((x, y) => y - x);
    let found: { k: number; r: NonNullable<ReturnType<typeof tryRun>> } | null = null;
    for (const k of cuts.slice(0, 6)) {
      const r = tryRun(i, k, clef, limit);
      if (r) {
        found = { k, r };
        break;
      }
    }
    if (!found) {
      i++; // a later start inside this run may still work
      continue;
    }
    const shift: 8 | -8 = clef === 'G' ? 8 : -8;
    const first = onsets[i].items[0].c; // voice 1 first when both voices start here
    first.ottavaStart = shift;
    found.r.stopItem.c.ottavaStop = true;
    runs.push({ staff: sv.staff, shift, start: found.r.start, stop: found.r.stop });
    i = found.k + 1;
  }
  return runs;
}

