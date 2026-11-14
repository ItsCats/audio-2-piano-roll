/**
 * Sheet edits as pure operations on the Song notes (seconds stay the one source of truth): each
 * takes the song, the level and the Score on screen, and returns the level's new notes. Positions
 * come only from the Score's TimeMap (`posToTime`), never from the song tempo or the roll's snap.
 * Every note an operation touches gets a pin (Note.pin), so it is written exactly where the user
 * put it; the caller locks the grid (lock.ts) in the same undo step.
 */
import type { Difficulty, Hand, Note, Song } from '../music/types';
import { newNoteId } from '../music/cleanup';
import { pinValid } from './score';
import { stepInKey } from './pitch';
import { writtenIndex, writtenSpan } from './written';
import { articulatedSound, levelAt } from './marks';
import { keyAt } from './keys';
import { DIV, type Score, type Staff } from './types';

export interface SheetCtx {
  song: Song;
  level: Difficulty;
  score: Score;
}

export interface SheetEditResult {
  notes: Note[];
  /** New song duration (an edit past the end raises it to the end of that measure). */
  duration?: number;
  /** Minimum measure count (Add bar). */
  bars?: number;
  /** Notes to select afterwards. */
  select?: number[];
  /** Slurs on these notes now end on others (a tie merged b into a). */
  repoint?: Map<number, number>;
}

/** Note lengths of the palette (divisions): 16th, 8th, dotted 8th, quarter, dotted quarter, half, dotted half, whole. */
export const LENGTHS = [3, 6, 9, 12, 18, 24, 36, 48];
export const LENGTH_NAMES: Record<number, string> = {
  3: '16th',
  4: 'triplet 8th',
  6: '8th',
  8: 'triplet quarter',
  9: 'dotted 8th',
  12: 'quarter',
  18: 'dotted quarter',
  24: 'half',
  36: 'dotted half',
  48: 'whole',
  72: 'dotted whole',
};
export const lengthName = (len: number) => LENGTH_NAMES[len] ?? `${len / DIV} beats`;

/** Grid step of the level at a position: Easy 8ths; Medium and Hard 16ths, or triplet 8ths in a triplet quarter. */
export function gridStep(score: Score, pos: number): number {
  if (score.level === 'easy') return 6;
  return score.tripletQuarters.has(Math.floor(pos / DIV)) ? 4 : 3;
}

/** Snaps a position to the level grid of its quarter. */
export function snapPos(score: Score, pos: number, mode: 'round' | 'floor' | 'ceil' = 'round'): number {
  const q = Math.floor(pos / DIV);
  const step = gridStep(score, q * DIV);
  const r = (pos - q * DIV) / step;
  const k = mode === 'floor' ? Math.floor(r + 1e-9) : mode === 'ceil' ? Math.ceil(r - 1e-9) : Math.round(r);
  return Math.max(0, q * DIV + Math.min(DIV, k * step));
}

/** Lengths offered at a position on this level (Easy: no 16ths or triplets). */
export function lengthsAt(score: Score, on: number, triplet = false): number[] {
  const base = score.level === 'easy' ? LENGTHS.filter((l) => l % 6 === 0) : LENGTHS;
  const inTriplet = score.tripletQuarters.has(Math.floor(on / DIV));
  if (score.level !== 'easy' && !score.time.compound && (inTriplet || (triplet && on % DIV === 0))) return [4, 8, ...base].sort((a, b) => a - b);
  return base;
}

/** Where a note is written: its pin while valid, else its written note, else its quantized place. */
export function spanOf(ctx: SheetCtx, n: Note): { on: number; off: number } {
  if (ctx.song.sheet && pinValid(n) && n.pin!.off > n.pin!.on) return { on: n.pin!.on, off: n.pin!.off };
  const w = writtenSpan(ctx.score, n.id);
  if (w) return { on: w.on, off: w.off };
  const t = ctx.score.time;
  const on = snapPos(ctx.score, t.toPos(n.start));
  return { on, off: Math.max(on + gridStep(ctx.score, on), snapPos(ctx.score, t.toPos(n.start + n.dur))) };
}

const writtenStaff = (n: Note): Staff => (n.hand === 'L' ? 2 : 1);

/** The note placed at written positions: seconds from the grid, pinned there. */
export function placeAt(ctx: SheetCtx, n: Note, on: number, off: number): Note {
  const t = ctx.score.time;
  const start = t.posToTime(on);
  const dur = Math.max(0.01, t.posToTime(off) - start);
  if (n.art?.length) {
    // articulations sound from the new written length
    const base = { dur, vel: n.artBase?.vel ?? n.vel };
    const snd = articulatedSound(base, n.art, dur);
    return { ...n, start, dur: snd.dur, vel: snd.vel, artBase: base, pin: { on, off, t: start, d: snd.dur } };
  }
  return { ...n, start, dur, pin: { on, off, t: start, d: dur } };
}

/** The note pinned where it is written now, its sound unchanged. */
function pinHere(ctx: SheetCtx, n: Note): Note {
  const { on, off } = spanOf(ctx, n);
  return { ...n, pin: { on, off, t: n.start, d: n.dur } };
}

/** The note cut to end at a written position (its start kept). */
function cutAt(ctx: SheetCtx, n: Note, span: { on: number }, off: number): Note {
  const end = ctx.score.time.posToTime(off);
  const dur = Math.max(0.01, end - n.start);
  return { ...n, dur, pin: { on: span.on, off, t: n.start, d: dur } };
}

/**
 * Same hand and pitch never overlap (the earlier note is cut where the later starts; one covered
 * entirely is removed), matching what the sheet writes. Easy (one voice): a touched note also cuts
 * a same-hand note sounding into its start, and is itself cut at the next onset of its hand.
 */
export function resolveOverlaps(ctx: SheetCtx, notes: Note[], touched: Set<number>): Note[] {
  const out = notes.map((n) => n);
  const span = new Map<number, { on: number; off: number }>();
  const sp = (n: Note) => {
    let s = span.get(n.id);
    // a note this edit placed is where its new pin says, also on a song's first edit (its grid lock
    // comes in the same step, so spanOf would still read the old place)
    if (!s) span.set(n.id, (s = touched.has(n.id) && pinValid(n) && n.pin!.off > n.pin!.on ? { on: n.pin!.on, off: n.pin!.off } : spanOf(ctx, n)));
    return s;
  };
  const removed = new Set<number>();
  const easy = ctx.level === 'easy';
  const tIdx = out.map((n, i) => (touched.has(n.id) ? i : -1)).filter((i) => i >= 0);
  tIdx.sort((a, b) => sp(out[a]).on - sp(out[b]).on);
  for (const ti of tIdx) {
    let T = out[ti];
    if (removed.has(T.id)) continue;
    const ts = sp(T);
    for (let i = 0; i < out.length; i++) {
      const O = out[i];
      if (i === ti || removed.has(O.id) || O.hand !== T.hand) continue;
      const os = sp(O);
      const samePitch = O.midi === T.midi;
      if (!samePitch && !easy) continue;
      if (!samePitch && os.on === ts.on) continue; // chord tones
      if (os.on < ts.on && os.off > ts.on) {
        // O sounds into T's start: cut O there
        out[i] = cutAt(ctx, O, os, ts.on);
        span.set(O.id, { on: os.on, off: ts.on });
        touched.add(O.id);
      } else if (os.on >= ts.on && os.on < ts.off) {
        if (samePitch && (os.on === ts.on || os.off <= ts.off)) {
          removed.add(O.id);
        } else if (os.on > ts.on) {
          T = cutAt(ctx, T, ts, os.on);
          out[ti] = T;
          ts.off = os.on;
          span.set(T.id, { ...ts });
        }
      }
    }
  }
  return out.filter((n) => !removed.has(n.id));
}

/** Raises the duration when notes end past it: to the end of the measure the last one ends in. */
function durationFor(ctx: SheetCtx, notes: Note[]): number | undefined {
  let end = 0;
  for (const n of notes) end = Math.max(end, n.start + n.dur);
  if (end <= ctx.song.duration + 1e-6) return undefined;
  const t = ctx.score.time;
  const m = t.measureOf(Math.max(0, Math.ceil(t.toPos(end) - 1e-6) - 1));
  return Math.max(end, t.posToTime(t.measureStart(m + 1)));
}

function finish(ctx: SheetCtx, notes: Note[], touched: Set<number>, select?: number[]): SheetEditResult {
  const resolved = resolveOverlaps(ctx, notes, touched);
  const duration = durationFor(ctx, resolved);
  const alive = new Set(resolved.map((n) => n.id));
  return { notes: resolved, ...(duration !== undefined ? { duration } : {}), ...(select ? { select: select.filter((id) => alive.has(id)) } : {}) };
}

const arrNotes = (ctx: SheetCtx) => ctx.song.arrangements[ctx.level].notes;

/** Pitch: one step in the key (Up/Down), an octave, or a semitone; clamped to the piano (A0–C8). */
export function pitchOp(ctx: SheetCtx, ids: Set<number>, kind: 'step' | 'octave' | 'semi', dir: 1 | -1): SheetEditResult | null {
  if (!ids.size) return null;
  const touched = new Set<number>();
  const notes = arrNotes(ctx).map((n) => {
    if (!ids.has(n.id)) return n;
    const k = keyAt(ctx.score, ctx.score.time.measureOf(spanOf(ctx, n).on));
    const midi = kind === 'octave' ? n.midi + 12 * dir : kind === 'semi' ? n.midi + dir : stepInKey(n.midi, dir, k.fifths, k.minorTonic);
    touched.add(n.id);
    return { ...pinHere(ctx, n), midi: Math.max(21, Math.min(108, midi)) };
  });
  return finish(ctx, notes, touched, [...ids]);
}

/** Earlier / later: one grid step (or one beat); the written length is kept; never before the start. */
export function moveOp(ctx: SheetCtx, ids: Set<number>, dir: 1 | -1, beat = false): SheetEditResult | null {
  const sel = arrNotes(ctx).filter((n) => ids.has(n.id));
  if (!sel.length) return null;
  const spans = new Map(sel.map((n) => [n.id, spanOf(ctx, n)]));
  const first = Math.min(...[...spans.values()].map((s) => s.on));
  const t = ctx.score.time;
  // the step of the first selected note; the target snapped to the grid there
  const step = beat ? t.beatLen : gridStep(ctx.score, dir > 0 ? first : Math.max(0, first - 1));
  let target = snapPos(ctx.score, first + dir * step, dir > 0 ? 'ceil' : 'floor');
  if (target === first) target = snapPos(ctx.score, first + dir * (step + 1), dir > 0 ? 'ceil' : 'floor');
  if (target < 0) return null;
  const delta = target - first;
  if (!delta) return null;
  const touched = new Set<number>();
  const notes = arrNotes(ctx).map((n) => {
    const s = spans.get(n.id);
    if (!s) return n;
    touched.add(n.id);
    const on = Math.max(0, s.on + delta);
    const len = s.off - s.on;
    let off = on + len;
    if (snapPos(ctx.score, off) !== off) off = Math.max(on + gridStep(ctx.score, on), snapPos(ctx.score, off));
    return placeAt(ctx, n, on, off);
  });
  return finish(ctx, notes, touched, [...ids]);
}

export type LengthChange = { len: number } | { step: 1 | -1 } | { dot: true } | { triplet: true };

/** The new written length of a note for a length change, or null when it doesn't apply. */
export function newLength(ctx: SheetCtx, on: number, len: number, ch: LengthChange): number | null {
  if ('len' in ch) return ch.len;
  if ('step' in ch) {
    const list = [...new Set([...lengthsAt(ctx.score, on), ...(ctx.score.tripletQuarters.has(Math.floor(on / DIV)) && ctx.level !== 'easy' ? [4, 8] : [])])].sort((a, b) => a - b);
    if (ch.step > 0) return list.find((l) => l > len) ?? null;
    return [...list].reverse().find((l) => l < len) ?? null;
  }
  if ('dot' in ch) {
    const dotted = [9, 18, 36, 72];
    const v = dotted.includes(len) ? len / 1.5 : len * 1.5;
    if (!Number.isInteger(v) || (ctx.level === 'easy' && v % 6 !== 0) || v > 72) return null;
    return v;
  }
  if (ctx.level === 'easy' || ctx.score.time.compound) return null;
  const tri: Record<number, number> = { 12: 8, 6: 4, 8: 12, 4: 6 };
  const v = tri[len];
  if (!v) return null;
  if ((v === 4 || v === 8) && on % DIV !== 0 && !ctx.score.tripletQuarters.has(Math.floor(on / DIV))) return null;
  return v;
}

/** Length: a palette value, shorter / longer through the palette, dot on or off, triplet on or off. Following notes don't move. */
export function lengthOp(ctx: SheetCtx, ids: Set<number>, ch: LengthChange): SheetEditResult | null {
  const touched = new Set<number>();
  const notes = arrNotes(ctx).map((n) => {
    if (!ids.has(n.id)) return n;
    const s = spanOf(ctx, n);
    const len = newLength(ctx, s.on, s.off - s.on, ch);
    if (!len || len === s.off - s.on) return n;
    touched.add(n.id);
    return placeAt(ctx, n, s.on, s.on + len);
  });
  if (!touched.size) return null;
  return finish(ctx, notes, touched, [...ids]);
}

/** Deletes notes. */
export function deleteOp(ctx: SheetCtx, ids: Set<number>): SheetEditResult | null {
  const all = arrNotes(ctx);
  const notes = all.filter((n) => !ids.has(n.id));
  if (notes.length === all.length) return null;
  return { notes, select: [] };
}

/** The velocity a new note gets (no dynamics yet in this version: the level of the notes around it). */
function velocityNear(ctx: SheetCtx, start: number, hand: Hand, pos?: number): number {
  // the dynamic in force there, when the level has dynamics
  const lv = pos !== undefined ? levelAt(ctx.song.arrangements[ctx.level].marks, pos, hand) : null;
  if (lv !== null) return lv;
  let best: Note | null = null;
  for (const n of arrNotes(ctx)) if (n.hand === hand && (!best || Math.abs(n.start - start) < Math.abs(best.start - start))) best = n;
  return best && Math.abs(best.start - start) < 4 ? Math.round(best.vel * 100) / 100 : 0.7;
}

/** Adds a note at a written position (a chord tone when the staff already has a note starting there). */
export function addOp(ctx: SheetCtx, at: { pos: number; midi: number; staff: Staff; len: number }): SheetEditResult | null {
  const on = Math.max(0, at.pos);
  const off = on + Math.max(1, at.len);
  const hand: Hand = at.staff === 1 ? 'R' : 'L';
  const id = newNoteId();
  const start = ctx.score.time.posToTime(on);
  const base: Note = { id, midi: Math.max(21, Math.min(108, at.midi)), start, dur: 0.1, vel: velocityNear(ctx, start, hand, on), hand };
  const n = placeAt(ctx, base, on, off);
  return finish(ctx, [...arrNotes(ctx), n], new Set([id]), [id]);
}

/** Hand: swap, or set left / right (the note moves to the other staff); its place on the sheet is kept. */
export function handOp(ctx: SheetCtx, ids: Set<number>, hand: Hand | 'toggle'): SheetEditResult | null {
  const touched = new Set<number>();
  const notes = arrNotes(ctx).map((n) => {
    if (!ids.has(n.id)) return n;
    const h: Hand = hand === 'toggle' ? (n.hand === 'L' ? 'R' : 'L') : hand;
    if (h === n.hand) return n;
    touched.add(n.id);
    return { ...pinHere(ctx, n), hand: h };
  });
  if (!touched.size) return null;
  return finish(ctx, notes, touched, [...ids]);
}

/**
 * Tie: two selected notes of the same pitch and hand, the second starting where the first ends
 * (within one grid step), become one note. Untie: a note written as tied pieces splits at the piece
 * boundary nearest `at`.
 */
export function tieOp(ctx: SheetCtx, ids: Set<number>, at?: number): SheetEditResult | null {
  const sel = arrNotes(ctx).filter((n) => ids.has(n.id));
  if (sel.length === 2 && sel[0].midi === sel[1].midi && sel[0].hand === sel[1].hand) {
    const [a, b] = [...sel].sort((x, y) => spanOf(ctx, x).on - spanOf(ctx, y).on);
    const sa = spanOf(ctx, a);
    const sb = spanOf(ctx, b);
    if (Math.abs(sb.on - sa.off) > gridStep(ctx.score, sa.off)) return null;
    const end = b.start + b.dur;
    // articulations: staccato from b, the rest from a
    const art = [...new Set([...(a.art ?? []).filter((x) => x !== 'staccato'), ...(b.art ?? []).filter((x) => x === 'staccato')])];
    const { art: _a, artBase: _b, ...plain } = a;
    void _a;
    const aBase = { ...plain, dur: _b?.dur ?? a.dur, vel: _b?.vel ?? a.vel };
    const bEnd = b.start + (b.artBase?.dur ?? b.dur);
    let merged: Note = { ...aBase, dur: Math.max(0.01, bEnd - a.start), pin: { on: sa.on, off: sb.off, t: a.start, d: Math.max(0.01, bEnd - a.start) } };
    if (art.length) merged = placeAt(ctx, { ...merged, art }, sa.on, sb.off);
    void end;
    const notes = arrNotes(ctx)
      .filter((n) => n.id !== b.id)
      .map((n) => (n.id === a.id ? merged : n));
    return { ...finish(ctx, notes, new Set([a.id]), [a.id]), repoint: new Map([[b.id, a.id]]) };
  }
  if (sel.length !== 1) return null;
  const n = sel[0];
  const pieces = writtenIndex(ctx.score).byId.get(n.id) ?? [];
  const s = spanOf(ctx, n);
  const cuts = pieces.map((p) => p.pieceOn).filter((p) => p > s.on && p < s.off);
  if (!cuts.length) return null;
  const ref = at ?? (s.on + s.off) / 2;
  const cut = cuts.reduce((x, y) => (Math.abs(y - ref) < Math.abs(x - ref) ? y : x));
  const t = ctx.score.time;
  const first = cutAt(ctx, n, s, cut);
  const bStart = t.posToTime(cut);
  const bEnd = n.start + n.dur;
  const id = newNoteId();
  let second: Note = { ...n, id, start: bStart, dur: Math.max(0.01, bEnd - bStart), pin: { on: cut, off: s.off, t: bStart, d: Math.max(0.01, bEnd - bStart) } };
  // untie: staccato moves to the second note; fingering stays on the first
  delete second.finger;
  if (n.art?.length) {
    const aArt = n.art.filter((x) => x !== 'staccato');
    const bArt = n.art.filter((x) => x === 'staccato');
    const { art: _x, artBase: _y, ...plainB } = second;
    void _x;
    void _y;
    second = bArt.length ? placeAt(ctx, { ...plainB, vel: n.artBase?.vel ?? n.vel, art: bArt }, cut, s.off) : { ...plainB, vel: n.artBase?.vel ?? n.vel, dur: Math.max(0.01, t.posToTime(s.off) - bStart), pin: { on: cut, off: s.off, t: bStart, d: Math.max(0.01, t.posToTime(s.off) - bStart) } };
    const { art: _p, artBase: _q, ...plainA } = first;
    void _p;
    void _q;
    const firstPlain = { ...plainA, vel: n.artBase?.vel ?? n.vel };
    const notes = arrNotes(ctx).flatMap((x) => (x.id === n.id ? [aArt.length ? placeAt(ctx, { ...firstPlain, art: aArt }, s.on, cut) : firstPlain, second] : [x]));
    return finish(ctx, notes, new Set([n.id, id]), [n.id]);
  }
  const notes = arrNotes(ctx).flatMap((x) => (x.id === n.id ? [first, second] : [x]));
  return finish(ctx, notes, new Set([n.id, id]), [n.id]);
}

/** Whether the selection can be tied (two notes) or untied (one note written as tied pieces). */
export function tieState(ctx: SheetCtx, ids: Set<number>): 'tie' | 'untie' | null {
  const sel = arrNotes(ctx).filter((n) => ids.has(n.id));
  if (sel.length === 2 && sel[0].midi === sel[1].midi && sel[0].hand === sel[1].hand) {
    const [a, b] = [...sel].sort((x, y) => spanOf(ctx, x).on - spanOf(ctx, y).on);
    return Math.abs(spanOf(ctx, b).on - spanOf(ctx, a).off) <= gridStep(ctx.score, spanOf(ctx, a).off) ? 'tie' : null;
  }
  if (sel.length === 1) {
    const s = spanOf(ctx, sel[0]);
    return (writtenIndex(ctx.score).byId.get(sel[0].id) ?? []).some((p) => p.pieceOn > s.on && p.pieceOn < s.off) ? 'untie' : null;
  }
  return null;
}

/** Add bar: one more (empty) measure at the end. */
export function addBarOp(ctx: SheetCtx): SheetEditResult {
  const t = ctx.score.time;
  const bars = ctx.score.measureCount + 1;
  const end = t.posToTime(t.measureStart(bars));
  return { notes: arrNotes(ctx), bars, ...(end > ctx.song.duration ? { duration: end } : {}) };
}

/** The staff a note is written on. */
export { writtenStaff };

/**
 * A drag of selected notes: `steps` letters in the key (or `semis` semitones), and `delta`
 * divisions in time (snapped to the grid where the first note lands); lengths kept. One undo step.
 */
export function shiftOp(ctx: SheetCtx, ids: Set<number>, by: { steps?: number; semis?: number; delta?: number }): SheetEditResult | null {
  const sel = arrNotes(ctx).filter((n) => ids.has(n.id));
  if (!sel.length || (!by.steps && !by.semis && !by.delta)) return null;
  const spans = new Map(sel.map((n) => [n.id, spanOf(ctx, n)]));
  const first = Math.min(...[...spans.values()].map((s) => s.on));
  const delta = by.delta ? Math.max(-first, snapPos(ctx.score, first + by.delta) - first) : 0;
  const touched = new Set<number>();
  const notes = arrNotes(ctx).map((n) => {
    const s = spans.get(n.id);
    if (!s) return n;
    touched.add(n.id);
    let midi = n.midi;
    if (by.semis) midi += by.semis;
    else if (by.steps) {
      const k = keyAt(ctx.score, ctx.score.time.measureOf(s.on));
      for (let i = 0; i < Math.abs(by.steps); i++) midi = stepInKey(midi, by.steps > 0 ? 1 : -1, k.fifths, k.minorTonic);
    }
    midi = Math.max(21, Math.min(108, midi));
    if (!delta) return { ...pinHere(ctx, n), midi };
    const on = s.on + delta;
    let off = on + (s.off - s.on);
    if (snapPos(ctx.score, off) !== off) off = Math.max(on + gridStep(ctx.score, on), snapPos(ctx.score, off));
    return { ...placeAt(ctx, n, on, off), midi };
  });
  return finish(ctx, notes, touched, [...ids]);
}
