/**
 * A tolerant **kern reader for the recognition model's output (src/lib/omr). The Sheet Music Transformer
 * writes one grand-staff system as "bekern" tokens (see bekernToKern); this module turns the systems of a
 * piece into measures of notes with exact times, ready for musicxml.ts.
 *
 * What it understands: spines (one per staff, the lowest staff first, as in **kern), spine split / merge /
 * end (*^ *v *-), chords (space-separated sub-tokens), rests, dots, any duration number (tuplets such as
 * 12 = eighth-note triplet, 20 = quintuplet sixteenth), ties ([ _ ]), grace notes (q), clefs, key and time
 * signatures, bar lines. Model mistakes are expected, so malformed lines are padded or cut instead of
 * rejected, and every bar is snapped to the time signature: both hands start each bar together, a bar
 * whose notes add up to less than the time signature is filled up with rest, and a bar whose notes add up
 * to more is lengthened (by default) so no note is lost — one wrong duration cannot shift one hand
 * against the other for the rest of the piece. (Measured on the research test set: squeezing or cutting
 * over-full bars instead lost more notes than it fixed.)
 */
import { add, cmp, div, frac, max, mul, sub, ZERO, type Frac } from './frac';

export type Staff = 1 | 2;

export interface Clef {
  sign: 'G' | 'F' | 'C';
  line: number;
  /** octave shift (treble-8vb clef: -1) */
  octave?: number;
}

export interface KernNote {
  /** 1 = upper staff (right hand), 2 = lower staff */
  staff: Staff;
  /** quarter notes from the start of the piece */
  onset: Frac;
  /** quarter notes; zero for grace notes */
  dur: Frac;
  rest: boolean;
  grace?: boolean;
  /** pitch (absent for rests) */
  step?: 'C' | 'D' | 'E' | 'F' | 'G' | 'A' | 'B';
  alter?: number;
  octave?: number;
  midi?: number;
  tie?: 'start' | 'stop' | 'both';
}

export interface Meter {
  beats: number;
  beatType: number;
}

export interface KernMeasure {
  /** quarter notes from the start of the piece */
  start: Frac;
  length: Frac;
  /** first measure of a recognised system (line of music) */
  systemStart: boolean;
  system: number;
  /** a pickup (first bar shorter than the time signature) */
  pickup?: boolean;
  /** set where the time signature / key / clefs start or change */
  meter?: Meter;
  fifths?: number;
  clefs?: Partial<Record<Staff, Clef>>;
  notes: KernNote[];
  /** a hand had more notes than fit in the time signature */
  overfull?: boolean;
}

export interface KernPiece {
  measures: KernMeasure[];
  /** time signature of the first measure (absent when the model wrote none) */
  meter?: Meter;
  fifths: number;
  warnings: string[];
  /** bars whose notes add up to more than the time signature */
  overfullBars: number;
}

/** bekern token stream (as the model writes it) → plain **kern text. */
export function bekernToKern(tokens: string | string[]): string {
  const s = typeof tokens === 'string' ? tokens : tokens.join('');
  return s.replace(/<b>/g, '\n').replace(/<t>/g, '\t').replace(/<s>/g, ' ').replace(/[·@]/g, '');
}

// ------------------------------------------------------------------ tokens

const STEP: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** Duration of a kern token in quarter notes (null when it has none). */
export function kernDuration(tok: string): Frac | null {
  const m = /(\d+)(?:%(\d+))?(\.*)/.exec(tok);
  if (!m) return null;
  const n = Number(m[1]);
  let base: Frac;
  if (m[1] === '0') base = frac(8);
  else if (m[1] === '00') base = frac(16);
  else if (n > 0) base = frac(4 * (m[2] ? Number(m[2]) || 1 : 1), n); // "n%m": m/n of a whole note
  else return null;
  let d = base;
  let addv = base;
  for (let i = 0; i < m[3].length; i++) {
    addv = div(addv, frac(2));
    d = add(d, addv);
  }
  return d;
}

export interface KernPitch {
  step: KernNote['step'] & string;
  alter: number;
  octave: number;
  midi: number;
}

/** Pitch of a kern token: c = middle C (C4), cc = C5, C = C3, CC = C2; # sharp, - flat, n natural. */
export function kernPitch(tok: string): KernPitch | null {
  const m = /([a-gA-G])\1*/.exec(tok);
  if (!m) return null;
  const letter = m[1];
  const lower = letter === letter.toLowerCase();
  const reps = m[0].length;
  const octave = lower ? 3 + reps : 4 - reps;
  const rest = tok.slice(m.index + reps);
  const acc = /^[#\-n]*/.exec(rest)?.[0] ?? '';
  const alter = (acc.match(/#/g)?.length ?? 0) - (acc.match(/-/g)?.length ?? 0);
  const midi = 12 * (octave + 1) + STEP[letter.toLowerCase()] + alter;
  if (midi < 0 || midi > 127) return null;
  return { step: letter.toUpperCase() as KernPitch['step'], alter, octave, midi };
}

function parseClef(tok: string): Clef | null {
  const m = /^\*clef([GFC])(v+|\^+)?(\d)$/.exec(tok);
  if (!m) return null;
  const sign = m[1] as Clef['sign'];
  const shift = m[2] ? (m[2][0] === 'v' ? -m[2].length : m[2].length) : 0;
  return { sign, line: Number(m[3]), ...(shift ? { octave: shift } : {}) };
}

function parseKey(tok: string): number | null {
  const m = /^\*k\[([a-g#\-n]*)\]$/.exec(tok);
  if (!m) return null;
  const sharps = m[1].match(/#/g)?.length ?? 0;
  const flats = m[1].match(/-/g)?.length ?? 0;
  return sharps ? sharps : -flats;
}

function parseMeter(tok: string): Meter | null {
  const m = /^\*M(\d+)\/(\d+)$/.exec(tok);
  if (!m) return null;
  const beats = Number(m[1]);
  const beatType = Number(m[2]);
  if (!(beats > 0 && beats <= 32) || ![1, 2, 4, 8, 16, 32].includes(beatType)) return null;
  return { beats, beatType };
}

// ------------------------------------------------------------------ pass 1: raw bars

interface RawNote extends Omit<KernNote, 'onset'> {
  /** quarter notes from the start of the bar */
  rel: Frac;
}

interface RawBar {
  notes: RawNote[];
  /** where each staff's notes and rests end, from the bar start */
  span: Record<Staff, Frac>;
  meter?: Meter;
  fifths?: number;
  clefs?: Partial<Record<Staff, Clef>>;
  system: number;
  systemStart: boolean;
}

interface Column {
  staff: Staff;
  /** time (from the bar start) this spine is busy until */
  end: Frac;
}

function readSystem(text: string, system: number, warn: (w: string) => void): RawBar[] {
  const lines = text.replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
  const bars: RawBar[] = [];
  let cols: Column[] | null = null;
  let bar: RawBar | null = null;
  let t: Frac = ZERO;
  const newBar = (): RawBar => ({ notes: [], span: { 1: ZERO, 2: ZERO }, system, systemStart: bars.length === 0 });
  const curBar = () => (bar ??= newBar());
  const initCols = (n: number) => {
    // **kern lists the lowest staff first: the lower half of the spines is the left hand
    cols = Array.from({ length: n }, (_, i) => ({ staff: (n === 1 || i >= n / 2 ? 1 : 2) as Staff, end: ZERO }));
  };
  const closeBar = () => {
    if (!bar) return;
    for (const c of cols ?? []) bar.span[c.staff] = max(bar.span[c.staff], c.end);
    const empty = !bar.notes.length && cmp(bar.span[1], ZERO) <= 0 && cmp(bar.span[2], ZERO) <= 0;
    if (!empty) bars.push(bar);
    // clef / key / time written before a bar line (the system header): carry them to the next bar
    else if (bar.meter || bar.fifths !== undefined || bar.clefs) pending = { meter: bar.meter, fifths: bar.fifths, clefs: bar.clefs };
    bar = null;
    t = ZERO;
    for (const c of cols ?? []) c.end = ZERO;
  };
  let pending: Pick<RawBar, 'meter' | 'fifths' | 'clefs'> | null = null;
  const applyPending = (b: RawBar) => {
    if (!pending) return;
    b.meter ??= pending.meter;
    if (b.fifths === undefined && pending.fifths !== undefined) b.fifths = pending.fifths;
    if (pending.clefs) b.clefs = { ...pending.clefs, ...b.clefs };
    pending = null;
  };

  for (const line of lines) {
    if (line.startsWith('!')) continue;
    const f = line.split('\t').map((s) => s.trim());
    if (f[0].startsWith('**')) {
      if ((bar as RawBar | null)?.notes.length || cmp(t, ZERO) > 0) closeBar();
      initCols(f.length);
      continue;
    }
    if (!cols) initCols(f.length);
    const C = cols as unknown as Column[];
    if (f[0].startsWith('=')) {
      closeBar();
      continue;
    }
    if (f[0].startsWith('*')) {
      // interpretations and spine manipulators, one per spine
      const next: Column[] = [];
      for (let i = 0; i < Math.max(f.length, C.length); i++) {
        const tok = f[i] ?? '*';
        const col = C[i] ?? { staff: C[C.length - 1]?.staff ?? 1, end: t };
        if (i >= C.length && f.length > C.length) {
          // a field without a spine: ignore it
          continue;
        }
        if (tok === '*^') next.push({ ...col }, { ...col });
        else if (tok === '*v') {
          const prev = next[next.length - 1];
          if (i > 0 && f[i - 1] === '*v' && prev) prev.end = max(prev.end, col.end);
          else next.push({ ...col });
        } else if (tok === '*-') {
          /* spine ends */
        } else {
          next.push(col);
          const b = curBar();
          const clef = parseClef(tok);
          if (clef) {
            b.clefs ??= {};
            b.clefs[col.staff] ??= clef;
          }
          const k = parseKey(tok);
          if (k !== null) b.fifths ??= k;
          const m = parseMeter(tok);
          if (m) b.meter ??= m;
        }
      }
      // all spines ended: the system is over
      if (!next.length) {
        closeBar();
        cols = null;
        continue;
      }
      cols = next;
      continue;
    }
    // a data line at time t
    if (f.length !== C.length) {
      if (f.length > C.length && C.length) warn('extra-fields');
      while (f.length < C.length) f.push('.');
    }
    const b = curBar();
    applyPending(b);
    for (let i = 0; i < C.length; i++) {
      const field = f[i];
      if (!field || field === '.' || field.startsWith('*') || field.startsWith('!') || field.startsWith('=')) continue;
      const col = C[i];
      let step: Frac | null = null;
      for (const sub0 of field.split(' ')) {
        const tok = sub0.trim();
        if (!tok || tok === '.') continue;
        const grace = /[qQ]/.test(tok);
        const d = kernDuration(tok);
        if (!grace && !d) continue;
        const isRest = /r/.test(tok);
        const tie: KernNote['tie'] = tok.includes('[') ? 'start' : tok.includes(']') ? 'stop' : tok.includes('_') ? 'both' : undefined;
        if (isRest) {
          if (!grace && d) b.notes.push({ staff: col.staff, rel: t, dur: d, rest: true });
        } else {
          const p = kernPitch(tok);
          if (!p) continue;
          b.notes.push({ staff: col.staff, rel: t, dur: grace ? ZERO : (d as Frac), rest: false, ...(grace ? { grace: true } : {}), ...p, ...(tie ? { tie } : {}) });
        }
        if (!grace && d) step = step && cmp(step, d) <= 0 ? step : d;
      }
      if (step) col.end = add(t, step);
    }
    // the next line starts when the first spine that is still sounding is free
    let nt: Frac | null = null;
    for (const c of C) if (cmp(c.end, t) > 0 && (!nt || cmp(c.end, nt) < 0)) nt = c.end;
    if (nt) t = nt;
  }
  closeBar();
  return bars;
}

// ------------------------------------------------------------------ pass 2: bars on the time line

const barLength = (m: Meter): Frac => frac(4 * m.beats, m.beatType);
const sameMeter = (a?: Meter, b?: Meter) => !!a && !!b && a.beats === b.beats && a.beatType === b.beatType;

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const meterFromQuarters = (q: number): Meter | null =>
  Number.isInteger(q) && q >= 1 && q <= 12 ? { beats: q, beatType: 4 } : Number.isInteger(2 * q) && q > 0 && q <= 6 ? { beats: 2 * q, beatType: 8 } : null;

/**
 * The model sometimes misreads the time signature itself (3/4 for 4/4). When most full bars agree on
 * one length and hardly any match the written time signature, the bars win: every occurrence of that
 * time signature is replaced (pickup and last bar left out of the vote).
 */
function fixMisreadMeter(raw: RawBar[]): void {
  const declared = raw.find((b) => b.meter)?.meter;
  if (!declared) return;
  const inner = raw.slice(1, -1).filter((b) => b.notes.length);
  if (inner.length < 4) return;
  const len = (b: RawBar) => {
    const f = max(b.span[1], b.span[2]);
    return f.n / f.d;
  };
  const counts = new Map<number, number>();
  for (const b of inner) counts.set(len(b), (counts.get(len(b)) ?? 0) + 1);
  let mode = 0;
  let modeCount = 0;
  for (const [v, c] of counts) if (c > modeCount) (mode = v), (modeCount = c);
  const want = barLength(declared).n / barLength(declared).d;
  const agree = counts.get(want) ?? 0;
  const fixed = meterFromQuarters(mode);
  if (!fixed || Math.abs(mode - want) < 1e-9 || modeCount < 0.5 * inner.length || agree > 0.25 * inner.length) return;
  for (const b of raw) if (b.meter && sameMeter(b.meter, declared)) b.meter = fixed;
}

/**
 * The systems of a piece, top to bottom and page by page, as **kern texts (bekernToKern) → measures
 * on one time line. The first system's time signature carries over: later systems usually show none,
 * and the model then sometimes guesses one; such a guess is only taken when that system's bars fit it
 * better.
 */
export interface KernOptions {
  /**
   * What to do with a hand whose notes run past the end of the bar: 'extend' (default) makes the bar
   * longer, 'squeeze' scales the hand's notes into the bar, 'clip' drops the notes that start after the
   * bar and shortens the rest. 'none' does not snap bars at all (every bar is as long as its longest
   * hand, a short bar stays short).
   */
  overfull?: 'extend' | 'squeeze' | 'clip' | 'none';
}

export function parseKernSystems(systems: string[], opts: KernOptions = {}): KernPiece {
  const overfull = opts.overfull ?? 'extend';
  const warnings = new Set<string>();
  const raw: RawBar[] = [];
  systems.forEach((text, i) => raw.push(...readSystem(text, i, (w) => warnings.add(w))));
  const measures: KernMeasure[] = [];
  let meter: Meter | undefined;
  let firstMeter: Meter | undefined;
  let fifths: number | undefined;
  let firstFifths: number | undefined;
  const clefs: Partial<Record<Staff, Clef>> = {};
  let start: Frac = ZERO;
  let overfullBars = 0;
  const spanOf = (b: RawBar) => max(b.span[1], b.span[2]);
  const keyVotes = new Map<number, number>();
  for (const b of raw) if (b.systemStart && b.fifths !== undefined) keyVotes.set(b.fifths, (keyVotes.get(b.fifths) ?? 0) + 1);
  // most votes; a tie goes to the first system's key
  let usualFifths: number | undefined;
  for (const b of raw) {
    if (!b.systemStart || b.fifths === undefined) continue;
    if (usualFifths === undefined || keyVotes.get(b.fifths)! > keyVotes.get(usualFifths)!) usualFifths = b.fifths;
  }
  fixMisreadMeter(raw);
  for (let k = 0; k < raw.length; k++) {
    const b = raw[k];
    let meterChange: Meter | undefined;
    if (b.meter && !sameMeter(b.meter, meter)) {
      let take = true;
      if (meter && b.systemStart) {
        // a system's opening time signature that differs from the running one: only if its bars agree
        const spans = raw.filter((r, j) => j > k && r.system === b.system).map((r) => (r.notes.length ? spanOf(r).n / spanOf(r).d : 0));
        const mid = spans.length ? median(spans) : spanOf(b).n / spanOf(b).d;
        const dNew = Math.abs(mid - barLength(b.meter).n / barLength(b.meter).d);
        const dOld = Math.abs(mid - barLength(meter).n / barLength(meter).d);
        take = dNew < dOld;
      }
      if (take) {
        meter = b.meter;
        meterChange = b.meter;
        firstMeter ??= b.meter;
      }
    }
    let fifthsChange: number | undefined;
    // a system's opening key signature is read again on every line and is sometimes misread: the
    // piece's most common one wins; only a change in the middle of a line is taken as written
    const bf = b.systemStart && b.fifths !== undefined ? (fifths === undefined ? usualFifths : fifths) : b.fifths;
    if (bf !== undefined && bf !== fifths) {
      fifths = bf;
      fifthsChange = bf;
      firstFifths ??= bf;
    }
    let clefChange: Partial<Record<Staff, Clef>> | undefined;
    for (const s of [1, 2] as Staff[]) {
      const c = b.clefs?.[s];
      if (c && (!clefs[s] || clefs[s]!.sign !== c.sign || clefs[s]!.line !== c.line || clefs[s]!.octave !== c.octave)) {
        clefs[s] = c;
        (clefChange ??= {})[s] = c;
      }
    }
    const span = spanOf(b);
    let length: Frac;
    let pickup = false;
    const nominal = meter ? barLength(meter) : span;
    const over = cmp(span, nominal) > 0;
    if (!meter || overfull === 'none') length = span;
    else if (measures.length === 0 && cmp(span, nominal) < 0 && cmp(span, ZERO) > 0) {
      length = span;
      pickup = true;
    } else length = overfull === 'extend' ? max(nominal, span) : nominal;
    const factor: Record<Staff, Frac> = { 1: frac(1), 2: frac(1) };
    if (overfull === 'squeeze') for (const s of [1, 2] as Staff[]) if (cmp(b.span[s], length) > 0) factor[s] = div(length, b.span[s]);
    if (over) overfullBars++;
    let notes: KernNote[] = b.notes.map(({ rel, ...n }) => ({
      ...n,
      onset: add(start, mul(rel, factor[n.staff])),
      dur: mul(n.dur, factor[n.staff]),
    }));
    if (overfull === 'clip' && over) {
      const end = add(start, length);
      notes = notes
        .filter((n) => cmp(n.onset, end) < 0)
        .map((n) => (cmp(add(n.onset, n.dur), end) > 0 ? { ...n, dur: sub(end, n.onset) } : n));
    }
    measures.push({
      start,
      length,
      system: b.system,
      systemStart: b.systemStart,
      notes,
      ...(pickup ? { pickup: true } : {}),
      ...(meterChange ? { meter: meterChange } : {}),
      ...(fifthsChange !== undefined ? { fifths: fifthsChange } : {}),
      ...(clefChange ? { clefs: clefChange } : {}),
      ...(over ? { overfull: true } : {}),
    });
    start = add(start, length);
  }
  // the first measure carries the full set of attributes
  if (measures.length) {
    const m0 = measures[0];
    m0.clefs = { 1: { sign: 'G', line: 2 }, 2: { sign: 'F', line: 4 }, ...firstClefs(measures) };
    if (firstFifths === undefined) m0.fifths = 0;
  }
  const out: KernPiece = { measures, fifths: firstFifths ?? 0, warnings: [...warnings], overfullBars };
  if (firstMeter) out.meter = firstMeter;
  return out;
}

function firstClefs(measures: KernMeasure[]): Partial<Record<Staff, Clef>> {
  const out: Partial<Record<Staff, Clef>> = {};
  for (const m of measures) {
    for (const s of [1, 2] as Staff[]) if (m.clefs?.[s] && !out[s]) out[s] = m.clefs[s];
    if (out[1] && out[2]) break;
  }
  return out;
}

/** End of the last measure (quarter notes). */
export function pieceLength(p: KernPiece): Frac {
  const last = p.measures[p.measures.length - 1];
  return last ? add(last.start, last.length) : ZERO;
}

/** Sounding notes as (midi, onset in quarters) pairs with ties merged — for scoring and tests. */
export function soundingNotes(p: KernPiece): { midi: number; onset: number; dur: number; staff: Staff }[] {
  const out: { midi: number; onset: number; dur: number; staff: Staff }[] = [];
  const open = new Map<string, number>();
  for (const m of p.measures) {
    for (const n of m.notes) {
      if (n.rest || n.grace || n.midi === undefined) continue;
      const key = `${n.staff}:${n.midi}`;
      const on = n.onset.n / n.onset.d;
      const d = n.dur.n / n.dur.d;
      if ((n.tie === 'stop' || n.tie === 'both') && open.has(key)) {
        const i = open.get(key)!;
        out[i].dur = on + d - out[i].onset;
        if (n.tie === 'stop') open.delete(key);
        continue;
      }
      out.push({ midi: n.midi, onset: on, dur: d, staff: n.staff });
      if (n.tie === 'start' || n.tie === 'both') open.set(key, out.length - 1);
      else open.delete(key);
    }
  }
  return out.sort((a, b) => a.onset - b.onset || a.midi - b.midi);
}

