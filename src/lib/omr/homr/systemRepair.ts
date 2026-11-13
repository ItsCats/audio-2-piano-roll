/**
 * Repairs the grouping of staffs into systems before the transcription: port of
 * homr/system_repair.py.
 *
 * Derived from homr (AGPL-3.0, Copyright the homr contributors, https://github.com/liebharc/homr).
 */
import { LINES, median, MultiStaff, pyRound, type Staff } from './model';

/** A system's layout: is_grandstaff per staff, as a string of T / F */
type Layout = string;

const flatten = (staffs: MultiStaff[]) => staffs.flatMap((m) => m.staffs);
export const layoutOf = (row: MultiStaff): Layout => row.staffs.map((s) => (s.isGrandstaff ? 'T' : 'F')).join('');
const isUniform = (staffs: MultiStaff[]) => new Set(staffs.map(layoutOf)).size === 1;

/** Python Counter: counts in insertion order */
class Counter extends Map<Layout, number> {
  inc(k: Layout) {
    this.set(k, (this.get(k) ?? 0) + 1);
  }
  count(k: Layout) {
    return this.get(k) ?? 0;
  }
  /** most_common: by count, ties in insertion order */
  mostCommon(): [Layout, number][] {
    return [...this.entries()].map((e, i) => ({ e, i })).sort((a, b) => b.e[1] - a.e[1] || a.i - b.i).map((x) => x.e);
  }
}

function mostCommon(c: Counter): Layout | null {
  if (!c.size) return null;
  const mc = c.mostCommon();
  if (mc.length > 1 && mc[1][1] === mc[0][1]) return null;
  return mc[0][0];
}

function verticalGap(upper: Staff, lower: Staff): number | null {
  const up = new Map<number, number[]>();
  for (const p of upper.grid) up.set(pyRound(p.x), p.y);
  const gaps: number[] = [];
  for (const p of lower.grid) {
    const u = up.get(pyRound(p.x));
    if (u) gaps.push(p.y[0] - u[u.length - 1]);
  }
  return gaps.length ? median(gaps) : null;
}

function pairs<T>(a: T[]): [T, T][] {
  const out: [T, T][] = [];
  for (let i = 0; i + 1 < a.length; i++) out.push([a[i], a[i + 1]]);
  return out;
}

function possibleGrandstaffs(staffs: MultiStaff[], strict: boolean, guessLone = true): Set<string> {
  const flat = flatten(staffs);
  const systemOf = new Map<Staff, number>();
  staffs.forEach((row, i) => row.staffs.forEach((s) => systemOf.set(s, i)));
  const gs: number[] = [];
  for (const s of flat) {
    if (!s.isGrandstaff) continue;
    for (const p of s.grid) if (p.y.length === 2 * LINES) gs.push(((p.y[LINES] - p.y[LINES - 1]) * (LINES - 1)) / (p.y[LINES - 1] - p.y[0]));
  }
  const maxGap = gs.length ? 1.5 * median(gs) : Infinity;
  const measured = pairs(flat).map(([u, l]) => verticalGap(u, l));
  const gaps = pairs(flat).map(([u, l], i) => (measured[i] === null ? l.minY - u.maxY : (measured[i] as number)));
  const result = new Set<string>();
  pairs(flat).forEach(([upper, lower], i) => {
    const gap = measured[i];
    const unit = Math.min(upper.averageUnitSize, lower.averageUnitSize);
    if (upper.isGrandstaff || lower.isGrandstaff || gap === null || gap > maxGap * unit) return;
    const neighbors: number[] = [];
    for (const j of [i - 1, i + 1]) if (j >= 0 && j < gaps.length && !flat[j].isGrandstaff && !flat[j + 1].isGrandstaff) neighbors.push(gaps[j]);
    const connected = systemOf.get(upper) === systemOf.get(lower);
    const lone = [upper, lower].every((s) => staffs[systemOf.get(s) as number].staffs.length === 1);
    const guess = !strict && (guessLone || !lone);
    if (guess || connected || neighbors.every((n) => gap < 0.8 * n)) result.add(pairKey(upper, lower));
  });
  return result;
}

const staffIds = new WeakMap<Staff, number>();
let nextStaffId = 1;
function idOf(s: Staff): number {
  let id = staffIds.get(s);
  if (!id) staffIds.set(s, (id = nextStaffId++));
  return id;
}
const pairKey = (a: Staff, b: Staff) => `${idOf(a)},${idOf(b)}`;

function fitToLayout(staffs: Staff[], layout: Layout, grand: Set<string>): Staff[] | null {
  const result: Staff[] = [];
  let i = 0;
  for (const ch of layout) {
    const isG = ch === 'T';
    if (i < staffs.length && staffs[i].isGrandstaff === isG) {
      result.push(staffs[i]);
      i++;
    } else if (isG && i + 1 < staffs.length && !staffs[i].isGrandstaff && !staffs[i + 1].isGrandstaff && grand.has(pairKey(staffs[i], staffs[i + 1]))) {
      result.push(staffs[i].merge(staffs[i + 1]));
      i += 2;
    } else return null;
  }
  return i === staffs.length ? result : null;
}

function fitNeighbors(staffs: MultiStaff[], start: number, layout: Layout, grand: Set<string>): [Staff[], number] | null {
  for (let end = start + 1; end <= staffs.length; end++) {
    const group = flatten(staffs.slice(start, end));
    if (group.length > 2 * layout.length) return null;
    if (!layout.includes('T') && group.length === end - start && end - start > 1) continue;
    const fitted = fitToLayout(group, layout, grand);
    if (fitted) return [fitted, end];
  }
  return null;
}

function repairSystems(staffs: MultiStaff[], layout: Layout, strict = false, guessLone = true): MultiStaff[] {
  const grand = possibleGrandstaffs(staffs, strict, guessLone);
  const result: MultiStaff[] = [];
  let i = 0;
  while (i < staffs.length) {
    if (layoutOf(staffs[i]) === layout) {
      result.push(staffs[i]);
      i++;
      continue;
    }
    const row = staffs[i].staffs;
    const repeats = Math.floor(row.length / layout.length);
    if (repeats > 1 && layoutOf(staffs[i]) === layout.repeat(repeats)) {
      for (let k = 0; k < row.length; k += layout.length) result.push(new MultiStaff(row.slice(k, k + layout.length), []));
      i++;
      continue;
    }
    const fit = fitNeighbors(staffs, i, layout, grand);
    if (!fit) {
      result.push(staffs[i]);
      i++;
    } else {
      result.push(new MultiStaff(fit[0], []));
      i = fit[1];
    }
  }
  return result;
}

function repairScore(staffs: MultiStaff[], layout: Layout): number {
  const systemOf = new Map<Staff, MultiStaff>();
  for (const row of staffs) for (const s of row.staffs) systemOf.set(s, row);
  let score = 0;
  const nT = [...layout].filter((c) => c === 'T').length;
  for (const row of repairSystems(staffs, layout, true)) {
    if (layoutOf(row) !== layout) continue;
    const contradicts = row.staffs.some((s) => {
      const src = systemOf.get(s);
      return !src || !src.staffs.every((x) => row.staffs.includes(x));
    });
    score += (row.staffs.length + nT) * (contradicts ? 0.5 : 1);
  }
  return score;
}

function mixedLayouts(staffs: MultiStaff[]): Counter {
  const c = new Counter();
  for (const row of staffs) if (new Set(layoutOf(row)).size > 1) c.inc(layoutOf(row));
  for (const [u, l] of pairs(staffs)) {
    const p = layoutOf(u) + layoutOf(l);
    if (p === 'FT' || p === 'TF') c.inc(p);
  }
  return c;
}

function isShownByMixed(staffs: MultiStaff[], layout: Layout): boolean {
  const m = mixedLayouts(staffs);
  return mostCommon(m) === layout && m.count(layout) > 1;
}

/** Python tuple order of bool tuples: F < T, a prefix first */
const layoutCmp = (a: Layout, b: Layout) => (a < b ? -1 : a > b ? 1 : 0);

function commonLayout(staffs: MultiStaff[]): Layout | null {
  const mixed = mixedLayouts(staffs);
  const l = mostCommon(mixed);
  if (l !== null && mixed.count(l) > 1) return l;
  const counts = new Counter();
  for (const row of staffs) counts.inc(layoutOf(row));
  const cands = [...new Set([...counts.keys(), ...mixed.keys()])].sort(layoutCmp).filter((x) => !(x.length > 1 && !x.includes('F') && counts.count(x) < 2));
  if (!cands.length) return null;
  let best = cands[0];
  let bs = [repairScore(staffs, best), counts.count(best)];
  for (const c of cands.slice(1)) {
    const s = [repairScore(staffs, c), counts.count(c)];
    if (s[0] > bs[0] || (s[0] === bs[0] && s[1] > bs[1])) (best = c), (bs = s);
  }
  return best;
}

function dropSingleStaffAtEnd(staffs: MultiStaff[], layout: Layout): MultiStaff[] {
  const single = staffs.filter((r) => layoutOf(r) === 'F');
  const onlyGrand = !layout.includes('F');
  if (!onlyGrand || single.length !== 1 || single[0] !== staffs[staffs.length - 1] || staffs.length < 3) return staffs;
  return staffs.slice(0, -1);
}

function findPeriodicCore(flat: Staff[]): [number, number, number] | null {
  const layout = flat.map((s) => s.isGrandstaff);
  const n = layout.length;
  let best: [number, number, number, number] | null = null;
  for (let period = 1; period <= Math.floor(n / 2); period++) {
    for (let ft = 0; ft <= period; ft++) {
      for (let bt = 0; bt <= period; bt++) {
        const core = layout.slice(ft, n - bt);
        if (core.length < 2 * period || core.length % period !== 0) continue;
        const rows: string[] = [];
        for (let i = 0; i < core.length; i += period) rows.push(core.slice(i, i + period).join());
        if (!rows.every((r) => r === rows[0])) continue;
        const cand: [number, number, number, number] = [ft + bt, period, ft, bt];
        if (!best || cand[0] < best[0] || (cand[0] === best[0] && cand[1] < best[1])) best = cand;
      }
    }
  }
  return best ? [best[1], best[2], best[3]] : null;
}

function regroupByPattern(staffs: MultiStaff[]): MultiStaff[] | null {
  const flat = flatten(staffs);
  const core = findPeriodicCore(flat);
  if (!core) return null;
  const [period, ft, bt] = core;
  const end = flat.length - bt;
  const pattern = new Set(flat.slice(ft, ft + period).map((s) => s.isGrandstaff));
  const mixes = pattern.size === 2;
  const trimmed = ft > 0 || bt > 0;
  const nothingGrouped = staffs.every((r) => r.staffs.length === 1);
  if (!mixes || (trimmed && !nothingGrouped)) return null;
  const out: MultiStaff[] = flat.slice(0, ft).map((s) => new MultiStaff([s], []));
  for (let i = ft; i < end; i += period) out.push(new MultiStaff(flat.slice(i, i + period), []));
  out.push(...flat.slice(end).map((s) => new MultiStaff([s], [])));
  return out;
}

function convertToLayout(row: MultiStaff, layout: Layout): MultiStaff | null {
  if (layoutOf(row) === layout) return row;
  const singles: Staff[] = [];
  for (const s of row.staffs) {
    const parts = s.isGrandstaff ? s.split() : [s];
    if (!parts) return null;
    singles.push(...parts);
  }
  let k = 0;
  const staffs: Staff[] = [];
  for (const ch of layout) {
    // Python next() on an exhausted iterator raises; the caller only converts rows of the same staff count
    let s = singles[k++];
    if (!s) return null;
    if (ch === 'T') {
      const lower = singles[k++];
      if (!lower || verticalGap(s, lower) === null) return null;
      s = s.merge(lower);
    }
    staffs.push(s);
  }
  return new MultiStaff(staffs, row.connections);
}

function unifyGrandStaffs(staffs: MultiStaff[]): MultiStaff[] {
  const per = new Set(staffs.map((r) => r.staffs.reduce((a, s) => a + (s.isGrandstaff ? 2 : 1), 0)));
  if (per.size !== 1) return staffs;
  const c = new Counter();
  for (const r of staffs) c.inc(layoutOf(r));
  const layout = mostCommon(c);
  if (layout === null) return staffs;
  const out: MultiStaff[] = [];
  for (const r of staffs) {
    const conv = convertToLayout(r, layout);
    if (!conv) return staffs;
    out.push(conv);
  }
  return out;
}

/** homr repair_systems */
export function repairSystemsOfPage(input: MultiStaff[]): MultiStaff[] {
  const staffs = unifyGrandStaffs(input);
  if (isUniform(staffs) && staffs[0].staffs.length > 1) return staffs;
  const layout = commonLayout(staffs);
  let repaired: MultiStaff[];
  if (layout === null) repaired = staffs;
  else repaired = repairSystems(staffs, layout, false, isShownByMixed(staffs, layout));
  if (!isUniform(repaired)) {
    const regrouped = regroupByPattern(staffs);
    if (regrouped) return regrouped;
  }
  return layout === null ? repaired : dropSingleStaffAtEnd(repaired, layout);
}
