/**
 * CREPE pitch + Basic Pitch note starts: a sung line often repeats a pitch on consecutive
 * syllables without an unvoiced gap (legato), which a pitch track cannot see. Basic Pitch's
 * onset head does: a melody-line note is split where a Basic Pitch vocal note of (about) the same
 * pitch class starts well inside it (pitch class: the line may have been moved by octaves). Apply
 * it to the finished line — the line stage merges same-pitch neighbours again.
 */
import type { Note } from '../music/types';
import { newNoteId } from '../music/cleanup';

export interface SplitOptions {
  /** a split point must be at least this far from the note's start and end (s) */
  margin: number;
  /** Basic Pitch note pitch must be within this many semitones of the CREPE note */
  maxSemitones: number;
  /** Basic Pitch notes quieter than this (velocity) are ignored */
  minVel: number;
  /** silence left before each re-struck piece (s), so the repeat is audible on a piano */
  gap: number;
}

export const DEFAULT_SPLIT: SplitOptions = { margin: 0.1, maxSemitones: 1, minVel: 0.5, gap: 0.03 };

const pcDistance = (a: number, b: number) => {
  const d = (((a - b) % 12) + 12) % 12;
  return Math.min(d, 12 - d);
};

export function splitAtOnsets(notes: Note[], bpNotes: Note[], opts: Partial<SplitOptions> = {}): Note[] {
  const o = { ...DEFAULT_SPLIT, ...opts };
  const starts = bpNotes.filter((b) => b.vel >= o.minVel).sort((a, b) => a.start - b.start);
  const out: Note[] = [];
  let k = 0;
  for (const n of [...notes].sort((a, b) => a.start - b.start)) {
    while (k < starts.length && starts[k].start < n.start) k++;
    const end = n.start + n.dur;
    const cuts: number[] = [];
    for (let j = k; j < starts.length && starts[j].start < end; j++) {
      const b = starts[j];
      const last = cuts.length ? cuts[cuts.length - 1] : n.start;
      if (b.start - last >= o.margin && end - b.start >= o.margin && pcDistance(b.midi, n.midi) <= o.maxSemitones) cuts.push(b.start);
    }
    let s = n.start;
    for (const c of cuts) {
      out.push({ ...n, id: newNoteId(), start: s, dur: c - s - o.gap });
      s = c;
    }
    out.push({ ...n, id: newNoteId(), start: s, dur: end - s });
  }
  return out;
}
