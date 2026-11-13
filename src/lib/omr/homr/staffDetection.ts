// SPDX-License-Identifier: AGPL-3.0-only
// Modified (TypeScript port of homr 0.7.1) by the Piano2Vision contributors, 2026; see README.md here.
/**
 * Staff detection: port of homr/staff_detection.py and homr/find_peaks.py.
 *
 * Derived from homr (AGPL-3.0, Copyright the homr contributors, https://github.com/liebharc/homr).
 */
import { concatContours, createRotatedBoundingBox, RotatedBoundingBox } from './boxes';
import type { Img } from './cv';
import { minAreaRect } from './geom';
import { LINES, mean, median, pyRound, Staff, StaffPoint, std } from './model';

const MAX_LINE_GAP = (u: number) => 5 * u;
const SHORT_LINE = (u: number) => u / 5;
const SHORT_CONNECTED_LINE = (u: number) => 2 * u;
const SEGMENT_X_TOLERANCE = 10;
const MAX_ANGLE_PARALLEL = 10;

type Range = { start: number; stop: number };

export class StaffLineSegment {
  fragments: RotatedBoundingBox[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  readonly keys: Set<string>;
  constructor(
    public debugId: number,
    fragments: RotatedBoundingBox[],
  ) {
    this.fragments = [...fragments].sort((a, b) => a.box[0][0] - b.box[0][0]);
    this.minX = Math.min(...fragments.map((l) => l.center[0] - l.size[0] / 2));
    this.maxX = Math.max(...fragments.map((l) => l.center[0] + l.size[0] / 2));
    this.minY = Math.min(...fragments.map((l) => l.center[1] - l.size[1] / 2));
    this.maxY = Math.max(...fragments.map((l) => l.center[1] + l.size[1] / 2));
    this.keys = new Set(this.fragments.map((f) => f.key));
  }

  merge(o: StaffLineSegment): StaffLineSegment {
    const lines = [...this.fragments];
    for (const f of o.fragments) if (!lines.some((l) => l.key === f.key)) lines.push(f);
    return new StaffLineSegment(this.debugId, lines);
  }

  getAt(x: number): RotatedBoundingBox | null {
    for (const f of this.fragments) {
      if (x >= f.center[0] - f.size[0] / 2 - SEGMENT_X_TOLERANCE && x <= f.center[0] + f.size[0] / 2 + SEGMENT_X_TOLERANCE) return f;
    }
    return null;
  }

  /** set(self.fragments) ⊆ set(o.fragments) */
  isSubsetOf(o: StaffLineSegment): boolean {
    for (const k of this.keys) if (!o.keys.has(k)) return false;
    return true;
  }
}

export class StaffAnchor {
  unitSizes: number[];
  averageUnitSize: number;
  maxY: number;
  minY: number;
  zone: Range;
  constructor(
    public staffLines: StaffLineSegment[],
    public symbol: RotatedBoundingBox,
  ) {
    const ys = staffLines.map((l) => l.fragments[0].getCenterExtrapolated(symbol.center[0])).sort((a, b) => a - b);
    const d: number[] = [];
    for (let i = 1; i < ys.length; i++) d.push(Math.abs(ys[i] - ys[i - 1]));
    this.unitSizes = d;
    this.averageUnitSize = d.length ? mean(d) : 0;
    this.maxY = Math.max(...staffLines.map((l) => l.maxY));
    this.minY = Math.min(...staffLines.map((l) => l.minY));
    this.zone = { start: Math.trunc(this.minY - 5 * this.averageUnitSize), stop: Math.trunc(this.maxY + 5 * this.averageUnitSize) };
  }
}

export class RawStaff extends RotatedBoundingBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  constructor(
    public staffId: number,
    public lines: StaffLineSegment[],
    public anchors: StaffAnchor[],
  ) {
    const all = concatContours(lines.flatMap((l) => l.fragments.map((f) => f.contours)));
    super(minAreaRect(all), all, staffId);
    this.minX = this.center[0] - this.size[0] / 2;
    this.maxX = this.center[0] + this.size[0] / 2;
    this.minY = this.center[1] - this.size[1] / 2;
    this.maxY = this.center[1] + this.size[1] / 2;
  }

  mergeStaff(o: RawStaff): RawStaff {
    return new RawStaff(
      this.staffId,
      this.lines.map((l, i) => o.lines[i].merge(l)),
      [...this.anchors, ...o.anchors],
    );
  }
}

function staffForAnchor(anchor: StaffAnchor, staffs: RawStaff[]): RawStaff | null {
  for (const s of staffs) {
    for (let i = 0; i < anchor.staffLines.length; i++) if (anchor.staffLines[i].isSubsetOf(s.lines[i])) return s;
  }
  return null;
}

/**
 * Python's list.remove: drops the first element EQUAL to x, and homr's boxes compare equal by their
 * rotated rectangle, so this can be another staff with the same rectangle than x itself.
 */
function removeFirstEqual(list: RawStaff[], x: RawStaff): void {
  const i = list.findIndex((s) => s.equals(x));
  if (i >= 0) list.splice(i, 1);
}

function findRawStaffs(anchors: StaffAnchor[], fragments: RotatedBoundingBox[]): RawStaff[] {
  const staffs: RawStaff[] = [];
  let id = 0;
  for (const anchor of anchors) {
    const existing = staffForAnchor(anchor, staffs);
    const inZone = fragments.filter((f) => f.center[1] >= anchor.zone.start && f.center[1] <= anchor.zone.stop);
    const connected = connectStaffLines(inZone, anchor.averageUnitSize);
    const lines: StaffLineSegment[] = [];
    for (const al of anchor.staffLines) {
      const m = connected.filter((l) => al.isSubsetOf(l));
      if (m.length === 1) lines.push(...m);
      else lines.push(al);
    }
    if (existing) {
      removeFirstEqual(staffs, existing);
      staffs.push(existing.mergeStaff(new RawStaff(id, lines, [anchor])));
    } else staffs.push(new RawStaff(id, lines, [anchor]));
    id++;
  }
  return staffs;
}

function removeDuplicateStaffs(staffs: RawStaff[]): RawStaff[] {
  let result: RawStaff[] = [];
  for (const s of staffs) {
    const overlapping = result.filter((o) => s.isOverlapping(o));
    if (!overlapping.length) {
      result.push(s);
      continue;
    }
    if (overlapping.length >= 2) continue;
    if (overlapping[0].anchors.length < s.anchors.length) {
      result = result.filter((r) => !r.equals(overlapping[0]));
      result.push(s);
    }
  }
  return result;
}

function gapHasInk(left: RawStaff, right: RawStaff, ink: Img): boolean {
  const x0 = Math.max(Math.trunc(left.maxX), 0);
  const x1 = Math.trunc(right.minX);
  const y0 = Math.max(Math.trunc(Math.min(left.minY, right.minY)), 0);
  const y1 = Math.trunc(Math.max(left.maxY, right.maxY));
  if (x1 <= x0) return true;
  const xa = Math.min(x0, ink.w);
  const xb = Math.min(x1, ink.w);
  const ya = Math.min(y0, ink.h);
  const yb = Math.min(Math.max(y1, 0), ink.h);
  if (xb <= xa) return false; // numpy: mean of nothing is nan
  let cols = 0;
  for (let x = xa; x < xb; x++) {
    for (let y = ya; y < yb; y++) {
      if (ink.d[y * ink.w + x]) {
        cols++;
        break;
      }
    }
  }
  return cols / (xb - xa) >= 0.5;
}

function continues(left: RawStaff, right: RawStaff): boolean {
  const anchors = [...left.anchors, ...right.anchors];
  const unit = mean(anchors.map((a) => a.averageUnitSize));
  const gap = right.minX - left.maxX;
  if (unit <= 0 || gap < 0 || gap > 15 * unit) return false;
  let lineUp = 0;
  for (let i = 0; i < left.lines.length; i++) {
    const ll = left.lines[i];
    const rl = right.lines[i];
    const ly = ll.fragments[ll.fragments.length - 1].getCenterExtrapolated(ll.maxX);
    const ry = rl.fragments[0].getCenterExtrapolated(rl.minX);
    if (Math.abs(ly - ry) <= unit / 2) lineUp++;
  }
  return lineUp >= LINES - 1;
}

function mergeStaffsInSameRow(staffs: RawStaff[], ink: Img): RawStaff[] {
  const result = [...staffs].sort((a, b) => a.minX - b.minX);
  let i = 0;
  while (i < result.length) {
    const right = result.slice(i + 1).find((o) => continues(result[i], o) && gapHasInk(result[i], o, ink));
    if (!right) {
      i++;
      continue;
    }
    const merged = result[i].mergeStaff(right);
    removeFirstEqual(result, right);
    result[i] = merged;
  }
  return result;
}

export function connectStaffLines(lines: RotatedBoundingBox[], unit: number): StaffLineSegment[] {
  // sorted(..., reverse=True) keeps equal keys in order; pop() takes from the end
  const todo = [...lines].sort((a, b) => b.bottomLeft[0] - a.bottomLeft[0]);
  const result: RotatedBoundingBox[][] = [];
  let active: RotatedBoundingBox[][] = [];
  let lastCleanup = 0;
  while (todo.length) {
    const cur = todo.pop() as RotatedBoundingBox;
    const x = cur.bottomLeft[0];
    if (x - lastCleanup > MAX_LINE_GAP(unit)) {
      active = active.filter((item) => x - item[item.length - 1].bottomRight[0] < MAX_LINE_GAP(unit));
      lastCleanup = x;
    }
    if (cur.box[1][0] < SHORT_LINE(unit)) continue;
    let connected = false;
    for (const al of active) {
      if (al[al.length - 1].isOverlappingExtrapolated(cur, unit)) {
        al.push(cur);
        connected = true;
      }
    }
    if (!connected) {
      const n = [cur];
      result.push(n);
      active.push(n);
    }
  }
  return result.sort((a, b) => a[0].box[0][1] - b[0].box[0][1]).map((l, i) => new StaffLineSegment(i, l));
}

function extrapolatedLineY(line: StaffLineSegment, x: number): number {
  return (line.getAt(x) ?? line.fragments[0]).getCenterExtrapolated(x);
}

function areLinesCrossing(lines: StaffLineSegment[]): boolean {
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = Math.max(lines[i].minX, lines[j].minX);
      const b = Math.min(lines[i].maxX, lines[j].maxX);
      if (a >= b) continue;
      const ds = extrapolatedLineY(lines[i], a) - extrapolatedLineY(lines[j], a);
      const de = extrapolatedLineY(lines[i], b) - extrapolatedLineY(lines[j], b);
      if (ds === 0 || de === 0 || ds > 0 !== de > 0) return true;
    }
  }
  return false;
}

function areLinesParallel(lines: StaffLineSegment[], unit: number): boolean {
  const frags = lines.flatMap((l) => l.fragments);
  if (!frags.length) return false;
  const avg = mean(frags.map((f) => f.angle));
  for (const f of frags) if (Math.abs(f.angle - avg) > MAX_ANGLE_PARALLEL && f.size[0] > SHORT_CONNECTED_LINE(unit)) return false;
  return true;
}

function beginsOrEndsOnStaffLine(line: RotatedBoundingBox, staffLines: StaffLineSegment[], unit: number): boolean {
  for (const sl of staffLines) {
    const f = sl.getAt(line.center[0]);
    if (!f) continue;
    if (Math.abs(f.getCenterExtrapolated(line.center[0]) - line.center[1]) < unit) return true;
  }
  return false;
}

export function findStaffAnchors(staffLines: RotatedBoundingBox[], symbols: RotatedBoundingBox[], areClefs = false): StaffAnchor[] {
  const result: StaffAnchor[] = [];
  for (const c of symbols) {
    const adjacent = areClefs
      ? [c.moveToXHorizontalBy(-10), c, c.moveToXHorizontalBy(10), c.moveToXHorizontalBy(30), c.moveToXHorizontalBy(60), c.moveToXHorizontalBy(80)]
      : [c.moveToXHorizontalBy(-10), c.moveToXHorizontalBy(-5), c, c.moveToXHorizontalBy(5), c.moveToXHorizontalBy(10)];
    for (const symbol of adjacent) {
      const unit = pyRound(symbol.size[1] / (LINES - 1));
      const thick = symbol.makeBoxTaller(unit);
      const overlapping = staffLines.filter((l) => l.isIntersecting(thick));
      let connected = connectStaffLines(overlapping, unit);
      if (connected.length > LINES) connected = connected.filter((l) => l.maxX - l.minX > SHORT_CONNECTED_LINE(unit));
      if (connected.length !== LINES) continue;
      if (!areLinesParallel(connected, unit)) continue;
      if (areLinesCrossing(connected)) continue;
      if (!areClefs && !beginsOrEndsOnStaffLine(symbol, connected, unit)) continue;
      result.push(new StaffAnchor(connected, symbol));
    }
  }
  return result;
}

function resampleSegment(anchor: StaffAnchor, staff: RawStaff, xs: number[]): StaffPoint[] {
  const out: StaffPoint[] = [];
  const x0 = anchor.symbol.center[0];
  const lf = anchor.staffLines.map((l) => l.fragments[0]);
  let prev = new StaffPoint(x0, lf.map((l) => l.getCenterExtrapolated(x0)), mean(lf.map((l) => l.angle)));
  const avg = anchor.averageUnitSize;
  for (const x of xs) {
    const lines = staff.lines.map((l) => l.getAt(x));
    const ac: (number | null)[] = lines.map((l) => (l ? l.getCenterExtrapolated(x) : null));
    const values = ac.filter((c): c is number => c !== null);
    if (ac.every((c) => c === null)) continue;
    // (as in homr: the indices of the differences of the found lines mark the lines by position)
    for (let i = 0; i + 1 < values.length; i++) {
      if (values[i + 1] - values[i] < 0.5 * avg) {
        ac[i] = null;
        ac[i + 1] = null;
      }
    }
    prev.y.forEach((py, i) => {
      const v = ac[i];
      if (v !== null && v !== undefined && Math.abs(v - py) > 0.5 * avg) ac[i] = null;
    });
    let pc = -1;
    const order = [...ac.keys(), ...[...ac.keys()].reverse()];
    for (const i of order) {
      if (ac[i] !== null) pc = i;
      else if (pc >= 0) {
        const v = ac[pc];
        if (v !== null) ac[i] = v + avg * (i - pc);
      }
    }
    if (ac.some((c) => c === null)) continue;
    const angle = mean(lines.filter((l): l is RotatedBoundingBox => l !== null).map((l) => l.angle));
    prev = new StaffPoint(x, ac as number[], angle);
    out.push(prev);
  }
  return out;
}

function pyRange(start: number, stop: number, step: number): number[] {
  const out: number[] = [];
  for (let v = start; v < stop; v += step) out.push(v);
  return out;
}

function resampleStaff(staff: RawStaff): Staff | null {
  const anchors = [...staff.anchors].sort((a, b) => a.symbol.center[0] - b.symbol.center[0]);
  const D = 10;
  const rd = (x: number) => pyRound(x / D) * D;
  const start = Math.floor(staff.minX / D) * D;
  const stop = (Math.floor(staff.maxX / D) + 1) * D;
  const grid: StaffPoint[] = [];
  let x = start;
  anchors.forEach((a, i) => {
    const toLeft = pyRange(rd(x), rd(a.symbol.center[0]), D);
    let toRight: number[];
    let toRightStop: number;
    if (i < anchors.length - 1) {
      toRightStop = Math.trunc((a.symbol.center[0] + anchors[i + 1].symbol.center[0]) / 2);
      toRight = pyRange(Math.trunc(a.symbol.center[0]), toRightStop, D);
    } else {
      toRightStop = rd(stop);
      toRight = pyRange(rd(a.symbol.center[0]), toRightStop, D);
    }
    x = toRightStop;
    grid.push(...resampleSegment(a, staff, toLeft.reverse()).reverse());
    grid.push(...resampleSegment(a, staff, toRight));
  });
  // (Python homr fails on a staff without points; such a staff is dropped here)
  return grid.length ? new Staff(grid) : null;
}

function filterEdgeOfVision(staffs: Staff[], w: number, h: number): Staff[] {
  const usual = mean(staffs.map((s) => s.maxX - s.minX));
  return staffs.filter((s) => {
    if (s.maxY >= h || s.minY < 0) return false;
    const shorter = s.maxX - s.minX < usual / 2;
    const beyond = s.minX < 0.01 * w || s.maxX > 0.99 * w;
    return !(beyond && shorter);
  });
}

function mainColumn(extents: [number, number][]): [number, number] {
  const longest = Math.max(...extents.map(([l, r]) => r - l));
  const long = extents.filter(([l, r]) => r - l >= 0.75 * longest);
  return [median(long.map(([l]) => l)), median(long.map(([, r]) => r))];
}

function shareInColumn(l: number, r: number, col: [number, number]): number {
  const inside = Math.min(r, col[1]) - Math.max(l, col[0]);
  return r > l ? inside / (r - l) : 0;
}

function filterNeighborPage(staffs: Staff[]): Staff[] {
  if (!staffs.length) return staffs;
  const col = mainColumn(staffs.map((s) => [s.minX, s.maxX]));
  const minW = (col[1] - col[0]) / 2;
  return staffs.filter((s) => s.maxX - s.minX >= minW || shareInColumn(s.minX, s.maxX, col) >= 0.5);
}

function filterUnusualAnchors(anchors: StaffAnchor[]): StaffAnchor[] {
  if (!anchors.length) return anchors;
  const u = anchors.map((a) => a.averageUnitSize);
  const m = mean(u);
  const sd = std(u);
  return anchors.filter((a) => !(Math.abs(a.averageUnitSize - m) > 3 * sd));
}

function initZone(clefAnchors: StaffAnchor[], w: number): Range[] {
  const make = (a: number, b: number): Range => ({ start: Math.max(Math.trunc(a), 0), stop: Math.min(Math.trunc(b), w) });
  const ranges = clefAnchors.map((c) => make(c.symbol.bottomLeft[0], c.symbol.topRight[0] + 10)).sort((a, b) => a.start - b.start);
  const result: Range[] = [];
  ranges.forEach((r, i) => {
    if (i === 0) result.push(r);
    else if (r.start < result[result.length - 1].stop) result[result.length - 1] = { start: result[result.length - 1].start, stop: r.stop };
    else result.push(r);
  });
  return result;
}

/** homr's find_peaks (scipy-like: height, prominence, then distance keeping the highest). */
export function findPeaks(x: Float64Array, height: number | null, distance: number | null, prominence: number | null): number[] {
  const n = x.length;
  if (n < 3) return [];
  let peaks: number[] = [];
  let i = 1;
  while (i < n - 1) {
    if (x[i] > x[i - 1]) {
      let j = i;
      while (j < n - 1 && x[j] === x[j + 1]) j++;
      if (j < n - 1 && x[j] > x[j + 1]) {
        peaks.push(Math.floor((i + j) / 2));
        i = j + 1;
      } else i = j + 1;
    } else if (x[i] === x[i - 1]) {
      let j = i;
      while (j < n - 1 && x[j] === x[j + 1]) j++;
      if (j < n - 1 && x[j] > x[j + 1]) peaks.push(Math.floor((i + j) / 2));
      i = j + 1;
    } else i++;
  }
  if (!peaks.length) return [];
  if (height !== null) peaks = peaks.filter((p) => x[p] >= height);
  if (!peaks.length) return [];
  if (prominence !== null) {
    const valid: number[] = [];
    for (const p of peaks) {
      let lmin = x[p];
      for (let k = p - 1; k >= 0; k--) {
        if (x[k] > x[p]) break;
        lmin = Math.min(lmin, x[k]);
      }
      let rmin = x[p];
      for (let k = p + 1; k < n; k++) {
        if (x[k] > x[p]) break;
        rmin = Math.min(rmin, x[k]);
      }
      if (x[p] - Math.max(lmin, rmin) >= prominence) valid.push(p);
    }
    peaks = valid;
  }
  if (!peaks.length) return [];
  if (distance !== null && peaks.length > 1) {
    // np.argsort(heights)[::-1]: highest first; equal heights: the later peak first (stable argsort reversed)
    const order = peaks.map((_p, k) => k).sort((a, b) => x[peaks[a]] - x[peaks[b]] || a - b).reverse();
    const keep: number[] = [];
    for (const k of order) {
      const p = peaks[k];
      if (!keep.length || keep.every((q) => Math.abs(q - p) >= distance)) keep.push(p);
    }
    peaks = keep.sort((a, b) => a - b);
  }
  return peaks;
}

function lineGroups(peaks: number[]): number[] {
  const gaps: number[] = [];
  for (let i = 1; i < peaks.length; i++) gaps.push(peaks[i] - peaks[i - 1]);
  const count = Math.max(5, pyRound(peaks.length * 0.2));
  const approx = mean([...gaps].sort((a, b) => a - b).slice(0, count));
  const maxGap = approx * 1.5;
  const ext = [peaks[0] - maxGap - 1, ...peaks];
  const groups: number[] = [];
  let g = -1;
  for (let i = 1; i < ext.length; i++) {
    if (ext[i] - ext[i - 1] > maxGap) g++;
    groups.push(g);
  }
  return groups;
}

/** Groups of five horizontal lines in the columns [zone.start, zone.stop) of a mask (projection profile). */
function findHorizontalLines(image: Img, zone: Range, unit: number): number[][] {
  const H = image.h;
  const count = new Float64Array(H + 2);
  for (let y = 0; y < H; y++) {
    let c = 0;
    for (let x = Math.max(zone.start, 0); x < Math.min(zone.stop, image.w); x++) if (image.d[y * image.w + x] > 0) c++;
    count[y + 1] = c;
  }
  const arr = Array.from(count);
  const sd = std(arr);
  if (sd === 0) return [];
  const m = mean(arr);
  const norm = new Float64Array(count.length);
  for (let i = 0; i < count.length; i++) norm[i] = (count[i] - m) / sd;
  const centers = findPeaks(norm, 0, 0.7 * unit, 1).map((c) => c - 1);
  if (centers.length < LINES) return [];
  const groups = lineGroups(centers);
  const byGroup = new Map<number, number[]>();
  centers.forEach((c, i) => {
    let g = byGroup.get(groups[i]);
    if (!g) byGroup.set(groups[i], (g = []));
    g.push(c);
  });
  return [...byGroup.values()].filter((g) => g.length === LINES).map((g) => [...g].sort((a, b) => a - b));
}

function findFiveLineGroups(image: Img, zones: Range[], unit: number): RotatedBoundingBox[] {
  const result: RotatedBoundingBox[] = [];
  for (const zone of zones) {
    const width = Math.max(0, Math.min(zone.stop, image.w) - Math.max(zone.start, 0));
    if (width === 0) continue;
    for (const g of findHorizontalLines(image, zone, unit)) {
      const minY = Math.min(...g);
      const maxY = Math.max(...g);
      const cy = (minY + maxY) / 2;
      const cx = zone.start + (zone.stop - zone.start) / 2;
      result.push(new RotatedBoundingBox([[Math.trunc(cx), Math.trunc(cy)], [zone.stop - zone.start, Math.trunc(maxY - minY)], 0], new Int32Array(0), 0));
    }
  }
  return result;
}

export function predictOtherAnchorsFromClefs(clefAnchors: StaffAnchor[], image: Img): RotatedBoundingBox[] {
  if (!clefAnchors.length) return [];
  const unit = mean(clefAnchors.map((a) => a.averageUnitSize));
  const symbols = clefAnchors.map((a) => a.symbol);
  return findFiveLineGroups(image, initZone(clefAnchors, image.w), unit).filter((r) => !r.isOverlappingWithAny(symbols));
}

const SLICES_ACROSS_PAGE = [0.2, 0.35, 0.5, 0.65, 0.8];

function findStaffsWithoutClef(raw: RawStaff[], clefAnchors: StaffAnchor[], fragments: RotatedBoundingBox[], image: Img): RawStaff[] {
  if (!raw.length || !clefAnchors.length) return [];
  const unit = mean(clefAnchors.map((a) => a.averageUnitSize));
  const w = image.w;
  const sw = Math.max(10, Math.trunc(2 * unit));
  const zones = SLICES_ACROSS_PAGE.map((f) => ({ start: Math.trunc(f * w), stop: Math.min(w, Math.trunc(f * w) + sw) }));
  const boxes = findFiveLineGroups(image, zones, unit);
  const anchors = filterUnusualAnchors(findStaffAnchors(fragments, boxes, true));
  const candidates = removeDuplicateStaffs(findRawStaffs(anchors, fragments));
  const col = mainColumn(raw.map((s) => [s.minX, s.maxX]));
  const minW = (col[1] - col[0]) / 2;
  return candidates.filter((c) => c.maxX - c.minX >= minW && shareInColumn(c.minX, c.maxX, col) >= 0.9 && !raw.some((s) => c.isOverlapping(s)));
}

/** homr break_wide_fragments: wide (possibly curved) line fragments split into parts of at most `limit` px. */
export function breakWideFragments(fragments: RotatedBoundingBox[], limit = 100): RotatedBoundingBox[] {
  const result: RotatedBoundingBox[] = [];
  for (const fr of fragments) {
    let rem = fr;
    while (rem.size[0] > limit) {
      const c = rem.contours;
      const n = c.length / 2;
      let minX = Infinity;
      for (let i = 0; i < n; i++) minX = Math.min(minX, c[2 * i]);
      const idx = Array.from({ length: n }, (_, i) => i);
      const left = idx.filter((i) => c[2 * i] < minX + limit).sort((a, b) => c[2 * a] - c[2 * b]);
      const right = idx.filter((i) => c[2 * i] >= minX + limit).sort((a, b) => c[2 * a] - c[2 * b]);
      if (!left.length || !right.length) break;
      left.push(right[0]);
      right.push(left[left.length - 1]);
      const pts = (ix: number[]) => Int32Array.from(ix.flatMap((i) => [c[2 * i], c[2 * i + 1]]));
      result.push(createRotatedBoundingBox(pts(left), rem.debugId));
      rem = createRotatedBoundingBox(pts(right), rem.debugId);
    }
    result.push(rem);
  }
  return result;
}

export function estimateUnitSizeFromClefs(fragments: RotatedBoundingBox[], clefs: RotatedBoundingBox[]): number | null {
  const anchors = findStaffAnchors(fragments, clefs, true);
  if (!anchors.length) return null;
  return median(anchors.map((a) => a.averageUnitSize));
}

/** homr detect_staff: staffs (top to bottom) from the staff-line mask, line fragments, clefs and bar lines. */
export function detectStaff(image: Img, fragments: RotatedBoundingBox[], clefs: RotatedBoundingBox[], barLines: RotatedBoundingBox[], symbols: Img | null): Staff[] {
  const clefAnchors = findStaffAnchors(fragments, clefs, true);
  let anchors = [...clefAnchors];
  const other = predictOtherAnchorsFromClefs(clefAnchors, image);
  anchors.push(...findStaffAnchors(fragments, other, true));
  anchors.push(...findStaffAnchors(fragments, barLines, false));
  anchors = filterUnusualAnchors(anchors);
  let raw = removeDuplicateStaffs(findRawStaffs(anchors, fragments));
  let ink = image;
  if (symbols) {
    ink = { w: image.w, h: image.h, c: 1, d: new Uint8Array(image.d.length) };
    for (let i = 0; i < ink.d.length; i++) ink.d[i] = image.d[i] > 0 || symbols.d[i] > 0 ? 1 : 0;
  }
  raw = mergeStaffsInSameRow(raw, ink);
  raw.push(...findStaffsWithoutClef(raw, clefAnchors, fragments, image));
  let staffs = raw.map(resampleStaff).filter((s): s is Staff => s !== null);
  if (staffs.length) staffs = filterEdgeOfVision(staffs, image.w, image.h);
  staffs = filterNeighborPage(staffs);
  return [...staffs].sort((a, b) => a.minY - b.minY);
}
