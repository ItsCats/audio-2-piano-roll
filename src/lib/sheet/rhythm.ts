/**
 * Rhythm spelling: splits a span inside one measure into written note values (at most one dot,
 * off-beat starts split at the next beat, triplets inside triplet quarters) and beams them.
 */
import { DIV } from './types';

export type NoteType = 'whole' | 'half' | 'quarter' | 'eighth' | '16th' | '32nd';

export interface Piece {
  /** Absolute position in divisions. */
  pos: number;
  dur: number;
  type: NoteType;
  dots: 0 | 1;
  triplet: boolean;
}

export interface RhythmContext {
  measureStart: number;
  measureLen: number;
  /** Beat group in divisions (12 simple quarter beats, 18 compound, 24 for x/2, 6 for simple x/8). */
  beatLen: number;
  compound: boolean;
  isTriplet: (quarter: number) => boolean;
}

const VALUES: [number, NoteType, 0 | 1][] = [
  [72, 'whole', 1],
  [48, 'whole', 0],
  [36, 'half', 1],
  [24, 'half', 0],
  [18, 'quarter', 1],
  [12, 'quarter', 0],
  [9, 'eighth', 1],
  [6, 'eighth', 0],
  [3, '16th', 0],
];

function allowed(d: number, dots: number, m: number, ctx: RhythmContext, rest: boolean): boolean {
  const B = ctx.beatLen;
  const L = ctx.measureLen;
  const inBeat = m % B;
  if (d === 72) return m === 0 && L === 72;
  if (d === 48) return m === 0 && L === 48;
  if (rest && dots && !ctx.compound) return false; // no dotted rests in simple meters
  if (d >= B) {
    if (inBeat !== 0) return false;
    if (ctx.compound && d % B !== 0) return false;
    if (L === 48 && B === 12) {
      if (d === 36) return m === 0;
      if (d === 24 && rest) return m % 24 === 0; // half rests only on beat 1 or 3 of 4/4
    }
    return true;
  }
  // inside a beat: stay inside it
  if (inBeat + d > B) return false;
  if (d >= 6 && inBeat % 3 !== 0) return false;
  if (d === 12) return inBeat % 6 === 0 && (B !== 24 || inBeat % 12 === 0);
  if (d === 18) return inBeat === 0;
  return true;
}

function pickValue(rem: number, m: number, ctx: RhythmContext, rest: boolean): [number, NoteType, 0 | 1] {
  for (const v of VALUES) if (v[0] <= rem && allowed(v[0], v[2], m, ctx, rest)) return v;
  if (rem >= 3) return [3, '16th', 0];
  return [rem, '32nd', 0];
}

/** Written values for the span [start, end) inside one measure (absolute positions). */
export function decompose(start: number, end: number, ctx: RhythmContext, rest = false): Piece[] {
  const out: Piece[] = [];
  let p = start;
  let guard = 0;
  while (p < end && guard++ < 1000) {
    const q = Math.floor(p / DIV);
    const qEnd = (q + 1) * DIV;
    if (ctx.isTriplet(q) && !(p % DIV === 0 && end >= qEnd)) {
      const lim = Math.min(end, qEnd);
      const d = lim - p;
      const inQ = p % DIV;
      let piece: [number, NoteType];
      if (d >= 8 && (inQ === 0 || inQ === 4)) piece = [8, 'quarter'];
      else if (d >= 4) piece = [4, 'eighth'];
      else if (d >= 2) piece = [2, '16th'];
      else piece = [d, '32nd'];
      out.push({ pos: p, dur: piece[0], type: piece[1], dots: 0, triplet: true });
      p += piece[0];
      continue;
    }
    // don't run part-way into a triplet quarter
    let lim = end;
    for (let k = Math.ceil(p / DIV); k * DIV < end; k++) {
      if (ctx.isTriplet(k) && end < (k + 1) * DIV) {
        lim = Math.min(lim, k * DIV);
        break;
      }
    }
    const [d, type, dots] = pickValue(lim - p, p - ctx.measureStart, ctx, rest);
    out.push({ pos: p, dur: d, type, dots, triplet: false });
    p += d;
  }
  return out;
}

export type BeamValue = 'begin' | 'continue' | 'end' | 'forward hook' | 'backward hook';

export interface BeamItem {
  pos: number;
  dur: number;
  type: NoteType;
  triplet: boolean;
  rest: boolean;
}

const beamable = (it: BeamItem) => !it.rest && (it.type === 'eighth' || it.type === '16th' || it.type === '32nd');
const level2 = (it: BeamItem) => it.type === '16th' || it.type === '32nd';

/**
 * Beams for the items of one voice in one measure (in order): 8ths and shorter are beamed per
 * beat group (a dotted quarter in compound meters; `groupLen` overrides, e.g. half bars on Easy).
 * Returns per item a list of [beam number, value].
 */
export function beams(items: BeamItem[], ctx: RhythmContext, groupLen?: number): [number, BeamValue][][] {
  const G = groupLen ?? Math.max(ctx.beatLen, 12);
  const out: [number, BeamValue][][] = items.map(() => []);
  let i = 0;
  while (i < items.length) {
    if (!beamable(items[i])) {
      i++;
      continue;
    }
    const g = Math.floor((items[i].pos - ctx.measureStart) / (items[i].triplet ? DIV : G));
    const trip = items[i].triplet;
    let j = i;
    while (
      j + 1 < items.length &&
      beamable(items[j + 1]) &&
      items[j + 1].triplet === trip &&
      Math.floor((items[j + 1].pos - ctx.measureStart) / (trip ? DIV : G)) === g &&
      items[j + 1].pos === items[j].pos + items[j].dur
    )
      j++;
    if (j > i) {
      for (let k = i; k <= j; k++) out[k].push([1, k === i ? 'begin' : k === j ? 'end' : 'continue']);
      // second beam over runs of 16ths; hooks for single 16ths
      let k = i;
      while (k <= j) {
        if (!level2(items[k])) {
          k++;
          continue;
        }
        let e = k;
        while (e + 1 <= j && level2(items[e + 1])) e++;
        if (e > k) for (let x = k; x <= e; x++) out[x].push([2, x === k ? 'begin' : x === e ? 'end' : 'continue']);
        else out[k].push([2, k === i ? 'forward hook' : 'backward hook']);
        k = e + 1;
      }
    }
    i = j + 1;
  }
  return out;
}
