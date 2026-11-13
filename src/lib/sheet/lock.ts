/**
 * The grid lock (Song.sheet.grid): the TimeMap on screen, frozen at the first sheet edit so later
 * edits (an early note deleted, a note added before the first one) and future changes to the beat
 * estimator never re-bar the piece. `gridFromLock` (grid.ts) turns it back into the same TimeMap.
 */
import type { Difficulty, SheetGridLock, Song, SongSheet } from '../music/types';
import { gridParams } from './grid';
import { songSheetTempo } from './index';

/** The grid the sheet of this level is written on right now (the lock when there is one). */
export function lockGrid(song: Song, level: Difficulty): SheetGridLock {
  if (song.sheet) return song.sheet.grid;
  const notes = song.arrangements[level].notes.filter((n) => Number.isFinite(n.start) && Number.isFinite(n.dur) && n.midi >= 0 && n.midi <= 127);
  const p = gridParams(songSheetTempo(song), song.duration, notes);
  return { ...p, beats: [...p.beats] };
}

/** The song's sheet data, creating the lock on the first edit. */
export function ensureSheet(song: Song, level: Difficulty): SongSheet {
  return song.sheet ?? { v: 1, grid: lockGrid(song, level) };
}
