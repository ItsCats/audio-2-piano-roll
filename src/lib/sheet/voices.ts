/**
 * Splits the quantized notes of one staff into at most two voices of chords: voice 1 (upper,
 * stems up) and voice 2 (lower, stems down). Every input note appears in exactly one chord.
 */
import { DIV, type Chord, type QNote, type SheetLevelRules, type Staff } from './types';

function lowerBoundAbove(xs: number[], t: number): number {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m] <= t) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/**
 * Legato trimming: a note still sounding when the next onset of the staff arrives is cut there,
 * if it ends at most `maxOverhang` later and does not span two or more later onsets (those are
 * real held notes and stay).
 */
export function trimLegato(notes: QNote[], maxOverhang: number): QNote[] {
  const onsets = [...new Set(notes.map((n) => n.on))].sort((a, b) => a - b);
  return notes.map((a) => {
    if (a.pinned) return a;
    const i = lowerBoundAbove(onsets, a.on);
    const b = onsets[i];
    if (b === undefined || a.off <= b) return a;
    const second = onsets[i + 1];
    if (second !== undefined && second < a.off) return a;
    if (a.off - b > maxOverhang) return a;
    return { ...a, off: b };
  });
}

/** A chord of notes (ascending), with their Song note ids; pinned when any note is. */
export function chordOf(on: number, off: number, ns: QNote[]): Chord {
  const s = [...ns].sort((a, b) => a.midi - b.midi);
  const c: Chord = { on, off, midis: s.map((n) => n.midi), srcByMidi: s.map((n) => n.src ?? []) };
  if (s.some((n) => n.pinned)) {
    c.pinned = true;
    // tones that end earlier than the pinned chord keep their own written end (tied segments)
    const ends = s.map((n) => (n.off > on ? Math.min(n.off, off) : off));
    if (ends.some((e) => e !== off)) c.ends = ends;
  }
  return c;
}

/** Longest end of the pinned notes (undefined: none pinned). */
const pinnedEnd = (ns: QNote[]) => {
  let e: number | undefined;
  for (const n of ns) if (n.pinned) e = Math.max(e ?? -Infinity, n.off);
  return e;
};

/** Joins chord tones (union by pitch, ids merged). */
function joinInto(m: Chord, c: Chord): void {
  if (m.ends || c.ends) {
    const end = (x: Chord, i: number) => x.ends?.[i] ?? x.off;
    const ends = new Map<number, number>();
    m.midis.forEach((x, i) => ends.set(x, end(m, i)));
    c.midis.forEach((x, i) => ends.set(x, Math.max(ends.get(x) ?? 0, end(c, i))));
    const midis = [...ends.keys()].sort((a, b) => a - b);
    m.ends = midis.map((x) => ends.get(x)!);
  }
  const ids = new Map<number, number[]>();
  m.midis.forEach((x, i) => ids.set(x, [...(m.srcByMidi?.[i] ?? [])]));
  c.midis.forEach((x, i) => ids.set(x, [...(ids.get(x) ?? []), ...(c.srcByMidi?.[i] ?? [])]));
  m.midis = [...ids.keys()].sort((a, b) => a - b);
  m.srcByMidi = m.midis.map((x) => ids.get(x)!);
  if (c.pinned) m.pinned = true;
}

const endOf = (c: Chord, i: number) => c.ends?.[i] ?? c.off;

/** Whether chord c can join held chord p at t (p started before t, no shared pitch still sounding). */
function canJoin(p: Chord, t: number, c: Chord): boolean {
  if (!(p.on < t)) return false;
  return !p.midis.some((m, i) => endOf(p, i) > t && c.midis.includes(m));
}

/**
 * Ends held chord p at t and returns the chord from t: p's tones still sounding (tied over) with the
 * tones of c, each keeping its written end.
 */
function joinHeld(p: Chord, t: number, c: Chord): Chord {
  const tones: { midi: number; src: number[]; end: number }[] = [];
  const tied: number[] = [];
  p.midis.forEach((m, i) => {
    const e = endOf(p, i);
    if (e > t) {
      tones.push({ midi: m, src: p.srcByMidi?.[i] ?? [], end: e });
      tied.push(m);
    }
  });
  c.midis.forEach((m, i) => tones.push({ midi: m, src: c.srcByMidi?.[i] ?? [], end: Math.max(t + 1, endOf(c, i)) }));
  tones.sort((a, b) => a.midi - b.midi);
  const off = Math.max(...tones.map((x) => x.end));
  const q: Chord = { on: t, off, midis: tones.map((x) => x.midi), srcByMidi: tones.map((x) => x.src), pinned: true, tieIn: tied, prev: p };
  if (tones.some((x) => x.end !== off)) q.ends = tones.map((x) => x.end);
  p.off = t;
  p.tieOut = tied;
  if (p.ends) {
    p.ends = p.ends.map((e) => Math.min(e, t));
    if (p.ends.every((e) => e === t)) delete p.ends;
  }
  return q;
}

const top = (c: Chord) => c.midis[c.midis.length - 1];
const bottom = (c: Chord) => c.midis[0];

/** One or two parts of an onset group (two only when the top notes end differently and don't cross the rest). */
function groupParts(g: QNote[], t: number, split: boolean): Chord[] {
  const ends = new Set(g.map((n) => n.off));
  if (ends.size === 1) return [chordOf(t, g[0].off, g)];
  const minEnd = Math.min(...ends);
  if (split) {
    const hi = g.reduce((a, b) => (b.midi > a.midi ? b : a));
    const upper = g.filter((n) => n.off === hi.off);
    const lower = g.filter((n) => n.off !== hi.off);
    if (Math.min(...upper.map((n) => n.midi)) > Math.max(...lower.map((n) => n.midi))) {
      return [chordOf(t, hi.off, upper), chordOf(t, pinnedEnd(lower) ?? Math.min(...lower.map((n) => n.off)), lower)];
    }
  }
  return [chordOf(t, pinnedEnd(g) ?? minEnd, g)];
}

export interface VoiceContext {
  beatLen: number;
  /** Whether a position is on a beat (relative to its measure). */
  isBeat: (pos: number) => boolean;
  tripletQuarters: Set<number>;
}

export function assignVoices(notesIn: QNote[], _staff: Staff, rules: SheetLevelRules, ctx: VoiceContext): [Chord[], Chord[]] {
  const beatLen = ctx.beatLen;
  const notes = trimLegato(notesIn, Math.max(beatLen, 6));
  const groups = new Map<number, QNote[]>();
  for (const n of notes) {
    let g = groups.get(n.on);
    if (!g) groups.set(n.on, (g = []));
    g.push(n);
  }
  const mode = rules.secondVoice;
  const v: [Chord[], Chord[]] = [[], []];
  const last = (i: number) => v[i][v[i].length - 1] as Chord | undefined;
  const busy = (i: number) => last(i)?.off ?? -Infinity;
  const cut = (i: number, t: number) => {
    const l = last(i);
    if (l && l.off > t) l.off = t;
  };
  // Medium too: a held note or chord keeps its length in its own voice under or over moving notes
  // (otherwise it would be written short and read as staccato)
  const allowUnder = mode !== 'never';
  const allowOver = mode !== 'never';
  /** How much held music (quarters × notes) cutting voice i at t would lose. */
  /** Voice i holds a pinned chord past t (pins are never cut on Medium and Hard). */
  const pinBusy = (i: number, t: number) => mode !== 'never' && !!last(i)?.pinned && busy(i) > t;
  const cutLoss = (i: number, t: number) => {
    const l = last(i);
    return l && l.off > t ? ((l.off - t) / DIV) * l.midis.length : 0;
  };
  /** Places one chord (or only measures what it would cut, with apply = false). */
  const placeOne = (c: Chord, t: number, apply: boolean): number => {
    const f0 = busy(0) <= t;
    const f1 = busy(1) <= t;
    let cuts: number[] = [];
    let into = 0;
    let swap = false;
    if (f0) {
      const l1 = last(1);
      if (!f1 && l1 && !(bottom(c) > top(l1))) cuts = [1];
    } else {
      const held = last(0)!;
      if (f1 && allowUnder && top(c) < bottom(held)) into = 1;
      else if (f1 && allowOver && bottom(c) > top(held) && busy(1) <= held.on) swap = true;
      else if (!f1) {
        const l1 = last(1)!;
        const above = bottom(c) > top(l1);
        const below = top(c) < bottom(held);
        // between the two held voices: one must stop; keep the one with more left to sound
        if (above && below) [cuts, into] = cutLoss(0, t) <= cutLoss(1, t) ? [[0], 0] : [[1], 1];
        else if (above) cuts = [0];
        else if (below) [cuts, into] = [[1], 1];
        else cuts = [0, 1];
      } else cuts = [0];
    }
    // a pinned held chord is never cut: the new chord goes to the other voice (cutting that one if
    // it isn't pinned too), or the voices cross
    for (const i of [0, 1]) {
      if (!cuts.includes(i) || !pinBusy(i, t)) continue;
      if (into !== i) cuts = cuts.filter((x) => x !== i);
      else if (!pinBusy(1 - i, t)) {
        into = 1 - i;
        cuts = busy(into) > t ? [into] : [];
        swap = false;
      }
    }
    // a pinned chord still sounding is never cut: the new chord joins it at t, its tones tied over
    // (on Medium and Hard both voices hold pins here; Easy has one voice)
    const held = cuts.filter((i) => last(i)?.pinned && busy(i) > t);
    if (held.length) {
      const k = held.length === 1 ? held[0] : bottom(c) > top(last(1)!) ? 0 : 1;
      if (canJoin(last(k)!, t, c)) {
        const rest = cuts.filter((i) => i !== k && !held.includes(i));
        const loss = rest.reduce((x, i) => x + cutLoss(i, t), 0);
        if (!apply) return loss;
        for (const i of rest) cut(i, t);
        v[k].push(joinHeld(last(k)!, t, c));
        return loss;
      }
    }
    const loss = cuts.reduce((x, i) => x + cutLoss(i, t), 0);
    if (!apply) return loss;
    for (const i of cuts) cut(i, t);
    if (swap) {
      v[1].push(v[0].pop()!);
      v[0].push(c);
    } else v[into].push(c);
    return loss;
  };
  for (const t of [...groups.keys()].sort((a, b) => a - b)) {
    const g = groups.get(t)!;
    let parts = groupParts(g, t, mode !== 'never');
    if (parts.length === 2) {
      const [up, lo] = parts;
      // Medium: two voices only for a note held at least a beat longer than the others
      const ok = mode === 'always' || (mode === 'limited' && Math.abs(up.off - lo.off) >= beatLen);
      // one chord: pinned tones keep their ends (the longest is the chord's), else the shorter part's
      const merged = chordOf(t, pinnedEnd(g) ?? Math.min(up.off, lo.off), g);
      if (!ok || pinBusy(0, t) || pinBusy(1, t)) parts = [merged];
      else if (busy(0) > t || busy(1) > t) {
        // two parts would stop both held voices: writing the group as one chord (the longer part
        // shortened) may lose less, e.g. a rolled chord whose bass is still sounding
        const splitLoss = cutLoss(0, t) + cutLoss(1, t);
        const shorten = ((Math.max(up.off, lo.off) - merged.off) / DIV) * (up.off > lo.off ? up.midis.length : lo.midis.length);
        if (shorten + placeOne(merged, t, false) < splitLoss) parts = [merged];
      }
    }
    if (parts.length === 2) {
      cut(0, t);
      cut(1, t);
      v[0].push(parts[0]);
      v[1].push(parts[1]);
      continue;
    }
    placeOne(parts[0], t, true);
  }
  // no tiny rests: close small gaps inside a voice (except a rest that starts on a beat), and
  // lengthen a note before a longer rest so the rest starts on the level's rest grid
  // (never past an onset of the other voice that would sit across this one: crossed stems)
  for (let vi = 0; vi < 2; vi++) {
    const voice = v[vi];
    const other = v[1 - vi];
    const otherOns = other.map((o) => o.on);
    const crossLimit = (c: Chord, from: number, to: number) => {
      let k = lowerBoundAbove(otherOns, from - 1);
      for (; k < other.length && other[k].on < to; k++) {
        const o = other[k];
        if (vi === 1 ? bottom(o) <= top(c) : top(o) >= bottom(c)) return o.on;
      }
      return to;
    };
    for (let i = 0; i < voice.length; i++) {
      const c = voice[i];
      if (c.pinned) continue;
      const next = crossLimit(c, c.off, voice[i + 1]?.on ?? Infinity);
      const gap = next - c.off;
      if (gap <= 0) continue;
      if (gap <= rules.fillGap && !ctx.isBeat(c.off)) {
        c.off = next;
        continue;
      }
      if (ctx.tripletQuarters.has(Math.floor(c.off / DIV))) continue;
      const g = rules.restGrid;
      const to = Math.ceil(c.off / g) * g;
      if (to <= next) c.off = to;
    }
  }
  // voice-2 chords with exactly the rhythm of a voice-1 chord join it
  const byRhythm = new Map(v[0].map((c) => [c.on * 1e6 + c.off, c]));
  v[1] = v[1].filter((c) => {
    const m = byRhythm.get(c.on * 1e6 + c.off);
    if (!m || m.tieIn || m.tieOut || m.ends || c.tieIn || c.tieOut || c.ends) return true;
    joinInto(m, c);
    return false;
  });
  return v;
}
