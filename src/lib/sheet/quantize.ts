/**
 * Rhythm quantization for notation: each quarter note picks the simplest grid (quarters, 8ths,
 * 16ths, or — Medium and Hard, only when clearly better — triplet 8ths) that fits the onsets in it,
 * from both hands together so the two staves line up.
 */
import { isClearTriplet } from '../music/quantize';
import { DIV, type QNote, type SheetLevelRules, type Staff } from './types';

/** A note on the continuous position axis (divisions, not yet rounded). */
export interface RawNote {
  midi: number;
  on: number;
  off: number;
  staff: Staff;
  /** Song note ids (threaded through to the written chords). */
  ids?: number[];
  /** A sheet edit's written position (Note.pin): used as it is, never snapped. */
  pin?: { on: number; off: number };
}

/** Finest straight grid (or 3 = triplet 8ths) a position needs within its quarter; 0 = none fits. */
export function gridNeeded(pos: number): number {
  const r = ((pos % DIV) + DIV) % DIV;
  return r === 0 ? 1 : r % 6 === 0 ? 2 : r % 3 === 0 ? 4 : r % 4 === 0 ? 3 : 0;
}

const PENALTY: Record<number, number> = { 1: 0, 2: 0.6, 4: 1.6, 3: 3 };
const ERR_SCALE = 0.07; // quarters

export interface Quantized {
  notes: QNote[];
  /** Grid (subdivisions per quarter) chosen for each quarter that has onsets. */
  gridOf: Map<number, number>;
  tripletQuarters: Set<number>;
}

const snapErr = (x: number, g: number) => Math.abs(x - Math.round(x * g) / g);

/** Picks the grid of one quarter from the onsets in [k − 1/8, k + 7/8) (x = offset from k, quarters). */
export function chooseGrid(xs: number[], grids: number[]): number {
  let best = grids[0];
  let bestCost = Infinity;
  for (const g of grids) {
    if (g === 3) continue;
    let cost = PENALTY[g] ?? 0;
    for (const x of xs) cost += (snapErr(x, g) / ERR_SCALE) ** 2;
    if (cost < bestCost - 1e-9) {
      bestCost = cost;
      best = g;
    }
  }
  // triplets only when clearly better (the same rule the Medium arrangement uses)
  if (grids.includes(3) && isClearTriplet(xs)) return 3;
  return best;
}

export function quantize(raw: RawNote[], rules: SheetLevelRules): Quantized {
  const byQuarter = new Map<number, number[]>();
  for (const r of raw) {
    const q = r.on / DIV;
    const k = Math.floor(q + 1 / 8);
    let a = byQuarter.get(k);
    if (!a) byQuarter.set(k, (a = []));
    a.push(q - k);
  }
  const gridOf = new Map<number, number>();
  const tripletQuarters = new Set<number>();
  for (const [k, xs] of byQuarter) {
    const g = chooseGrid(xs, rules.grids);
    gridOf.set(k, g);
    if (g === 3) tripletQuarters.add(k);
  }
  // quarters without onsets: ends snap to 8ths (quarters on Easy... 8ths too, the minimum there)
  const emptyGrid = 2;
  const snap = (pos: number) => {
    const q = pos / DIV;
    const k = Math.floor(q + 1 / 8);
    const g = gridOf.get(k) ?? emptyGrid;
    return Math.round((Math.round(q * g) / g) * DIV);
  };
  // a note struck again quickly (same staff and pitch, at least half the shortest note later) that
  // lands on the same grid point: its quarter takes the finest straight grid so both strikes fit
  const finest = Math.max(...rules.grids.filter((g) => g !== 3));
  const firstAt = new Map<number, number>();
  for (const r of [...raw].sort((a, b) => a.on - b.on)) {
    const on = snap(r.on);
    const id = (r.staff * 128 + r.midi) * 1e7 + on;
    const prev = firstAt.get(id);
    if (prev === undefined) firstAt.set(id, r.on);
    else if (r.on - prev >= rules.minDur / 2) {
      const k = Math.floor(on / DIV + 1 / 8);
      if (!tripletQuarters.has(k) && (gridOf.get(k) ?? emptyGrid) < finest) gridOf.set(k, finest);
    }
  }
  // a pinned note's quarters take a grid at least as fine as its positions (pins win)
  for (const r of raw) {
    if (!r.pin) continue;
    for (const p of [r.pin.on, r.pin.off]) {
      const g = gridNeeded(p);
      if (g <= 1) continue;
      const k = Math.floor(p / DIV);
      const cur = gridOf.get(k) ?? emptyGrid;
      if (g === 3) {
        gridOf.set(k, 3);
        tripletQuarters.add(k);
      } else if (cur === 3) {
        gridOf.set(k, g);
        tripletQuarters.delete(k);
      } else if (cur % g !== 0) gridOf.set(k, Math.max(cur, g) % Math.min(cur, g) === 0 ? Math.max(cur, g) : 4);
    }
  }
  const stepAt = (on: number) => Math.max(rules.minDur, Math.min(rules.maxStep ?? Infinity, DIV / (gridOf.get(Math.floor(on / DIV)) ?? emptyGrid)));
  const rawOn = new Map<QNote, number>();
  let notes: QNote[] = raw.map((r) => {
    if (r.pin) {
      const n: QNote = { midi: r.midi, on: r.pin.on, off: r.pin.off, staff: r.staff, src: [...(r.ids ?? [])], pinned: true };
      rawOn.set(n, r.pin.on);
      return n;
    }
    const on = Math.max(0, snap(r.on));
    const off = Math.max(on + stepAt(on), snap(r.off));
    const n: QNote = { midi: r.midi, on, off, staff: r.staff, src: [...(r.ids ?? [])] };
    rawOn.set(n, r.on);
    return n;
  });
  // inside a triplet quarter, an end stays on a triplet point only if the staff plays again later
  // in that quarter; otherwise it moves to the quarter's edge (no "triplet quarter + triplet rest")
  if (tripletQuarters.size) {
    const onsets = new Set(notes.map((n) => n.staff * 1e7 + n.on));
    for (const n of notes) {
      const k = Math.floor(n.off / DIV);
      if (n.pinned || n.off % DIV === 0 || !tripletQuarters.has(k)) continue;
      let later = false;
      for (let p = n.off; p < (k + 1) * DIV && !later; p += 4) later = onsets.has(n.staff * 1e7 + p);
      if (later) continue;
      const lo = k * DIV;
      n.off = n.off - lo <= 4 && lo > n.on ? lo : (k + 1) * DIV;
    }
  }
  // same staff + pitch + onset: a re-struck note (played at least half a grid step later) moves to
  // the next grid point when that is within a step of where it was played; otherwise it is a
  // duplicate and the longer one is kept. Same pitch overlapping: cut the earlier note.
  notes.sort((a, b) => a.staff - b.staff || a.midi - b.midi || a.on - b.on || rawOn.get(a)! - rawOn.get(b)!);
  const out: QNote[] = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const prev = out[out.length - 1];
    if (prev && prev.staff === n.staff && prev.midi === n.midi) {
      // pinned notes win: an unpinned duplicate joins the pinned note; one that starts inside a
      // pinned note starts after it (or joins it when nothing is left)
      if (prev.on === n.on && (prev.pinned || n.pinned)) {
        const keep = n.pinned && !prev.pinned ? n : prev;
        const drop = keep === n ? prev : n;
        keep.src = [...(keep.src ?? []), ...(drop.src ?? [])];
        if (drop.pinned) keep.off = Math.max(keep.off, drop.off);
        out[out.length - 1] = keep;
        continue;
      }
      if (prev.pinned && !n.pinned && prev.off > n.on) {
        if (n.off <= prev.off) {
          prev.src = [...(prev.src ?? []), ...(n.src ?? [])];
          continue;
        }
        n.on = prev.off;
      }
      if (prev.on === n.on) {
        const step = stepAt(n.on);
        const to = n.on + step;
        const next = notes[i + 1];
        const nextOn = next && next.staff === n.staff && next.midi === n.midi ? next.on : Infinity;
        const r = rawOn.get(n)!;
        if (r - rawOn.get(prev)! >= step / 2 && to - r <= step && to <= nextOn) {
          n.on = to;
          n.off = Math.max(n.off, to + step);
        } else {
          prev.off = Math.max(prev.off, n.off);
          prev.src = [...(prev.src ?? []), ...(n.src ?? [])];
          continue;
        }
      }
      if (prev.off > n.on) prev.off = n.on;
    }
    out.push(n);
  }
  notes = out.sort((a, b) => a.on - b.on || a.staff - b.staff || a.midi - b.midi);
  return { notes, gridOf, tripletQuarters };
}
