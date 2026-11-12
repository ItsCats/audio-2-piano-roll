/**
 * CREPE note candidates → the right-hand melody line.
 *
 * The candidates of f0ToNotes() are already ONE monophonic line, so the polyphonic reduction of
 * music/melody.ts (reduceToLine: built for Basic Pitch's harmonics / doubles / backing vocals)
 * is skipped — measured, it only removed correct notes (a jump penalty against a monophonic
 * tracker's legitimate leaps). What stays from melody.ts: the vibrato / fragment merge
 * (smoothLine), removal of isolated multi-second holds (bleed) and the whole-line octave move into
 * a plausible melody register; the isolated-octave repair is optional (off by default).
 */
import type { Note } from '../music/types';
import { newNoteId } from '../music/cleanup';
import { DEFAULT_MELODY, dropIsolatedHolds, fixOctaveOutliers, registerShift, smoothLine, type MelodyOptions } from '../music/melody';

export interface CrepeLineOptions {
  /**
   * repair isolated octave jumps against the local register (melody.ts fixOctaveOutliers). Off:
   * on CREPE lines it moved more right notes than wrong ones (5 songs, every reference: RPA
   * -0.01 to -0.016)
   */
  fixOctaves: boolean;
  /** drop isolated holds longer than this (s); 0 disables */
  maxHold: number;
  /** candidates below this salience (mean periodicity) are dropped */
  minSalience: number;
  melody: Partial<MelodyOptions>;
}

export const DEFAULT_CREPE_LINE: CrepeLineOptions = { fixOctaves: false, maxHold: 3, minSalience: 0, melody: {} };

export function crepeMelodyLine(candidates: Note[], opts: Partial<CrepeLineOptions> = {}): Note[] {
  const o = { ...DEFAULT_CREPE_LINE, ...opts };
  const m = { ...DEFAULT_MELODY, ...o.melody };
  let line = candidates
    .filter((n) => n.vel >= o.minSalience && n.midi >= m.minMidi && n.midi <= m.maxMidi)
    .map((n) => ({ ...n }))
    .sort((a, b) => a.start - b.start);
  line = smoothLine(line, m);
  if (o.fixOctaves) {
    line = fixOctaveOutliers(line);
    line = smoothLine(line, m);
  }
  if (o.maxHold > 0) line = dropIsolatedHolds(line, o.maxHold);
  const shift = registerShift(line, m.registerLow, m.registerHigh);
  return line.map((n) => ({ ...n, id: newNoteId(), midi: Math.min(108, Math.max(21, n.midi + shift)), hand: 'R' as const, role: 'melody' as const }));
}
