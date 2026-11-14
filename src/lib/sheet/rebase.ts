/**
 * Moving the locked start of the sheet earlier (lock.ts) when a note now starts before it. Kept apart
 * from lock.ts so the studio store can run it after every edit without loading the sheet engine.
 */
import type { Arrangement, Note, SheetGridLock, SheetMark, Song, SongSheet } from '../music/types';
import { gridFromLock, meterShape } from './grid';
import { DIV } from './types';

const usable = (n: Note) => Number.isFinite(n.start) && Number.isFinite(n.dur) && n.midi >= 0 && n.midi <= 127;

const shiftMark = (mk: SheetMark, by: number): SheetMark => (mk.kind === 'slur' ? mk : mk.kind === 'wedge' ? { ...mk, pos: mk.pos + by, end: mk.end + by } : { ...mk, pos: mk.pos + by });

/**
 * When a note of any level now starts before the locked start (more than a 32nd early), moves the
 * start back to the beat before it: the bar lines and seconds stay, and every stored position
 * (pins, level markings, key / time / tempo changes from a bar after the start, the bar count)
 * moves by the same amount. Returns the changed fields, or null when nothing needs to move.
 */
export function rebaseSheet(song: Pick<Song, 'sheet' | 'arrangements' | 'tempo'>): { sheet: SongSheet; arrangements: Song['arrangements'] } | null {
  const sheet = song.sheet;
  if (!sheet) return null;
  const lock = sheet.grid;
  const time = gridFromLock(lock, song.tempo.source, sheet.meters);
  let minPos = Infinity;
  for (const lv of ['easy', 'medium', 'hard'] as const)
    for (const n of song.arrangements[lv]?.notes ?? []) {
      if (!usable(n)) continue;
      const p = time.toPos(n.start);
      if (p < minPos) minPos = p;
    }
  const at0 = sheet.meters?.find((x) => x.pos === 0);
  const shape = at0 ? meterShape(at0.beatsPerBar, at0.beatUnit) : meterShape(lock.beatsPerBar, lock.beatUnit);
  const tol = shape.beatLen / 8;
  if (!(minPos < -tol) || !Number.isFinite(minPos)) return null;
  const L = shape.measureLen;
  const anchor = lock.pickup > 0 ? lock.pickup : 0;
  const firstBar = anchor + Math.floor((minPos - anchor) / L) * L;
  const o = firstBar + Math.max(0, Math.floor((minPos - firstBar) / shape.beatLen + 1 / 8)) * shape.beatLen;
  const by = -o;
  if (!(by > 0) || !Number.isInteger(by)) return null;
  const grid: SheetGridLock = { ...lock, originQ: lock.originQ + o / DIV, pickup: o === firstBar ? 0 : firstBar + L - o };
  const next: SongSheet = { ...sheet, grid };
  const move = <T extends { pos: number }>(xs: T[] | undefined) => xs?.map((x) => (x.pos > 0 ? { ...x, pos: x.pos + by } : x));
  if (sheet.keys) next.keys = move(sheet.keys);
  if (sheet.meters) next.meters = move(sheet.meters);
  if (sheet.tempos) next.tempos = move(sheet.tempos);
  if (sheet.bars) {
    const after = gridFromLock(grid, song.tempo.source, next.meters);
    next.bars = sheet.bars + (after.measureOf(anchor + by) - time.measureOf(anchor));
  }
  const arrangements = { ...song.arrangements };
  for (const lv of ['easy', 'medium', 'hard'] as const) {
    const a: Arrangement | undefined = song.arrangements[lv];
    if (!a) continue;
    const out: Arrangement = { ...a, notes: a.notes.map((n) => (n.pin ? { ...n, pin: { ...n.pin, on: n.pin.on + by, off: n.pin.off + by } } : n)) };
    if (a.marks) out.marks = a.marks.map((mk) => shiftMark(mk, by));
    arrangements[lv] = out;
  }
  return { sheet: next, arrangements };
}
