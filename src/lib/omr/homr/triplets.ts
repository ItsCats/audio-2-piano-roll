// SPDX-License-Identifier: AGPL-3.0-only
// Modified (TypeScript port of homr 0.7.1) by the Piano2Vision contributors, 2026; see README.md here.
/**
 * Restores triplets printed without their "3": port of homr/triplet_restoration.py.
 *
 * Derived from homr (AGPL-3.0, Copyright the homr contributors, https://github.com/liebharc/homr).
 */
import { EncodedSymbol, Frac, fmax, sortTokenChords, isNoteOrRest } from './vocabulary';

type Note = [string, Frac, number]; // voice, duration, index into the symbols
type Measure = Note[][];
type Three = [Set<number>, boolean];

const MAX_THREES_IN_A_ROW = 4;
const MIN_TRIPLETS_ON_A_PAGE = 3;
const MAX_MEASURE_LENGTH = new Frac(2);
const PLAIN = /^(note|rest)_(4|8|16|32|64)$/;

function asTriplet(s: EncodedSymbol): EncodedSymbol {
  const m = PLAIN.exec(s.rhythm);
  if (!m) return s;
  const r = s.clone();
  r.rhythm = `${m[1]}_${Math.floor((parseInt(m[2], 10) * 3) / 2)}`;
  return r;
}

function splitIntoMeasures(symbols: EncodedSymbol[]): Measure[] {
  const indexOf = new Map<EncodedSymbol, number>();
  symbols.forEach((s, i) => indexOf.set(s, i));
  const measures: Measure[] = [[]];
  for (const chord of sortTokenChords(symbols)) {
    const r = chord[0].rhythm;
    if (r.includes('barline') || r.includes('repeat')) measures.push([]);
    else if (isNoteOrRest(r) && !r.endsWith('m'))
      measures[measures.length - 1].push(chord.filter((s) => isNoteOrRest(s.rhythm)).map((s) => [s.position, s.getDuration().fraction, indexOf.get(s) as number]));
  }
  return measures;
}

function play(measure: Measure, triplets: Set<number> = new Set()): [Frac, [string, Frac][]][] {
  let clock = Frac.ZERO;
  let sounding: Frac[] = [];
  const out: [Frac, [string, Frac][]][] = [];
  for (const chord of measure) {
    const notes: [string, Frac][] = [];
    for (const [voice, dur, idx] of chord) {
      const played = triplets.has(idx) ? dur.mul(2).div(3) : dur;
      if (played.gt(Frac.ZERO)) notes.push([voice, clock.add(played)]);
    }
    out.push([clock, notes]);
    if (notes.length) {
      sounding.push(...notes.map(([, e]) => e));
      const c = clock;
      clock = sounding.filter((e) => e.gt(c)).reduce((m, x) => (x.lt(m) ? x : m));
      const c2 = clock;
      sounding = sounding.filter((e) => e.gt(c2));
    }
  }
  return out;
}

function countBreaks(measure: Measure, triplets: Set<number> = new Set()): [number, Frac] {
  const endOfVoice = new Map<string, Frac>();
  let breaks = 0;
  let size = Frac.ZERO;
  for (const [start, notes] of play(measure, triplets)) {
    const ends = new Map<string, Frac>();
    for (const [v, e] of notes) {
      const cur = ends.get(v);
      ends.set(v, cur && cur.gt(e) ? cur : e);
    }
    for (const v of ends.keys()) {
      const prev = endOfVoice.get(v);
      if (prev && !prev.eq(start)) {
        breaks++;
        const d = start.sub(prev);
        size = size.add(d.n < 0 ? d.mul(-1) : d);
      }
    }
    for (const [v, e] of ends) endOfVoice.set(v, e);
  }
  if (endOfVoice.size) {
    const end = fmax([...endOfVoice.values()]);
    for (const e of endOfVoice.values()) {
      if (!e.eq(end)) {
        breaks++;
        size = size.add(end.sub(e));
      }
    }
  }
  return [breaks, size];
}

function lengthOf(measure: Measure): Frac {
  let m = Frac.ZERO;
  for (const [, notes] of play(measure)) for (const [, e] of notes) if (e.gt(m)) m = e;
  return m;
}

type ThreesByPlace = Map<string, { places: number[]; value: string; three: Three }>;

function findSingleThrees(measure: Measure, symbols: EncodedSymbol[]): ThreesByPlace {
  const found: ThreesByPlace = new Map();
  const voices = [...new Set(measure.flatMap((c) => c.map(([v]) => v)))].sort();
  for (const voice of voices) {
    const chords = measure.map((chord, place) => [place, chord.filter(([v]) => v === voice).map(([, , idx]) => idx)] as [number, number[]]).filter(([, n]) => n.length);
    const values: (string | null)[] = chords.map(([, notes]) => {
      const matches = notes.map((i) => PLAIN.exec(symbols[i].rhythm));
      const plain = new Set(matches.filter((m): m is RegExpExecArray => m !== null).map((m) => m[2]));
      return matches.every((m) => m !== null) && plain.size === 1 ? [...plain][0] : null;
    });
    let startOfRun = 0;
    values.forEach((value, i) => {
      if (i > 0 && (value === null || value !== values[i - 1])) startOfRun = i;
      if (value === null || values.length < i + 3 || values[i + 1] !== value || values[i + 2] !== value) return;
      const inVoice = chords.slice(i, i + 3).flatMap(([, notes]) => notes);
      if (!inVoice.some((idx) => symbols[idx].rhythm.startsWith('note'))) return;
      const places = chords.slice(i, i + 3).map(([p]) => p);
      const key = `${places.join(',')}|${value}`;
      const prev = found.get(key);
      const set = prev ? prev.three[0] : new Set<number>();
      inVoice.forEach((x) => set.add(x));
      found.set(key, { places, value, three: [set, (prev ? prev.three[1] : false) || (i - startOfRun) % 3 !== 0] });
    });
  }
  return found;
}

const setKey = (s: Set<number>) => [...s].sort((a, b) => a - b).join(',');
const disjoint = (a: Set<number>, b: Set<number>) => ![...a].some((x) => b.has(x));

function addFollowingThree(inARow: ThreesByPlace, single: ThreesByPlace, measure: Measure, symbols: EncodedSymbol[]): ThreesByPlace {
  const longer: ThreesByPlace = new Map();
  for (const { places, value, three } of inARow.values()) {
    const [indices, offBeat] = three;
    const voices = new Set([...indices].map((i) => symbols[i].position));
    let nextPlace: number | null = null;
    for (let p = places[places.length - 1] + 1; p < measure.length; p++) {
      if (measure[p].some(([v]) => voices.has(v))) {
        nextPlace = p;
        break;
      }
    }
    for (const s of single.values()) {
      const nv = new Set([...s.three[0]].map((i) => symbols[i].position));
      if (s.value === value && s.places[0] === nextPlace && disjoint(indices, s.three[0]) && nv.size === voices.size && [...nv].every((v) => voices.has(v))) {
        const pl = [...places, ...s.places];
        longer.set(`${pl.join(',')}|${value}`, { places: pl, value, three: [new Set([...indices, ...s.three[0]]), offBeat] });
      }
    }
  }
  return longer;
}

function findThrees(measure: Measure, symbols: EncodedSymbol[]): Three[] {
  const single = findSingleThrees(measure, symbols);
  // dict(single.values()): keyed by the (frozen) set of indices, later entries overwrite earlier ones
  const threes = new Map<string, Three>();
  for (const v of single.values()) threes.set(setKey(v.three[0]), v.three);
  let inARow = single;
  for (let k = 0; k < MAX_THREES_IN_A_ROW - 1; k++) {
    inARow = addFollowingThree(inARow, single, measure, symbols);
    for (const v of inARow.values()) if (!threes.has(setKey(v.three[0]))) threes.set(setKey(v.three[0]), v.three);
  }
  const sortedIdx = (t: Three) => [...t[0]].sort((a, b) => a - b);
  return [...threes.values()].sort((a, b) => cmpLists(sortedIdx(a), sortedIdx(b)));
}

function cmpLists(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

function chooseTriplets(measure: Measure, symbols: EncodedSymbol[]): Set<number>[] {
  const chosen: Set<number>[] = [];
  let triplets = new Set<number>();
  let breaks = countBreaks(measure);
  if (breaks[0] === 0 || lengthOf(measure).gt(MAX_MEASURE_LENGTH)) return [];
  const threes = findThrees(measure, symbols);
  for (;;) {
    const trials = threes
      .filter(([idx]) => disjoint(idx, triplets))
      .map(([idx, off]) => ({ b: countBreaks(measure, new Set([...triplets, ...idx])), off, sorted: [...idx].sort((a, c) => a - c), idx }));
    if (!trials.length) break;
    // min by (breaks, size), off-beat (False first), sorted indices
    let best = trials[0];
    const cmp = (x: typeof best, y: typeof best) => x.b[0] - y.b[0] || x.b[1].cmp(y.b[1]) || Number(x.off) - Number(y.off) || cmpLists(x.sorted, y.sorted);
    for (const t of trials.slice(1)) if (cmp(t, best) < 0) best = t;
    if (best.b[0] >= breaks[0]) break;
    chosen.push(best.idx);
    triplets = new Set([...triplets, ...best.idx]);
    breaks = best.b;
  }
  return chosen;
}

const noteValue = (symbols: EncodedSymbol[], idx: Set<number>) => symbols[Math.min(...idx)].rhythm.split('_')[1];

/** homr restore_unmarked_triplets (one voice of a page) */
export function restoreUnmarkedTriplets(symbols: EncodedSymbol[]): EncodedSymbol[] {
  const measures = splitIntoMeasures(symbols);
  const chosen = measures.map((m) => chooseTriplets(m, symbols));
  const shown = new Map<string, number>();
  for (const inMeasure of chosen) for (const idx of inMeasure) shown.set(noteValue(symbols, idx), (shown.get(noteValue(symbols, idx)) ?? 0) + 1);
  const triplets = new Set<number>();
  for (const inMeasure of chosen) for (const idx of inMeasure) if ((shown.get(noteValue(symbols, idx)) ?? 0) >= MIN_TRIPLETS_ON_A_PAGE) idx.forEach((i) => triplets.add(i));
  return symbols.map((s, i) => (triplets.has(i) ? asTriplet(s) : s));
}
