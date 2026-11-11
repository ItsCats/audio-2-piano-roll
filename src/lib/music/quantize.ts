import type { Note, TempoInfo } from './types';
import { snapTime, beatPeriodAt } from './beats';

export interface QuantizeOptions {
  /** Grid divisions per beat: 1 = quarter, 2 = eighth, 4 = sixteenth, 3 = triplet eighths. */
  subdivision: number;
  /** 0..1, how far notes move toward the grid. */
  strength: number;
  quantizeDurations: boolean;
  /** Notes further than this fraction of a grid step from the grid are left untouched. */
  window?: number;
}

export function quantizeNotes(notes: Note[], tempo: TempoInfo, opts: QuantizeOptions): Note[] {
  const { subdivision, strength } = opts;
  return notes.map((n) => {
    const step = beatPeriodAt(tempo.beats, n.start, tempo.bpm) / subdivision;
    const target = snapTime(tempo.beats, tempo.bpm, n.start, subdivision);
    if (opts.window !== undefined && Math.abs(target - n.start) > opts.window * step) return n;
    const start = Math.max(0, n.start + (target - n.start) * strength);
    let dur = n.dur;
    if (opts.quantizeDurations) {
      const endTarget = snapTime(tempo.beats, tempo.bpm, n.start + n.dur, subdivision);
      const end = n.start + n.dur + (endTarget - (n.start + n.dur)) * strength;
      dur = Math.max(step * 0.9, end - start);
    }
    return { ...n, start, dur };
  });
}
