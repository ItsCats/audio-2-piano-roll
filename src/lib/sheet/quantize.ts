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
  let notes: QNote[] = raw.map((r) => {
    const on = Math.max(0, snap(r.on));
    const k = Math.floor(on / DIV);
    const step = Math.max(rules.minDur, Math.min(rules.maxStep ?? Infinity, DIV / (gridOf.get(k) ?? emptyGrid)));
    const off = Math.max(on + step, snap(r.off));
    return { midi: r.midi, on, off, staff: r.staff };
  });
  // inside a triplet quarter, an end stays on a triplet point only if the staff plays again later
  // in that quarter; otherwise it moves to the quarter's edge (no "triplet quarter + triplet rest")
  if (tripletQuarters.size) {
    const onsets = new Set(notes.map((n) => n.staff * 1e7 + n.on));
    for (const n of notes) {
      const k = Math.floor(n.off / DIV);
      if (n.off % DIV === 0 || !tripletQuarters.has(k)) continue;
      let later = false;
      for (let p = n.off; p < (k + 1) * DIV && !later; p += 4) later = onsets.has(n.staff * 1e7 + p);
      if (later) continue;
      const lo = k * DIV;
      n.off = n.off - lo <= 4 && lo > n.on ? lo : (k + 1) * DIV;
    }
  }
  // same staff + pitch + onset: keep the longest; same pitch overlapping: cut the earlier note
  notes.sort((a, b) => a.staff - b.staff || a.midi - b.midi || a.on - b.on || b.off - a.off);
  const out: QNote[] = [];
  for (const n of notes) {
    const prev = out[out.length - 1];
    if (prev && prev.staff === n.staff && prev.midi === n.midi) {
      if (prev.on === n.on) continue;
      if (prev.off > n.on) prev.off = n.on;
    }
    out.push(n);
  }
  notes = out.sort((a, b) => a.on - b.on || a.staff - b.staff || a.midi - b.midi);
  return { notes, gridOf, tripletQuarters };
}
