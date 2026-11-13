/**
 * Markings on the sheet as pure operations (lib/sheet/edit.ts style): fingering, articulations,
 * slurs, dynamics, hairpins, words and pedal of one level. Sound is baked into the notes in the
 * same undo step, so every consumer (piano roll, playback, practice, MIDI, WAV, video) agrees:
 * staccato / tenuto / marcato change `dur`, accent / marcato change `vel` (the values before are
 * kept in `artBase`, so removing the last articulation restores them exactly), and dynamics and
 * hairpins rewrite `vel`. Slurs, words and fingering are notation only.
 */
import type { Arrangement, Articulation, DynamicValue, Hand, Note, PedalRange, SheetMark } from '../music/types';
import { DYNAMIC_LEVEL, afterAccent, isAccentDynamic } from './dynamics';
import { spanOf, snapPos, gridStep, type SheetCtx } from './edit';
import { DIV } from './types';

/** A new marking id: 'm' + 8 base-36 characters (random; note ids are untouched). */
export function newMarkId(): string {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  return 'm' + [...b].map((x) => (x % 36).toString(36)).join('');
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round3 = (x: number) => Math.round(x * 1000) / 1000;

export interface MarkEditResult {
  notes?: Note[];
  marks?: SheetMark[];
  pedal?: PedalRange[];
  showPedal?: boolean;
  pedalEdited?: boolean;
  /** Notes / marking to select afterwards. */
  select?: number[];
  markSel?: string | null;
}

const marksOf = (ctx: SheetCtx) => ctx.song.arrangements[ctx.level].marks ?? [];
const notesOf = (ctx: SheetCtx) => ctx.song.arrangements[ctx.level].notes;

// ------------------------------------------------------------------ articulations

/** The sound of a note with articulations, from its values without them and its written length (s). */
export function articulatedSound(base: { dur: number; vel: number }, art: Articulation[], written: number): { dur: number; vel: number } {
  let dur = base.dur;
  let vel = base.vel;
  if (art.includes('tenuto')) dur = written;
  if (art.includes('marcato')) {
    dur = 0.8 * written;
    vel += 0.25;
  }
  if (art.includes('accent')) vel += 0.15;
  if (art.includes('staccato')) dur = Math.max(0.06, 0.5 * written);
  return { dur: Math.max(0.01, dur), vel: clamp(vel, 0, 1) };
}

/** Written length of a note in seconds. */
export function writtenSeconds(ctx: SheetCtx, n: Note): number {
  const s = spanOf(ctx, n);
  const t = ctx.score.time;
  return Math.max(0.01, t.posToTime(s.off) - t.posToTime(s.on));
}

/** A note with exactly these articulations (none: the sound before them is restored). Stays pinned where it is written. */
export function withArticulations(ctx: SheetCtx, n: Note, art: Articulation[]): Note {
  const span = spanOf(ctx, n);
  const base = { dur: n.artBase?.dur ?? n.dur, vel: n.artBase?.vel ?? n.vel };
  const { art: _a, artBase: _b, ...rest } = n;
  void _a;
  void _b;
  if (!art.length) return { ...rest, dur: base.dur, vel: base.vel, pin: { on: span.on, off: span.off, t: n.start, d: base.dur } };
  const t = ctx.score.time;
  const snd = articulatedSound(base, art, Math.max(0.01, t.posToTime(span.off) - t.posToTime(span.on)));
  return { ...rest, dur: snd.dur, vel: snd.vel, art: [...art], artBase: base, pin: { on: span.on, off: span.off, t: n.start, d: snd.dur } };
}

/** A note whose sound without articulations is now `vel` (articulations re-applied on top). */
function withBaseVel(n: Note, vel: number): Note {
  const v = round3(clamp(vel, 0.05, 1));
  if (!n.art?.length || !n.artBase) return { ...n, vel: v };
  const accent = (n.art.includes('accent') ? 0.15 : 0) + (n.art.includes('marcato') ? 0.25 : 0);
  return { ...n, vel: clamp(v + accent, 0, 1), artBase: { ...n.artBase, vel: v } };
}
const baseVel = (n: Note) => n.artBase?.vel ?? n.vel;

/** Articulation on or off for the selection (off when every selected note has it). */
export function articulationOp(ctx: SheetCtx, ids: Set<number>, a: Articulation): MarkEditResult | null {
  const sel = notesOf(ctx).filter((n) => ids.has(n.id));
  if (!sel.length) return null;
  const on = !sel.every((n) => n.art?.includes(a));
  const notes = notesOf(ctx).map((n) => {
    if (!ids.has(n.id)) return n;
    let art = (n.art ?? []).filter((x) => x !== a);
    if (on) art = [...art, a];
    // staccato and tenuto, accent and marcato don't go together
    if (on && a === 'staccato') art = art.filter((x) => x !== 'tenuto');
    if (on && a === 'tenuto') art = art.filter((x) => x !== 'staccato');
    if (on && a === 'marcato') art = art.filter((x) => x !== 'accent');
    if (on && a === 'accent') art = art.filter((x) => x !== 'marcato');
    return withArticulations(ctx, n, art);
  });
  return { notes, select: [...ids] };
}

// ------------------------------------------------------------------ fingering

/** Fingering 1–5 for the selection (0, or the number every selected note already has: cleared). */
export function fingerOp(ctx: SheetCtx, ids: Set<number>, f: 0 | 1 | 2 | 3 | 4 | 5): MarkEditResult | null {
  const sel = notesOf(ctx).filter((n) => ids.has(n.id));
  if (!sel.length) return null;
  const clear = f === 0 || sel.every((n) => n.finger === f);
  const notes = notesOf(ctx).map((n) => {
    if (!ids.has(n.id)) return n;
    const { finger: _f, ...rest } = n;
    void _f;
    return clear ? rest : { ...rest, finger: f as 1 | 2 | 3 | 4 | 5 };
  });
  return { notes, select: [...ids] };
}

// ------------------------------------------------------------------ slurs

/** A slur over the selection per hand (first to last selected note); the same slur again removes it. */
export function slurOp(ctx: SheetCtx, ids: Set<number>): MarkEditResult | null {
  const sel = notesOf(ctx).filter((n) => ids.has(n.id));
  const marks = [...marksOf(ctx)];
  let changed = false;
  for (const hand of ['R', 'L'] as Hand[]) {
    const ns = sel.filter((n) => n.hand === hand).map((n) => ({ n, s: spanOf(ctx, n) }));
    if (ns.length < 2) continue;
    ns.sort((a, b) => a.s.on - b.s.on || a.n.midi - b.n.midi);
    const first = hand === 'R' ? ns.filter((x) => x.s.on === ns[0].s.on).at(-1)! : ns[0];
    const lastOn = Math.max(...ns.map((x) => x.s.on));
    const lasts = ns.filter((x) => x.s.on === lastOn);
    const last = hand === 'R' ? lasts.at(-1)! : lasts[0];
    if (first.s.on === last.s.on) continue;
    const same = marks.findIndex((m) => m.kind === 'slur' && m.from === first.n.id && m.to === last.n.id);
    if (same >= 0) marks.splice(same, 1);
    else marks.push({ id: newMarkId(), kind: 'slur', from: first.n.id, to: last.n.id, ...(hand === 'L' ? { below: true } : {}) });
    changed = true;
  }
  return changed ? { marks } : null;
}

/** Marks without slurs that lost a note (deleted), and slurs re-pointed (a tie merged b into a). */
export function fixSlurs(marks: SheetMark[] | undefined, notes: Note[], repoint?: Map<number, number>): SheetMark[] | undefined {
  if (!marks?.length) return marks;
  const hands = new Map(notes.map((n) => [n.id, n.hand]));
  let changed = false;
  const out: SheetMark[] = [];
  for (const m of marks) {
    if (m.kind !== 'slur') {
      out.push(m);
      continue;
    }
    const from = repoint?.get(m.from) ?? m.from;
    const to = repoint?.get(m.to) ?? m.to;
    if (from === to || !hands.has(from) || hands.get(from) !== hands.get(to)) {
      changed = true;
      continue;
    }
    if (from !== m.from || to !== m.to) {
      changed = true;
      out.push({ ...m, from, to });
    } else out.push(m);
  }
  return changed ? out : marks;
}

// ------------------------------------------------------------------ positions of new marks

/** Where a marking for the selection goes: the first selected onset to the end of the last note; staff 1 / 2, or 0 for both hands. */
export function selectionSpan(ctx: SheetCtx, ids: Set<number>, cursorMeasure: number): { pos: number; end: number; staff: 0 | 1 | 2; hands: Hand[] } {
  const sel = notesOf(ctx).filter((n) => ids.has(n.id));
  if (!sel.length) {
    const t = ctx.score.time;
    const m = Math.max(0, Math.min(ctx.score.measureCount - 1, cursorMeasure));
    return { pos: t.measureStart(m), end: t.measureStart(m + 1), staff: 0, hands: ['R', 'L'] };
  }
  const spans = sel.map((n) => spanOf(ctx, n));
  const hands = [...new Set(sel.map((n) => n.hand))];
  return {
    pos: Math.min(...spans.map((s) => s.on)),
    end: Math.max(...spans.map((s) => s.off)),
    staff: hands.length === 1 ? (hands[0] === 'R' ? 1 : 2) : 0,
    hands,
  };
}

const appliesTo = (staff: 0 | 1 | 2, hand: Hand) => staff === 0 || (staff === 1) === (hand === 'R');
const isLevel = (m: SheetMark): m is Extract<SheetMark, { kind: 'dyn' }> => m.kind === 'dyn' && (!isAccentDynamic(m.value) || m.value === 'fp');
const levelOf = (m: Extract<SheetMark, { kind: 'dyn' }>) => (m.value === 'fp' ? afterAccent('fp')! : DYNAMIC_LEVEL[m.value]);

/** The loudness level in force at a position for a hand (the last level dynamic at or before it), or null. */
export function levelAt(marks: SheetMark[] | undefined, pos: number, hand: Hand): number | null {
  let best: Extract<SheetMark, { kind: 'dyn' }> | null = null;
  for (const m of marks ?? []) if (isLevel(m) && appliesTo(m.staff, hand) && m.pos <= pos && (!best || m.pos >= best.pos)) best = m;
  return best ? levelOf(best) : null;
}

/** The next level dynamic after a position for a hand (its pos), or Infinity. */
function nextLevelPos(marks: SheetMark[], pos: number, hand: Hand, inclusive = false): number {
  let p = Infinity;
  for (const m of marks) if (isLevel(m) && appliesTo(m.staff, hand) && (inclusive ? m.pos >= pos : m.pos > pos)) p = Math.min(p, m.pos);
  return p;
}

const onsetOf = (ctx: SheetCtx, n: Note) => spanOf(ctx, n).on;

// ------------------------------------------------------------------ dynamics

/**
 * Bakes a dynamic into the velocities: from its position up to the next level dynamic of each hand
 * it applies to, vel' = clamp(L + 0.5 × (vel − mean), 0.05, 1) (the mean of those notes, so the
 * shape of the phrase stays). sf / sfz change only the notes struck at it; fp strikes them at
 * .75 and continues at p.
 */
export function bakeDynamic(ctx: SheetCtx, notes: Note[], marks: SheetMark[], d: Extract<SheetMark, { kind: 'dyn' }>): Note[] {
  const hands: Hand[] = d.staff === 0 ? ['R', 'L'] : [d.staff === 1 ? 'R' : 'L'];
  const ends = new Map(hands.map((h) => [h, nextLevelPos(marks, d.pos, h)]));
  const struck = (n: Note, on: number) => hands.includes(n.hand) && on === d.pos;
  const on = new Map(notes.map((n) => [n.id, onsetOf(ctx, n)]));
  if (isAccentDynamic(d.value)) {
    const after = afterAccent(d.value);
    const region = after === null ? [] : notes.filter((n) => hands.includes(n.hand) && on.get(n.id)! > d.pos && on.get(n.id)! < ends.get(n.hand)!);
    const mean = region.length ? region.reduce((a, n) => a + baseVel(n), 0) / region.length : 0;
    const inRegion = new Set(region.map((n) => n.id));
    return notes.map((n) => {
      if (struck(n, on.get(n.id)!)) return withBaseVel(n, DYNAMIC_LEVEL[d.value]);
      if (inRegion.has(n.id)) return withBaseVel(n, after! + 0.5 * (baseVel(n) - mean));
      return n;
    });
  }
  const L = DYNAMIC_LEVEL[d.value];
  const region = notes.filter((n) => hands.includes(n.hand) && on.get(n.id)! >= d.pos && on.get(n.id)! < ends.get(n.hand)!);
  if (!region.length) return notes;
  const mean = region.reduce((a, n) => a + baseVel(n), 0) / region.length;
  const ids = new Set(region.map((n) => n.id));
  return notes.map((n) => (ids.has(n.id) ? withBaseVel(n, L + 0.5 * (baseVel(n) - mean)) : n));
}

/**
 * Bakes a hairpin: a linear ramp over [pos, end) from the level in force to the next dynamic at or
 * after its end (without one: ±0.12), keeping each note's offset from the mean at half size.
 */
export function bakeWedge(ctx: SheetCtx, notes: Note[], marks: SheetMark[], w: Extract<SheetMark, { kind: 'wedge' }>): Note[] {
  const hands: Hand[] = w.staff === 0 ? ['R', 'L'] : [w.staff === 1 ? 'R' : 'L'];
  const on = new Map(notes.map((n) => [n.id, onsetOf(ctx, n)]));
  const region = notes.filter((n) => hands.includes(n.hand) && on.get(n.id)! >= w.pos && on.get(n.id)! < w.end);
  if (!region.length) return notes;
  const mean = region.reduce((a, n) => a + baseVel(n), 0) / region.length;
  const out = new Map<number, Note>();
  for (const h of hands) {
    const rs = region.filter((n) => n.hand === h);
    if (!rs.length) continue;
    const L0 = levelAt(marks, w.pos, h) ?? mean;
    const nextPos = nextLevelPos(marks, w.end, h, true);
    const next = Number.isFinite(nextPos) ? marks.find((m) => isLevel(m) && m.pos === nextPos && appliesTo(m.staff, h)) : undefined;
    const L1 = next && next.kind === 'dyn' ? levelOf(next) : clamp(L0 + (w.dir === 'cresc' ? 0.12 : -0.12), 0.05, 1);
    for (const n of rs) {
      const f = (on.get(n.id)! - w.pos) / (w.end - w.pos);
      out.set(n.id, withBaseVel(n, L0 + f * (L1 - L0) + 0.5 * (baseVel(n) - mean)));
    }
  }
  return notes.map((n) => out.get(n.id) ?? n);
}

/** A dynamic at the first selected onset (staff of the selection; both hands: 0), replacing one there. Optionally baked into the sound. */
export function dynamicOp(ctx: SheetCtx, ids: Set<number>, value: DynamicValue, opts: { bake: boolean; cursorMeasure: number }): MarkEditResult {
  const sp = selectionSpan(ctx, ids, opts.cursorMeasure);
  const marks = marksOf(ctx).filter((m) => !(m.kind === 'dyn' && m.pos === sp.pos && (m.staff === sp.staff || m.staff === 0 || sp.staff === 0)));
  const d: SheetMark = { id: newMarkId(), kind: 'dyn', pos: sp.pos, staff: sp.staff, value };
  marks.push(d);
  return { marks, ...(opts.bake ? { notes: bakeDynamic(ctx, notesOf(ctx), marks, d) } : {}), markSel: d.id };
}

/** A crescendo / diminuendo hairpin over the selection (no selection: the measure at the cursor). */
export function wedgeOp(ctx: SheetCtx, ids: Set<number>, dir: 'cresc' | 'dim', opts: { bake: boolean; cursorMeasure: number }): MarkEditResult | null {
  const sp = selectionSpan(ctx, ids, opts.cursorMeasure);
  if (sp.end <= sp.pos) return null;
  const marks = [...marksOf(ctx)];
  const w: SheetMark = { id: newMarkId(), kind: 'wedge', pos: sp.pos, end: sp.end, staff: sp.staff, dir };
  marks.push(w);
  return { marks, ...(opts.bake ? { notes: bakeWedge(ctx, notesOf(ctx), marks, w) } : {}), markSel: w.id };
}

/** Words at the first selected onset (above the treble staff, or the bass staff for left-hand notes). */
export function textOp(ctx: SheetCtx, ids: Set<number>, text: string, opts: { above?: boolean; style?: 'italic' | 'bold' | null; cursorMeasure: number; staff?: 1 | 2 }): MarkEditResult | null {
  const clean = text.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim().slice(0, 80);
  if (!clean) return null;
  const sp = selectionSpan(ctx, ids, opts.cursorMeasure);
  const staff = opts.staff ?? (sp.staff === 2 ? 2 : 1);
  const m: SheetMark = { id: newMarkId(), kind: 'text', pos: sp.pos, staff, text: clean, above: opts.above ?? staff === 1, ...(opts.style ? { style: opts.style } : {}) };
  return { marks: [...marksOf(ctx), m], markSel: m.id };
}

/** Changes a marking (its value, words, direction …) in place. */
export function updateMarkOp(ctx: SheetCtx, id: string, patch: Partial<SheetMark>, opts?: { bake?: boolean }): MarkEditResult | null {
  const marks = marksOf(ctx);
  const i = marks.findIndex((m) => m.id === id);
  if (i < 0) return null;
  const next = { ...marks[i], ...patch, id, kind: marks[i].kind } as SheetMark;
  if (next.kind === 'text') {
    const t = next.text.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim().slice(0, 80);
    if (!t) return null;
    next.text = t;
  }
  const out = marks.map((m, j) => (j === i ? next : m));
  let notes: Note[] | undefined;
  if (opts?.bake && next.kind === 'dyn') notes = bakeDynamic(ctx, notesOf(ctx), out, next);
  if (opts?.bake && next.kind === 'wedge') notes = bakeWedge(ctx, notesOf(ctx), out, next);
  return { marks: out, ...(notes ? { notes } : {}), markSel: id };
}

// ------------------------------------------------------------------ pedal

/** Pedal over the selection (first onset to the end of the last note), cutting pedal it overlaps. Shows pedal marks. */
export function pedalOp(ctx: SheetCtx, ids: Set<number>, cursorMeasure: number): MarkEditResult | null {
  const sp = selectionSpan(ctx, ids, cursorMeasure);
  const t = ctx.score.time;
  const start = t.posToTime(sp.pos);
  const end = t.posToTime(sp.end);
  if (!(end > start)) return null;
  const arr = ctx.song.arrangements[ctx.level];
  const out: PedalRange[] = [];
  for (const p of arr.pedal) {
    if (p.end <= start || p.start >= end) out.push(p);
    else {
      // the old pedal is released where the new one is pressed (and pressed again after it)
      if (p.start < start) out.push({ start: p.start, end: start });
      if (p.end > end) out.push({ start: end, end: p.end });
    }
  }
  out.push({ start, end });
  out.sort((a, b) => a.start - b.start);
  return { pedal: out, showPedal: true, pedalEdited: true, markSel: pedalSel({ start, end }) };
}

/** The selection id of a pedal range. */
export const pedalSel = (p: PedalRange) => `pedal:${p.start.toFixed(4)}`;

// ------------------------------------------------------------------ selected marks: move, delete

/** A selected marking: a SheetMark id, or 'pedal:…', 'key:pos', 'time:pos', 'tempo:pos'. */
export type MarkRef = { type: 'mark'; mark: SheetMark } | { type: 'pedal'; index: number; range: PedalRange } | { type: 'key' | 'time' | 'tempo'; pos: number };

export function resolveMark(ctx: SheetCtx, sel: string | null): MarkRef | null {
  if (!sel) return null;
  if (sel.startsWith('pedal:')) {
    const pedal = ctx.song.arrangements[ctx.level].pedal;
    const i = pedal.findIndex((p) => pedalSel(p) === sel);
    return i >= 0 ? { type: 'pedal', index: i, range: pedal[i] } : null;
  }
  const m = /^(key|time|tempo):(\d+)$/.exec(sel);
  if (m) {
    const pos = Number(m[2]);
    const sh = ctx.song.sheet;
    const list = m[1] === 'key' ? sh?.keys : m[1] === 'time' ? sh?.meters : sh?.tempos;
    return list?.some((x) => x.pos === pos) ? { type: m[1] as 'key', pos } : null;
  }
  const mark = marksOf(ctx).find((x) => x.id === sel);
  return mark ? { type: 'mark', mark } : null;
}

/** Deletes the selected marking of this level (dynamics stay baked in the velocities: Undo restores them). */
export function deleteMarkOp(ctx: SheetCtx, sel: string): MarkEditResult | null {
  const r = resolveMark(ctx, sel);
  if (!r) return null;
  if (r.type === 'mark') return { marks: marksOf(ctx).filter((m) => m.id !== r.mark.id), markSel: null };
  if (r.type === 'pedal') return { pedal: ctx.song.arrangements[ctx.level].pedal.filter((_, i) => i !== r.index), pedalEdited: true, markSel: null };
  return null; // key / time / tempo: song level (state/sheetMarks.ts)
}

/** Moves the selected marking one grid step earlier / later (`end`: a hairpin's or pedal's end instead of its start). */
export function moveMarkOp(ctx: SheetCtx, sel: string, dir: 1 | -1, end = false): MarkEditResult | null {
  const r = resolveMark(ctx, sel);
  if (!r) return null;
  const step = (p: number) => {
    const g = gridStep(ctx.score, dir > 0 ? p : Math.max(0, p - 1));
    return snapPos(ctx.score, p + dir * g, dir > 0 ? 'ceil' : 'floor');
  };
  if (r.type === 'mark') {
    const m = r.mark;
    let next: SheetMark;
    if (m.kind === 'slur') return null;
    if (m.kind === 'wedge') {
      const pos = end ? m.pos : Math.max(0, step(m.pos));
      const e = end ? Math.max(m.pos + 1, step(m.end)) : m.end;
      if (pos >= e) return null;
      next = { ...m, pos, end: e };
    } else next = { ...m, pos: Math.max(0, step(m.pos)) };
    return { marks: marksOf(ctx).map((x) => (x.id === m.id ? next : x)), markSel: m.id };
  }
  if (r.type === 'pedal') {
    const t = ctx.score.time;
    const p = r.range;
    const a = Math.max(0, Math.round(t.toPos(p.start)));
    const b = Math.round(t.toPos(p.end));
    const na = end ? a : Math.max(0, step(a));
    const nb = end ? step(b) : b;
    if (nb <= na) return null;
    const range = { start: t.posToTime(na), end: t.posToTime(nb) };
    const pedal = ctx.song.arrangements[ctx.level].pedal.map((x, i) => (i === r.index ? range : x)).sort((x, y) => x.start - y.start);
    return { pedal, pedalEdited: true, markSel: pedalSel(range) };
  }
  return null;
}

// ------------------------------------------------------------------ Easy & Medium from Hard

/**
 * Carries the markings of Hard over to a level derived from it: fingering and articulations to
 * notes of the same pitch and hand starting within 1 ms; dynamics, hairpins and words by position;
 * slurs only when both their notes match; pedal only when it was edited on the sheet. Pins are not
 * copied (the derived notes are written on their own level's grid).
 */
export function carryMarks(hard: Arrangement, derived: Arrangement): Arrangement {
  const key = (n: Note) => `${n.hand}|${n.midi}`;
  const byKey = new Map<string, Note[]>();
  for (const n of derived.notes) {
    let a = byKey.get(key(n));
    if (!a) byKey.set(key(n), (a = []));
    a.push(n);
  }
  const match = new Map<number, number>(); // hard id → derived id
  const patch = new Map<number, Partial<Note>>();
  for (const h of hard.notes) {
    const d = byKey.get(key(h))?.find((x) => Math.abs(x.start - h.start) < 0.001);
    if (!d) continue;
    match.set(h.id, d.id);
    if (!h.finger && !h.art?.length) continue;
    patch.set(d.id, {
      ...(h.finger ? { finger: h.finger } : {}),
      ...(h.art?.length ? { art: [...h.art], ...(h.artBase ? { artBase: { ...h.artBase } } : {}) } : {}),
    });
  }
  const notes = patch.size ? derived.notes.map((n) => (patch.has(n.id) ? { ...n, ...patch.get(n.id) } : n)) : derived.notes;
  const marks: SheetMark[] = [];
  for (const m of hard.marks ?? []) {
    if (m.kind === 'slur') {
      const from = match.get(m.from);
      const to = match.get(m.to);
      if (from !== undefined && to !== undefined) marks.push({ ...m, id: newMarkId(), from, to });
    } else marks.push({ ...m, id: newMarkId() });
  }
  const out: Arrangement = { ...derived, notes };
  if (marks.length) out.marks = marks;
  if (hard.pedalEdited) {
    out.pedal = hard.pedal.map((p) => ({ ...p }));
    out.pedalEdited = true;
  }
  if (hard.showPedal) out.showPedal = true;
  return out;
}

/** Quarters → divisions. */
export const qToDiv = (q: number) => Math.round(q * DIV);
