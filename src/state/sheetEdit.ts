/**
 * Runs sheet edits (lib/sheet/edit.ts) on the open song as one undo step each: the level's notes,
 * the grid lock (created by the first sheet edit, so undo removes it too) and the duration.
 */
import { buildSheet } from '../lib/sheet';
import { sortNotes } from '../lib/music/cleanup';
import { ensureSheet } from '../lib/sheet/lock';
import type { SheetCtx, SheetEditResult } from '../lib/sheet/edit';
import { fixSlurs } from '../lib/sheet/marks';
import { getPlayer } from './playback';
import { useStudio } from './studioStore';
import { toast } from './toastStore';

/** When the last sheet edit was made (the sheet view redraws it on the next frame, not after 400 ms). */
let lastSheetEditAt = 0;
export const sheetEditedRecently = (ms = 250) => performance.now() - lastSheetEditAt < ms;
/** Marks the next song change as a sheet edit (redrawn on the next frame). */
export const markSheetEdited = () => void (lastSheetEditAt = performance.now());

/** The open song's sheet context, or null. */
export function sheetCtx(): SheetCtx | null {
  const st = useStudio.getState();
  if (!st.song || !st.song.arrangements[st.difficulty]) return null;
  return { song: st.song, level: st.difficulty, score: buildSheet(st.song, st.difficulty) };
}

/** How many other notes the last sheet edit replaced (same-pitch notes it covered). */
let lastReplaced = 0;
export const replacedByLastEdit = () => lastReplaced;

/**
 * Applies a sheet operation; returns whether anything changed. Notes it replaced (a same-pitch note
 * the edited one now covers) are reported in a message, unless `quiet` (the caller says it).
 */
export function runSheetEdit(op: (ctx: SheetCtx) => SheetEditResult | null, opts?: { coalesceKey?: string; quiet?: boolean }): boolean {
  const ctx = sheetCtx();
  if (!ctx) return false;
  const res = op(ctx);
  if (!res) return false;
  {
    const before = ctx.song.arrangements[ctx.level].notes;
    const after = new Set(res.notes.map((n) => n.id));
    lastReplaced = res.deletes ? 0 : before.filter((n) => !after.has(n.id) && !res.repoint?.has(n.id)).length;
  }
  const st = useStudio.getState();
  const level = ctx.level;
  lastSheetEditAt = performance.now();
  st.editSong((s) => {
    const sheet = ensureSheet(s, level);
    const arr = s.arrangements[level];
    // slurs on deleted notes go too; a tie re-points the slurs of the note it merged
    const marks = fixSlurs(arr.marks, res.notes, res.repoint);
    const next = { ...arr, notes: sortNotes(res.notes), edited: true };
    if (marks !== arr.marks) {
      if (marks?.length) next.marks = marks;
      else delete next.marks;
    }
    return {
      arrangements: { ...s.arrangements, [level]: next },
      sheet: res.bars !== undefined && res.bars > (sheet.bars ?? 0) ? { ...sheet, bars: res.bars } : sheet,
      ...(res.duration !== undefined ? { duration: res.duration } : {}),
    };
  }, opts);
  if (res.select) useStudio.setState({ selection: new Set(res.select) });
  if (lastReplaced && !opts?.quiet) toast.info(replacedText(lastReplaced), 'Notes of the same pitch in one hand can’t overlap. Undo brings them back.');
  return true;
}

export const replacedText = (n: number) => `Replaced ${n} note${n === 1 ? '' : 's'} it covered`;

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
