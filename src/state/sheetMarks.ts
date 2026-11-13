/**
 * Runs markings on the open song as one undo step each: level markings (lib/sheet/marks.ts:
 * fingering, articulations, slurs, dynamics, hairpins, words, pedal) and the song-level key, time
 * and tempo changes (Song.sheet), creating the grid lock on the first sheet edit like note edits.
 */
import type { Arrangement, Song, SheetKey, SheetMeter, SheetTempo, TempoUnit } from '../lib/music/types';
import { ensureSheet } from '../lib/sheet/lock';
import { deleteMarkOp, moveMarkOp, pedalSel, resolveMark, type MarkEditResult } from '../lib/sheet/marks';
import type { BarMarkRef } from '../lib/sheet/render';
import { canRetime, retime } from '../lib/sheet/retime';
import { TEMPO_UNIT_Q } from '../lib/sheet/score';
import { sortNotes } from '../lib/music/cleanup';
import type { SheetCtx } from '../lib/sheet/edit';
import { DIV } from '../lib/sheet/types';
import { markSheetEdited, sheetCtx } from './sheetEdit';
import { getPlayer } from './playback';
import { useStudio } from './studioStore';
import { useTransport } from './transportStore';
import { toast } from './toastStore';

/** Applies a level-marking operation; returns whether anything changed. */
export function runMarkEdit(op: (ctx: SheetCtx) => MarkEditResult | null, opts?: { coalesceKey?: string }): boolean {
  const ctx = sheetCtx();
  if (!ctx) return false;
  const res = op(ctx);
  if (!res) return false;
  const level = ctx.level;
  markSheetEdited();
  useStudio.getState().editSong((s) => {
    const sheet = ensureSheet(s, level);
    const arr = s.arrangements[level];
    const next: Arrangement = { ...arr, edited: true };
    if (res.notes) next.notes = sortNotes(res.notes);
    if (res.marks !== undefined) {
      if (res.marks.length) next.marks = res.marks;
      else delete next.marks;
    }
    if (res.pedal) next.pedal = res.pedal;
    if (res.showPedal === true) next.showPedal = true;
    else if (res.showPedal === false) delete next.showPedal;
    if (res.pedalEdited) next.pedalEdited = true;
    return { arrangements: { ...s.arrangements, [level]: next }, sheet };
  }, opts);
  if (res.select) useStudio.setState({ selection: new Set(res.select) });
  if (res.markSel !== undefined) useStudio.setState({ markSel: res.markSel, ...(res.markSel ? { selection: new Set<number>() } : {}) });
  return true;
}

/** The measure the playback cursor is in (where marks go with nothing selected). */
export function cursorMeasure(ctx: SheetCtx): number {
  const t = getPlayer().getTime();
  const ts = ctx.score.measureStartTimes;
  let m = 0;
  while (m + 1 < ctx.score.measureCount && ts[m + 1] <= t + 1e-6) m++;
  return m;
}

/** The measure new key / time / tempo marks apply from: the selection's (note or marking), else the cursor's. */
export function targetMeasure(ctx: SheetCtx): number {
  const st = useStudio.getState();
  const sel = ctx.song.arrangements[ctx.level].notes.filter((n) => st.selection.has(n.id));
  const t = ctx.score.time;
  if (sel.length) return t.measureOf(Math.min(...sel.map((n) => (n.pin && n.pin.t === n.start && n.pin.d === n.dur ? n.pin.on : Math.max(0, Math.round(t.toPos(n.start)))))));
  const r = resolveMark(ctx, st.markSel);
  if (r?.type === 'mark' && r.mark.kind !== 'slur') return t.measureOf(r.mark.pos);
  if (r && r.type !== 'mark' && r.type !== 'pedal') return t.measureOf(r.pos);
  return cursorMeasure(ctx);
}

const upsert = <T extends { pos: number }>(list: T[] | undefined, item: T | null, pos: number): T[] | undefined => {
  const out = (list ?? []).filter((x) => x.pos !== pos);
  if (item) out.push(item);
  out.sort((a, b) => a.pos - b.pos);
  return out.length ? out : undefined;
};

function setSheetList(s: Song, level: SheetCtx['level'], key: 'keys' | 'meters' | 'tempos', list: unknown[] | undefined): Partial<Song> {
  const sheet = { ...ensureSheet(s, level) };
  if (list) (sheet as Record<string, unknown>)[key] = list;
  else delete sheet[key];
  return { sheet };
}

/** Key signature from measure m (the same as the key before it: the change is removed). */
export function setKeyAt(m: number, fifths: number, mode: 'major' | 'minor'): boolean {
  const ctx = sheetCtx();
  if (!ctx) return false;
  const pos = ctx.score.time.measureStart(m);
  const before = m > 0 ? keyBefore(ctx, m) : { fifths: songFifths(ctx), mode: ctx.song.key?.mode === 'minor' ? 'minor' : 'major' };
  const item: SheetKey | null = before.fifths === fifths && before.mode === mode ? null : { pos, fifths, mode };
  markSheetEdited();
  useStudio.getState().editSong((s) => setSheetList(s, ctx.level, 'keys', upsert(s.sheet?.keys, item, pos)));
  useStudio.setState({ markSel: item ? `key:${pos}` : null });
  return true;
}

const songFifths = (ctx: SheetCtx) => {
  const k0 = ctx.song.sheet?.keys?.find((k) => k.pos === 0);
  return k0 ? k0.fifths : ctx.score.keys[0].fifths;
};
function keyBefore(ctx: SheetCtx, m: number): { fifths: number; mode: 'major' | 'minor' } {
  const ks = ctx.score.keys.filter((k) => k.measure < m);
  const k = ks[ks.length - 1] ?? ctx.score.keys[0];
  return { fifths: k.fifths, mode: k.mode };
}

/** Time signature from measure m: a relabel (no note moves; the bars are regrouped from there). */
export function setMeterAt(m: number, beatsPerBar: number, beatUnit: 2 | 4 | 8): boolean {
  const ctx = sheetCtx();
  if (!ctx) return false;
  const t = ctx.score.time;
  const pos = t.measureStart(m);
  const before = m > 0 ? t.meterAt(m - 1) : { beatsPerBar: ctx.song.sheet?.grid.beatsPerBar ?? t.beatsPerBar, beatUnit: ctx.song.sheet?.grid.beatUnit ?? t.beatUnit };
  const item: SheetMeter | null = before.beatsPerBar === beatsPerBar && before.beatUnit === beatUnit ? null : { pos, beatsPerBar, beatUnit };
  markSheetEdited();
  useStudio.getState().editSong((s) => setSheetList(s, ctx.level, 'meters', upsert(s.sheet?.meters, item, pos)));
  useStudio.setState({ markSel: item ? `time:${pos}` : null });
  return true;
}

/**
 * Tempo mark from measure m. Songs without a recording or hands video: optionally re-times the music
 * from there (one undo step with the mark); otherwise the mark is a label and the speed stays.
 */
export function setTempoAt(m: number, bpm: number, unit: TempoUnit, text: string, changeSpeed: boolean): boolean {
  const ctx = sheetCtx();
  if (!ctx || !(bpm >= 20 && bpm <= 400)) return false;
  const pos = ctx.score.time.measureStart(m);
  const words = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim().slice(0, 40);
  const re = changeSpeed && canRetime(ctx.song);
  const item: SheetTempo = { pos, bpm, unit, ...(words ? { text: words } : {}), retimed: re };
  markSheetEdited();
  useStudio.getState().editSong((s) => {
    const sheet = { ...ensureSheet(s, ctx.level) };
    sheet.tempos = upsert(sheet.tempos, item, pos);
    const withMark: Song = { ...s, sheet };
    if (!re) return { sheet };
    return retime(withMark, pos, bpm * TEMPO_UNIT_Q[unit]).patch;
  });
  if (re) afterRetime();
  else if (changeSpeed) toast.info('This song plays a recording, so the tempo mark is shown but the playback speed stays the same.');
  useStudio.setState({ markSel: `tempo:${pos}` });
  return true;
}

/** Loop points are in the old seconds: the loop is cleared after a re-time. */
function afterRetime(): void {
  useTransport.setState({ loop: null, loopEnabled: false });
}

/** Deletes the selected marking (note markings, pedal, key / time / tempo). A re-timed tempo mark goes back to the speed before it. */
export function deleteSelectedMark(): boolean {
  const st = useStudio.getState();
  const ctx = sheetCtx();
  if (!ctx || !st.markSel) return false;
  const r = resolveMark(ctx, st.markSel);
  if (!r) return false;
  if (r.type === 'mark' || r.type === 'pedal') return runMarkEdit((c) => deleteMarkOp(c, st.markSel!));
  const pos = r.pos;
  markSheetEdited();
  if (r.type === 'key') st.editSong((s) => setSheetList(s, ctx.level, 'keys', upsert(s.sheet?.keys, null, pos)));
  else if (r.type === 'time') st.editSong((s) => setSheetList(s, ctx.level, 'meters', upsert(s.sheet?.meters, null, pos)));
  else {
    const entry = ctx.song.sheet?.tempos?.find((x) => x.pos === pos);
    const m = ctx.score.time.measureOf(pos);
    // the speed of the bar before it (a re-timed mark at the very start keeps its speed)
    const prevQpm = entry?.retimed && m > 0 ? measureQpm(ctx, m - 1) : null;
    st.editSong((s) => {
      const sheet = { ...ensureSheet(s, ctx.level) };
      sheet.tempos = upsert(sheet.tempos, null, pos);
      if (!sheet.tempos) delete sheet.tempos;
      if (prevQpm === null || !canRetime(s)) return { sheet };
      return retime({ ...s, sheet }, pos, prevQpm).patch;
    });
    if (prevQpm !== null) afterRetime();
  }
  useStudio.setState({ markSel: null });
  return true;
}

/** Quarter notes per minute that measure m is played at. */
function measureQpm(ctx: SheetCtx, m: number): number {
  const s = ctx.score;
  const secs = s.measureStartTimes[m + 1] - s.measureStartTimes[m];
  return Math.round(((s.time.measureLenAt(m) / DIV) * 60) / secs);
}

/** Moves the selected marking one grid step (Earlier / Later; `end`: a hairpin's or pedal's end). */
export function moveSelectedMark(dir: 1 | -1, end = false): boolean {
  const sel = useStudio.getState().markSel;
  if (!sel) return false;
  if (/^(key|time|tempo):/.test(sel)) {
    toast.info('Key, time and tempo changes stay at the start of their bar. Delete one and add it again to move it.');
    return false;
  }
  return runMarkEdit((c) => moveMarkOp(c, sel, dir, end), { coalesceKey: 'sheet-mark-move' });
}

/** The song-level markings to find on the sheet (key, time and tempo changes placed on it). */
export function barMarkRefs(ctx: SheetCtx): BarMarkRef[] {
  const sh = ctx.song.sheet;
  if (!sh) return [];
  const t = ctx.score.time;
  const last = ctx.score.measureCount - 1;
  const out: BarMarkRef[] = [];
  for (const k of sh.keys ?? []) if (k.pos > 0) out.push({ id: `key:${k.pos}`, kind: 'key', measure: Math.min(last, t.measureOf(k.pos)) });
  for (const k of sh.meters ?? []) if (k.pos > 0) out.push({ id: `time:${k.pos}`, kind: 'time', measure: Math.min(last, t.measureOf(k.pos)) });
  for (const k of sh.tempos ?? []) out.push({ id: `tempo:${k.pos}`, kind: 'tempo', measure: Math.min(last, t.measureOf(k.pos)) });
  return out;
}

/** The selection id of a drawn marking (a drawn pedal line: the pedal range it was written from). */
export function markSelOfHit(ctx: SheetCtx, hitId: string): string | null {
  const m = /^pedal@(\d+)$/.exec(hitId);
  if (!m) return hitId;
  const on = Number(m[1]);
  const t = ctx.score.time;
  let best: { d: number; sel: string } | null = null;
  for (const p of ctx.song.arrangements[ctx.level].pedal) {
    const a = t.toPos(p.start);
    const b = t.toPos(p.end);
    const d = a <= on + 6 && b > on ? Math.abs(a - on) : Infinity;
    if (d < (best?.d ?? Infinity)) best = { d, sel: pedalSel(p) };
  }
  return best?.sel ?? null;
}
