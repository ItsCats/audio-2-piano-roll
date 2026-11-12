import type { Note, TempoInfo } from './types';
import { snapTime, beatPeriodAt, timeToBeat } from './beats';

export interface QuantizeOptions {
  /** Grid divisions per beat: 1 = quarter, 2 = eighth, 4 = sixteenth, 3 = triplet eighths. */
  subdivision: number;
  /** 0..1, how far notes move toward the grid. */
  strength: number;
  quantizeDurations: boolean;
  /** Notes further than this fraction of a grid step from the grid are left untouched. */
  window?: number;
  /**
   * With a 16th grid (subdivision 4 or 8): a quarter whose notes are clearly triplet 8ths
   * (isClearTriplet) snaps to the triplet grid instead, so triplets don't turn into 16th rhythms.
   */
  triplets?: boolean;
}

const snapErr = (x: number, g: number) => Math.abs(x - Math.round(x * g) / g);

/**
 * Whether the onsets of one quarter are clearly triplet 8ths. `xs` = onset offsets from the
 * quarter's start in quarters, taken from [−1/8, 7/8). Needs ≥ 2 onsets near 1/3 or 2/3, the
 * triplet error under half the 16th error, and the 16th grid really not fitting (mean error of the
 * off-beat onsets > 0.06 quarters), so jittered straight 16ths never count.
 */
export function isClearTriplet(xs: number[]): boolean {
  const off = xs.filter((x) => Math.abs(x) > 0.06 && Math.abs(x - 1) > 0.06);
  const nearThirds = off.filter((x) => Math.abs(x - 1 / 3) < 0.05 || Math.abs(x - 2 / 3) < 0.05).length;
  if (nearThirds < 2) return false;
  const e3 = off.reduce((s, x) => s + snapErr(x, 3), 0) / off.length;
  const e4 = off.reduce((s, x) => s + snapErr(x, 4), 0) / off.length;
  return e3 < 0.5 * e4 && e4 > 0.06;
}

export function quantizeNotes(notes: Note[], tempo: TempoInfo, opts: QuantizeOptions): Note[] {
  const { subdivision, strength } = opts;
  // quarters (in grid units of 4 per quarter) that are clearly triplets
  const perQuarter = subdivision / 4;
  let triplet: Set<number> | null = null;
  if (opts.triplets && Number.isInteger(perQuarter) && perQuarter >= 1) {
    const byQ = new Map<number, number[]>();
    for (const n of notes) {
      const q = timeToBeat(tempo.beats, n.start, tempo.bpm) * perQuarter;
      const k = Math.floor(q + 1 / 8);
      let a = byQ.get(k);
      if (!a) byQ.set(k, (a = []));
      a.push(q - k);
    }
    triplet = new Set([...byQ].filter(([, xs]) => isClearTriplet(xs)).map(([k]) => k));
  }
  const subAt = (t: number) => {
    if (!triplet?.size) return subdivision;
    const k = Math.floor(timeToBeat(tempo.beats, t, tempo.bpm) * perQuarter + 1 / 8);
    return triplet.has(k) ? 3 * perQuarter : subdivision;
  };
  return notes.map((n) => {
    const sub = subAt(n.start);
    const step = beatPeriodAt(tempo.beats, n.start, tempo.bpm) / sub;
    const target = snapTime(tempo.beats, tempo.bpm, n.start, sub);
    if (opts.window !== undefined && Math.abs(target - n.start) > opts.window * step) return n;
    const start = Math.max(0, n.start + (target - n.start) * strength);
    let dur = n.dur;
    if (opts.quantizeDurations) {
      const endSub = subAt(n.start + n.dur);
      const endTarget = snapTime(tempo.beats, tempo.bpm, n.start + n.dur, endSub);
      const end = n.start + n.dur + (endTarget - (n.start + n.dur)) * strength;
      dur = Math.max(step * 0.9, end - start);
    }
    return { ...n, start, dur };
  });
}
