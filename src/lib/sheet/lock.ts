/**
 * The grid lock (Song.sheet.grid): the TimeMap on screen, frozen at the first sheet edit so later
 * edits (an early note deleted, a note added before the first one) and future changes to the beat
 * estimator never re-bar the piece. `gridFromLock` (grid.ts) turns it back into the same TimeMap.
 *
 * One lock serves all three levels, so it starts where the earliest note of any level starts: a
 * level that leaves out an intro or a pickup gets rests there instead of pushing the other levels'
 * first notes onto beat 1. A note placed before the locked start later (the piano roll can do
 * that) moves the start earlier by `rebaseSheet`, keeping every bar line and every stored position
 * where it was in seconds.
 */
import type { Difficulty, Note, SheetGridLock, Song, SongSheet } from '../music/types';
import { gridParams } from './grid';
import { songSheetTempo } from './index';

const usable = (n: Note) => Number.isFinite(n.start) && Number.isFinite(n.dur) && n.midi >= 0 && n.midi <= 127;

/** The grid the sheet is written on right now (the lock when there is one). */
export function lockGrid(song: Song, level: Difficulty): SheetGridLock {
  if (song.sheet) return song.sheet.grid;
  // the level being edited plus the first note of every other level (only the start matters)
  const notes: { start: number }[] = song.arrangements[level].notes.filter(usable);
  for (const lv of ['easy', 'medium', 'hard'] as const) {
    if (lv === level) continue;
    let first: Note | undefined;
    for (const n of song.arrangements[lv]?.notes ?? []) if (usable(n) && (!first || n.start < first.start)) first = n;
    if (first) notes.push(first);
  }
  const p = gridParams(songSheetTempo(song), song.duration, notes);
  return { ...p, beats: [...p.beats] };
}

/** The song's sheet data, creating the lock on the first edit. */
export function ensureSheet(song: Song, level: Difficulty): SongSheet {
  return song.sheet ?? { v: 1, grid: lockGrid(song, level) };
}

export { rebaseSheet } from './rebase';
