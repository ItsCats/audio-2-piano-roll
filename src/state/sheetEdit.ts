/**
 * Runs sheet edits (lib/sheet/edit.ts) on the open song as one undo step each: the level's notes,
 * the grid lock (created by the first sheet edit, so undo removes it too) and the duration.
 */
import { buildSheet } from '../lib/sheet';
import { sortNotes } from '../lib/music/cleanup';
import { ensureSheet } from '../lib/sheet/lock';
import type { SheetCtx, SheetEditResult } from '../lib/sheet/edit';
import { getPlayer } from './playback';
import { useStudio } from './studioStore';

/** When the last sheet edit was made (the sheet view redraws it on the next frame, not after 400 ms). */
let lastSheetEditAt = 0;
export const sheetEditedRecently = (ms = 250) => performance.now() - lastSheetEditAt < ms;

/** The open song's sheet context, or null. */
export function sheetCtx(): SheetCtx | null {
  const st = useStudio.getState();
  if (!st.song || !st.song.arrangements[st.difficulty]) return null;
  return { song: st.song, level: st.difficulty, score: buildSheet(st.song, st.difficulty) };
}

/** Applies a sheet operation; returns whether anything changed. */
export function runSheetEdit(op: (ctx: SheetCtx) => SheetEditResult | null, opts?: { coalesceKey?: string }): boolean {
  const ctx = sheetCtx();
  if (!ctx) return false;
  const res = op(ctx);
  if (!res) return false;
  const st = useStudio.getState();
  const level = ctx.level;
  lastSheetEditAt = performance.now();
  st.editSong((s) => {
    const sheet = ensureSheet(s, level);
    return {
      arrangements: { ...s.arrangements, [level]: { ...s.arrangements[level], notes: sortNotes(res.notes), edited: true } },
      sheet: res.bars !== undefined && res.bars > (sheet.bars ?? 0) ? { ...sheet, bars: res.bars } : sheet,
      ...(res.duration !== undefined ? { duration: res.duration } : {}),
    };
  }, opts);
  if (res.select) useStudio.setState({ selection: new Set(res.select) });
  return true;
}

/** Plays a note once (added notes, pitch changes), unless the music is playing. */
export function audition(midis: number[]): void {
  const player = getPlayer();
  if (player.isPlaying || !midis.length) return;
  try {
    for (const m of midis.slice(0, 6)) player.liveNoteOn(m, 0.6);
    setTimeout(() => {
      for (const m of midis.slice(0, 6)) player.liveNoteOff(m);
    }, 350);
  } catch {
    /* no audio yet */
  }
}
