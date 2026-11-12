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
    const i = lowerBoundAbove(onsets, a.on);
    const b = onsets[i];
    if (b === undefined || a.off <= b) return a;
    const second = onsets[i + 1];
    if (second !== undefined && second < a.off) return a;
    if (a.off - b > maxOverhang) return a;
    return { ...a, off: b };
  });
}

const top = (c: Chord) => c.midis[c.midis.length - 1];
const bottom = (c: Chord) => c.midis[0];

/** One or two parts of an onset group (two only when the top notes end differently and don't cross the rest). */
function groupParts(g: QNote[], t: number, split: boolean): Chord[] {
  const ends = new Set(g.map((n) => n.off));
  const asc = (ns: QNote[]) => ns.map((n) => n.midi).sort((a, b) => a - b);
  if (ends.size === 1) return [{ on: t, off: g[0].off, midis: asc(g) }];
  const minEnd = Math.min(...ends);
  if (split) {
    const hi = g.reduce((a, b) => (b.midi > a.midi ? b : a));
    const upper = g.filter((n) => n.off === hi.off);
    const lower = g.filter((n) => n.off !== hi.off);
    if (Math.min(...upper.map((n) => n.midi)) > Math.max(...lower.map((n) => n.midi))) {
      return [
        { on: t, off: hi.off, midis: asc(upper) },
        { on: t, off: Math.min(...lower.map((n) => n.off)), midis: asc(lower) },
      ];
    }
  }
  return [{ on: t, off: minEnd, midis: asc(g) }];
}

export interface VoiceContext {
  beatLen: number;
  /** Whether a position is on a beat (relative to its measure). */
  isBeat: (pos: number) => boolean;
  tripletQuarters: Set<number>;
}

export function assignVoices(notesIn: QNote[], staff: Staff, rules: SheetLevelRules, ctx: VoiceContext): [Chord[], Chord[]] {
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
  // Medium: a held melody over moving notes (staff 1), or a held bass under moving notes (staff 2)
  const allowUnder = mode === 'always' || (mode === 'limited' && staff === 1);
  const allowOver = mode === 'always' || (mode === 'limited' && staff === 2);
  for (const t of [...groups.keys()].sort((a, b) => a - b)) {
    const g = groups.get(t)!;
    let parts = groupParts(g, t, mode !== 'never');
    if (parts.length === 2) {
      const [up, lo] = parts;
      const ok = mode === 'always' || (mode === 'limited' && (staff === 1 ? up.off > lo.off : lo.off > up.off));
      if (!ok) parts = [{ on: t, off: Math.min(up.off, lo.off), midis: [...lo.midis, ...up.midis] }];
    }
    if (parts.length === 2) {
      cut(0, t);
      cut(1, t);
      v[0].push(parts[0]);
      v[1].push(parts[1]);
      continue;
    }
    const c = parts[0];
    const f0 = busy(0) <= t;
    const f1 = busy(1) <= t;
    if (f0) {
      const l1 = last(1);
      if (!f1 && l1 && !(bottom(c) > top(l1))) cut(1, t);
      v[0].push(c);
      continue;
    }
    const held = last(0)!;
    if (f1 && allowUnder && top(c) < bottom(held)) {
      v[1].push(c);
    } else if (f1 && allowOver && bottom(c) > top(held) && busy(1) <= held.on) {
      v[0].pop();
      v[1].push(held);
      v[0].push(c);
    } else if (!f1) {
      const l1 = last(1)!;
      if (bottom(c) > top(l1)) {
        cut(0, t);
        v[0].push(c);
      } else if (top(c) < bottom(held)) {
        cut(1, t);
        v[1].push(c);
      } else {
        cut(0, t);
        cut(1, t);
        v[0].push(c);
      }
    } else {
      cut(0, t);
      v[0].push(c);
    }
  }
  // no tiny rests: close small gaps inside a voice (except a rest that starts on a beat), and
  // lengthen a note before a longer rest so the rest starts on the level's rest grid
  for (const voice of v) {
    for (let i = 0; i < voice.length; i++) {
      const c = voice[i];
      const next = voice[i + 1]?.on ?? Infinity;
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
    if (!m) return true;
    m.midis = [...new Set([...m.midis, ...c.midis])].sort((a, b) => a - b);
    return false;
  });
  return v;
}
