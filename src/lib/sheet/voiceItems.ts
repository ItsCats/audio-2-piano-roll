/**
 * The written items (notes, rests, forwards) of each voice in each measure: shared by the MusicXML
 * writer and `writtenIndex` (written.ts), so both walk exactly the same notes.
 */
import { decompose, beams, type Piece, type RhythmContext, type BeamValue } from './rhythm';
import { DIV, type Chord, type Score } from './types';

export interface Item {
  kind: 'note' | 'rest' | 'forward' | 'mrest';
  piece: Piece;
  chord?: Chord;
  tieStart?: boolean;
  tieStop?: boolean;
  firstOfChord?: boolean;
  lastOfChord?: boolean;
  tuplet?: 'start' | 'stop';
  beams?: [number, BeamValue][];
  acc?: (string | null)[];
}

/** Whether a chord tone is tied to the chord before (stop) or after (start) at this item. */
export function toneTie(it: Item, j: number): { start: boolean; stop: boolean } {
  const c = it.chord;
  const midi = c?.midis[j];
  return {
    stop: !!it.tieStop || (!!it.firstOfChord && midi !== undefined && !!c?.tieIn?.includes(midi)),
    start: !!it.tieStart || (!!it.lastOfChord && midi !== undefined && !!c?.tieOut?.includes(midi)),
  };
}

const segMemo = new WeakMap<Chord, Chord[]>();
/**
 * A chord whose pinned tones end at different times (Chord.ends) as the chords it is written as:
 * all tones up to the first end, then the tones still sounding, tied on, up to the next end, …
 */
export function segments(c: Chord): Chord[] {
  if (!c.ends || c.ends.every((e) => e >= c.off)) return [c];
  let out = segMemo.get(c);
  if (out) return out;
  const ends = c.ends.map((e) => Math.max(c.on + 1, Math.min(e, c.off)));
  const cuts = [...new Set([...ends, c.off])].filter((e) => e > c.on).sort((a, b) => a - b);
  out = [];
  let from = c.on;
  for (const e of cuts) {
    const keep = c.midis.map((_, i) => i).filter((i) => ends[i] >= e);
    if (!keep.length) break;
    const seg: Chord = { on: from, off: e, midis: keep.map((i) => c.midis[i]) };
    if (c.srcByMidi) seg.srcByMidi = keep.map((i) => c.srcByMidi![i]);
    if (c.pinned) seg.pinned = true;
    const prev = out[out.length - 1];
    if (prev) {
      const tied = seg.midis.filter((m) => prev.midis.includes(m));
      if (tied.length) {
        seg.tieIn = tied;
        seg.prev = prev;
        prev.tieOut = tied;
      }
    } else {
      if (c.ottavaStart) seg.ottavaStart = c.ottavaStart;
      if (c.tieIn) {
        seg.tieIn = c.tieIn.filter((m) => seg.midis.includes(m));
        seg.prev = c.prev;
      }
    }
    out.push(seg);
    from = e;
  }
  if (!out.length) out = [{ ...c, ends: undefined }];
  const lastSeg = out[out.length - 1];
  if (c.ottavaStop) lastSeg.ottavaStop = true;
  if (c.tieOut) lastSeg.tieOut = [...new Set([...(lastSeg.tieOut ?? []), ...c.tieOut.filter((m) => lastSeg.midis.includes(m))])];
  segMemo.set(c, out);
  return out;
}

/** Chords of each (staff, voice) bucketed per measure (a chord with tones ending apart as its segments). */
function bucket(score: Score): Chord[][][][] {
  const t = score.time;
  return score.staves.map((sv) =>
    sv.voices.map((voice) => {
      const per: Chord[][] = Array.from({ length: score.measureCount }, () => []);
      for (const c of voice.flatMap(segments)) {
        const m0 = t.measureOf(c.on);
        const m1 = Math.min(score.measureCount - 1, t.measureOf(c.off - 1));
        for (let m = m0; m <= m1; m++) per[m].push(c);
      }
      return per;
    }),
  );
}

const memo = new WeakMap<Score, Chord[][][][]>();
export function buckets(score: Score) {
  let b = memo.get(score);
  if (!b) memo.set(score, (b = bucket(score)));
  return b;
}

function tripletMarks(items: Item[]) {
  for (const it of items) {
    if (!it.piece.triplet || it.kind === 'forward') continue;
    const inQ = it.piece.pos % DIV;
    if (inQ === 0) it.tuplet = 'start';
    else if (inQ + it.piece.dur === DIV) it.tuplet = 'stop';
  }
}

/** Items (notes, rests, forwards) of one voice in one measure, covering the whole measure. */
export function voiceItems(score: Score, chords: Chord[], m: number, voice: 0 | 1): Item[] {
  const t = score.time;
  const a = t.measureStart(m);
  const len = t.measureLenAt(m);
  const b = a + len;
  const mt = t.changes ? t.meterAt(m) : t;
  const ctx: RhythmContext = { measureStart: a, measureLen: len, beatLen: mt.beatLen, compound: mt.compound, isTriplet: (q) => score.tripletQuarters.has(q) };
  const items: Item[] = [];
  if (!chords.length) {
    // a whole-measure rest; in a pickup measure written out (readers take measure rests as full bars)
    if (voice === 1) items.push({ kind: 'forward', piece: { pos: a, dur: len, type: 'whole', dots: 0, triplet: false } });
    else if (len === mt.measureLen) items.push({ kind: 'mrest', piece: { pos: a, dur: len, type: 'whole', dots: 0, triplet: false } });
    else for (const piece of decompose(a, b, ctx, true)) items.push({ kind: 'rest', piece });
    return items;
  }
  const notesInQuarter = new Set<number>();
  if (voice === 1)
    for (const c of chords) for (let q = Math.floor(Math.max(c.on, a) / DIV); q * DIV < Math.min(c.off, b); q++) notesInQuarter.add(q);
  const gap = (p: number, e: number) => {
    if (voice === 0) {
      for (const piece of decompose(p, e, ctx, true)) items.push({ kind: 'rest', piece });
      return;
    }
    // voice 2: invisible forwards, but real rests inside triplet quarters it plays in
    let x = p;
    while (x < e) {
      const q = Math.floor(x / DIV);
      if (score.tripletQuarters.has(q) && notesInQuarter.has(q)) {
        const y = Math.min(e, (q + 1) * DIV);
        for (const piece of decompose(x, y, ctx, true)) items.push({ kind: 'rest', piece });
        x = y;
      } else {
        let y = x;
        while (y < e) {
          const qq = Math.floor(y / DIV);
          if (score.tripletQuarters.has(qq) && notesInQuarter.has(qq)) break;
          y = Math.min(e, (qq + 1) * DIV);
        }
        items.push({ kind: 'forward', piece: { pos: x, dur: y - x, type: 'quarter', dots: 0, triplet: false } });
        x = y;
      }
    }
  };
  let p = a;
  for (const c of chords) {
    const on = Math.max(c.on, a);
    const off = Math.min(c.off, b);
    if (off <= on) continue;
    if (on > p) gap(p, on);
    const pieces = decompose(on, off, ctx);
    pieces.forEach((piece, i) => {
      items.push({
        kind: 'note',
        piece,
        chord: c,
        tieStop: i > 0 || c.on < a,
        tieStart: i < pieces.length - 1 || c.off > b,
        firstOfChord: i === 0 && c.on >= a,
        lastOfChord: i === pieces.length - 1 && c.off <= b,
      });
    });
    p = off;
  }
  if (p < b) gap(p, b);
  tripletMarks(items);
  // beams
  const beamItems = items.map((it) => ({ pos: it.piece.pos, dur: it.piece.dur, type: it.piece.type, triplet: it.piece.triplet, rest: it.kind !== 'note' }));
  const easyHalfBar = score.level === 'easy' && len === 48 && mt.beatLen === 12;
  const bs = beams(beamItems, ctx, easyHalfBar ? 24 : undefined);
  items.forEach((it, i) => (it.beams = bs[i]));
  return items;
}

