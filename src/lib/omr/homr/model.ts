/**
 * Staffs and the symbols on them: port of homr/model.py.
 *
 * Derived from homr (AGPL-3.0, Copyright the homr contributors, https://github.com/liebharc/homr).
 */
import { BoundingBox, type AngledBoundingBox, type BoundingEllipse, type RotatedBoundingBox } from './boxes';
import type { Pt } from './geom';

export const LINES = 5;

export function mean(a: number[]): number {
  let s = 0;
  for (const v of a) s += v;
  return s / a.length;
}

/** numpy.median */
export function median(a: number[]): number {
  if (!a.length) return NaN;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** numpy.std (population) */
export function std(a: number[]): number {
  const m = mean(a);
  let s = 0;
  for (const v of a) s += (v - m) ** 2;
  return Math.sqrt(s / a.length);
}

/** Python round(): half to even */
export function pyRound(v: number): number {
  const r = Math.round(v);
  if (Math.abs(v % 1) === 0.5) return 2 * Math.round(v / 2) + 0;
  return r + 0;
}

export type StemDirection = 'up' | 'down';

export abstract class SymbolOnStaff {
  constructor(public center: Pt) {}
}

export class Note extends SymbolOnStaff {
  hasDot = false;
  constructor(
    public box: BoundingEllipse,
    public position: number,
    public stem: RotatedBoundingBox | null,
    public stemDirection: StemDirection | null,
  ) {
    super(box.center);
  }
}

export class BarLineSymbol extends SymbolOnStaff {
  constructor(public box: RotatedBoundingBox) {
    super(box.center);
  }
}

export class ClefSymbol extends SymbolOnStaff {
  constructor(public box: BoundingBox) {
    super(box.center);
  }
}

export class StaffPoint {
  averageUnitSize: number;
  constructor(
    public x: number,
    public y: number[],
    public angle: number,
  ) {
    if (y.length % LINES !== 0) throw new Error('A staff must consist of 5, 10, ... lines');
    const d: number[] = [];
    for (let i = 1; i < y.length; i++) d.push(y[i] - y[i - 1]);
    this.averageUnitSize = mean(d);
  }

  merge(o: StaffPoint): StaffPoint {
    if (Math.abs(this.x - o.x) > 1e-3) throw new Error("Can't merge points at different positions");
    return new StaffPoint(this.x, [...this.y, ...o.y].sort((a, b) => a - b), (this.angle + o.angle) / 2);
  }

  findPositionInUnitSizes(box: AngledBoundingBox): number {
    const cy = box.center[1];
    let idx = 0;
    let best = Infinity;
    this.y.forEach((y, i) => {
      const d = Math.abs(y - cy);
      if (d < best) (best = d), (idx = i);
    });
    const distance = this.y[idx] - cy;
    const inUnits = pyRound((2 * distance) / this.averageUnitSize);
    return 2 * (this.y.length - idx) + inUnits - 1;
  }

  toBoundingBox(): BoundingBox {
    return new BoundingBox([Math.trunc(this.x), Math.trunc(this.y[0]), Math.trunc(this.x), Math.trunc(this.y[this.y.length - 1])], new Int32Array(0), -2);
  }

  transform(t: (p: Pt) => Pt): StaffPoint {
    const xy = this.y.map((y) => t([this.x, y]));
    return new StaffPoint(mean(xy.map((p) => p[0])), xy.map((p) => p[1]), this.angle);
  }
}

export class Staff {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  averageUnitSize: number;
  symbols: SymbolOnStaff[] = [];
  isGrandstaff = false;
  private yTolerance: number;
  constructor(public grid: StaffPoint[]) {
    this.minX = grid[0].x;
    this.maxX = grid[grid.length - 1].x;
    this.minY = Math.min(...grid.map((p) => Math.min(...p.y)));
    this.maxY = Math.max(...grid.map((p) => Math.max(...p.y)));
    this.averageUnitSize = median(grid.map((p) => p.averageUnitSize));
    this.yTolerance = 4 * this.averageUnitSize;
  }

  isOnStaffZone(item: AngledBoundingBox): boolean {
    const p = this.getAt(item.center[0]);
    if (!p) return false;
    return !(item.center[1] > p.y[p.y.length - 1] + this.yTolerance || item.center[1] < p.y[0] - this.yTolerance);
  }

  merge(o: Staff): Staff {
    const a = new Map<number, StaffPoint>();
    for (const p of this.grid) a.set(pyRound(p.x), p);
    const b = new Map<number, StaffPoint>();
    for (const p of o.grid) b.set(pyRound(p.x), p);
    const xs = [...a.keys()].filter((x) => b.has(x)).sort((x, y) => x - y);
    const r = new Staff(xs.map((x) => (a.get(x) as StaffPoint).merge(b.get(x) as StaffPoint)));
    r.symbols.push(...this.symbols, ...o.symbols);
    r.isGrandstaff = true;
    return r;
  }

  split(): [Staff, Staff] | null {
    const grid = this.grid.filter((p) => p.y.length === 2 * LINES);
    if (!grid.length) return null;
    const upper = new Staff(grid.map((p) => new StaffPoint(p.x, p.y.slice(0, LINES), p.angle)));
    const lower = new Staff(grid.map((p) => new StaffPoint(p.x, p.y.slice(LINES), p.angle)));
    const boundary = median(grid.map((p) => (p.y[LINES - 1] + p.y[LINES]) / 2));
    for (const s of this.symbols) (s.center[1] < boundary ? upper : lower).symbols.push(s);
    return [upper, lower];
  }

  getAt(x: number): StaffPoint | null {
    let best = this.grid[0];
    let bd = Math.abs(best.x - x);
    for (const p of this.grid) {
      const d = Math.abs(p.x - x);
      if (d < bd) (bd = d), (best = p);
    }
    return bd > 50 ? null : best;
  }

  yDistanceTo(pt: Pt): number {
    const p = this.getAt(pt[0]);
    if (!p) return 1e10;
    return Math.min(...p.y.map((y) => Math.abs(y - pt[1])));
  }

  getBarLines(): BarLineSymbol[] {
    return this.symbols.filter((s): s is BarLineSymbol => s instanceof BarLineSymbol);
  }

  getClefs(): ClefSymbol[] {
    return this.symbols.filter((s): s is ClefSymbol => s instanceof ClefSymbol);
  }

  getNotes(): Note[] {
    return this.symbols.filter((s): s is Note => s instanceof Note);
  }

  transform(t: (p: Pt) => Pt): Staff {
    const c = new Staff(this.grid.map((p) => p.transform(t)));
    c.symbols = this.symbols.map((s) => {
      const copy = Object.assign(Object.create(Object.getPrototypeOf(s)), s) as SymbolOnStaff;
      copy.center = t(s.center);
      return copy;
    });
    c.isGrandstaff = this.isGrandstaff;
    return c;
  }
}

const GRANDSTAFF_X_FACTOR = 5;
const GRANDSTAFF_Y_FACTOR = 0.5;

/** A system: a grand staff or staffs of several voices. */
export class MultiStaff {
  staffs: Staff[];
  constructor(
    staffs: Staff[],
    public connections: RotatedBoundingBox[],
  ) {
    this.staffs = [...staffs].sort((a, b) => a.minY - b.minY);
  }

  merge(o: MultiStaff): MultiStaff {
    const staffs: Staff[] = [];
    for (const s of [...this.staffs, ...o.staffs]) if (!staffs.includes(s)) staffs.push(s);
    const conns: RotatedBoundingBox[] = [];
    for (const c of [...this.connections, ...o.connections]) if (!conns.some((x) => x.equals(c))) conns.push(c);
    return new MultiStaff(staffs, conns);
  }

  private scorePair(symbol: RotatedBoundingBox, upper: Staff, lower: Staff, above: Staff | null, below: Staff | null): number {
    const unit = median([upper.averageUnitSize, lower.averageUnitSize]);
    const xThreshold = GRANDSTAFF_X_FACTOR * unit;
    const yThreshold = GRANDSTAFF_Y_FACTOR * symbol.size[1];
    const smin = symbol.center[1] - symbol.size[1] / 2;
    const smax = symbol.center[1] + symbol.size[1] / 2;
    if (above && smin < (above.maxY + upper.minY) / 2) return 0;
    if (below && smax > (lower.maxY + below.minY) / 2) return 0;
    const sx = symbol.center[0];
    const xd = Math.min(Math.abs(upper.minX - sx), Math.abs(lower.minX - sx));
    const yo = Math.min(smax, lower.maxY) - Math.max(smin, upper.minY);
    if (!(xd < xThreshold && yo > yThreshold && yo > xd)) return 0;
    const union = Math.max(smax, lower.maxY) - Math.min(smin, upper.minY);
    const iou = union > 0 ? yo / union : 0;
    return iou - xd / xThreshold;
  }

  createGrandstaffs(braceDot: RotatedBoundingBox[]): MultiStaff {
    if (this.staffs.length < 2) return this;
    const scores: { idx: [number, number]; score: number }[] = [];
    for (let i = 0; i < this.staffs.length - 1; i++) {
      const above = i > 0 ? this.staffs[i - 1] : null;
      const below = i + 2 < this.staffs.length ? this.staffs[i + 2] : null;
      // (Python's max() would raise on no candidates; a system of several staffs always has some)
      if (!braceDot.length) continue;
      const best = Math.max(...braceDot.map((s) => this.scorePair(s, this.staffs[i], this.staffs[i + 1], above, below)));
      if (best > 0) scores.push({ idx: [i, i + 1], score: best });
    }
    const used = new Set<number>();
    const pairs: [number, number][] = [];
    // sorted(..., reverse=True) is stable: equal scores keep their order
    const order = scores.map((s, i) => ({ s, i })).sort((a, b) => b.s.score - a.s.score || a.i - b.i);
    for (const { s } of order) {
      if (s.idx.some((k) => used.has(k))) continue;
      pairs.push(s.idx);
      s.idx.forEach((k) => used.add(k));
    }
    if (!pairs.length) return this;
    const merged: Staff[] = [];
    let i = 0;
    while (i < this.staffs.length) {
      if (pairs.some((p) => p.includes(i))) {
        merged.push(this.staffs[i].merge(this.staffs[i + 1]));
        i += 2;
        continue;
      }
      merged.push(this.staffs[i]);
      i++;
    }
    return new MultiStaff(merged, this.connections);
  }

  breakApart(): MultiStaff[] {
    return this.staffs.map((s) => new MultiStaff([s], []));
  }
}
