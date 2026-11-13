// SPDX-License-Identifier: AGPL-3.0-only
// Modified (TypeScript port of homr 0.7.1) by the Piano2Vision contributors, 2026; see README.md here.
/**
 * The transformer's vocabulary and the cleanup of its symbols: port of
 * homr/transformer/vocabulary.py, plus a small exact fraction type (Python's fractions.Fraction).
 *
 * Derived from homr (AGPL-3.0, Copyright the homr contributors, https://github.com/liebharc/homr).
 */

// ------------------------------------------------------------------ Fraction

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

export class Frac {
  readonly n: number;
  readonly d: number;
  constructor(n: number, d = 1) {
    if (d === 0) throw new Error('Fraction with denominator 0');
    if (d < 0) (n = -n), (d = -d);
    const g = gcd(n, d) || 1;
    this.n = n / g;
    this.d = d / g;
  }
  static readonly ZERO = new Frac(0);
  add(o: Frac): Frac {
    return new Frac(this.n * o.d + o.n * this.d, this.d * o.d);
  }
  sub(o: Frac): Frac {
    return new Frac(this.n * o.d - o.n * this.d, this.d * o.d);
  }
  mul(o: Frac | number): Frac {
    return typeof o === 'number' ? new Frac(this.n * o, this.d) : new Frac(this.n * o.n, this.d * o.d);
  }
  div(o: Frac | number): Frac {
    return typeof o === 'number' ? new Frac(this.n, this.d * o) : new Frac(this.n * o.d, this.d * o.n);
  }
  cmp(o: Frac): number {
    return this.n * o.d - o.n * this.d;
  }
  lt(o: Frac) {
    return this.cmp(o) < 0;
  }
  gt(o: Frac) {
    return this.cmp(o) > 0;
  }
  eq(o: Frac) {
    return this.n === o.n && this.d === o.d;
  }
  value(): number {
    return this.n / this.d;
  }
  key(): string {
    return `${this.n}/${this.d}`;
  }
}

export const fmin = (a: Frac[]) => a.reduce((m, x) => (x.lt(m) ? x : m));
export const fmax = (a: Frac[]) => a.reduce((m, x) => (x.gt(m) ? x : m));

/** numpy.median of fractions (the mean of the two middle values for an even count) */
export function fmedian(a: Frac[]): Frac {
  const s = [...a].sort((x, y) => x.cmp(y));
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : s[m - 1].add(s[m]).div(2);
}

// ------------------------------------------------------------------ vocabulary

export const NONOTE = '.';
export const EMPTY = '_';

const TIME_DENOMINATORS = [1, 2, 3, 4, 6, 8, 12, 16, 32, 48];
const DYNAMICS = ['pppp', 'ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'sfz', 'sffz', 'fp', 'sf', 'fz', 'rf', 'rfz', 'sfp', 'empty'];
const DYNAMICS_MODIFIER = ['piu', 'dolce', 'poco', 'espress', 'subito', 'atempo', 'leggiero', 'pocopiu', 'sempre'];

function buildRhythm(): string[] {
  const r: string[] = ['PAD', 'BOS', 'EOS', 'chord', 'barline', 'doublebarline', 'bolddoublebarline', 'repeatStart', 'repeatEnd', 'repeatEndStart', 'voltaStart', 'voltaStop', 'voltaDiscontinue'];
  for (let c = 3; c < 6; c++) r.push(`clef_F${c}`);
  for (let c = 1; c < 6; c++) r.push(`clef_C${c}`);
  for (let c = 1; c < 3; c++) r.push(`clef_G${c}`);
  r.push('clef_TAB5');
  for (let c = -7; c < 8; c++) r.push(`keySignature_${c}`);
  for (const c of TIME_DENOMINATORS) r.push(`timeSignature/${c}`);
  for (let c = 2; c < 11; c++) r.push(`rest_${c}m`);
  const kernValues: string[] = [];
  for (const d of [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 32, 64, 128]) for (const g of ['', 'G']) for (const dot of ['', '.', '..']) kernValues.push(`${d}${g}${dot}`);
  const irregular = [7, 11, 13, 18, 20, 21, 22, 24, 26, 28, 30, 34, 36, 40, 48, 56, 96];
  for (const d of kernValues) r.push(`note_${d}`);
  for (const d of irregular) r.push(`note_${d}`);
  for (const d of kernValues) r.push(`rest_${d}`);
  for (const d of irregular) r.push(`rest_${d}`);
  for (const d of DYNAMICS) r.push(`dynamic_${d}`);
  return r;
}

const ARTICULATIONS_LIEDER =
  'accent accent_accentStrong accent_arpeggiate accent_arpeggiate_fermata accent_arpeggiate_staccato accent_arpeggiate_tenuto accent_breathMark accent_breathMark_fermata accent_fermata accent_fermata_tremolo accent_staccatissimo accent_staccato accent_staccato_tenuto accent_staccato_tremolo accent_staccato_trill accent_tenuto accent_tremolo accent_trill accentStrong accentStrong_arpeggiate accentStrong_arpeggiate_fermata accentStrong_arpeggiate_staccato accentStrong_arpeggiate_tenuto accentStrong_breathMark accentStrong_breathMark_fermata accentStrong_fermata accentStrong_fermata_tremolo accentStrong_staccatissimo accentStrong_staccato accentStrong_staccato_tenuto accentStrong_staccato_tremolo accentStrong_staccato_trill accentStrong_tenuto accentStrong_tremolo accentStrong_trill arpeggiate arpeggiate_breathMark arpeggiate_fermata arpeggiate_fermata_staccato arpeggiate_fermata_tenuto arpeggiate_staccatissimo arpeggiate_staccatissimo_staccato arpeggiate_staccato arpeggiate_staccato_tenuto arpeggiate_tenuto arpeggiate_tremolo arpeggiate_trill breathMark breathMark_fermata breathMark_fermata_tenuto breathMark_staccato breathMark_tenuto breathMark_tremolo breathMark_trill fermata fermata_staccato fermata_tenuto fermata_tremolo fermata_trill fermata_turn mordent staccatissimo staccatissimo_staccato staccatissimo_staccato_tenuto staccatissimo_staccato_tenuto_trill staccatissimo_tenuto staccato staccato_tenuto staccato_tremolo staccato_trill staccato_turn tenuto tenuto_tremolo tenuto_trill tremolo trill trill_turn turn'.split(
    ' ',
  );

/** Token id → token, per decoder output (the order of homr's Vocabulary dicts). */
export const VOCAB = {
  rhythm: buildRhythm(),
  lift: [NONOTE, EMPTY, '#', '##', 'N', 'b', 'bb'],
  articulation: [NONOTE, EMPTY, ...ARTICULATIONS_LIEDER, ...DYNAMICS_MODIFIER.map((d) => `dynamic_${d}`)],
  pitch: [NONOTE, EMPTY, ...(() => {
    const p: string[] = [];
    for (let o = 0; o < 10; o++) for (const n of ['C', 'D', 'E', 'F', 'G', 'A', 'B']) p.push(`${n}${o}`);
    return p.reverse();
  })()],
  slur: [NONOTE, EMPTY, 'slurStart_slurStop', 'slurStart', 'slurStop'],
  position: [NONOTE, 'upper', 'upper2', 'lower', 'lower2'],
};

export const isLowerPosition = (p: string) => p.startsWith('lower');
export const isUpperOrNoPosition = (p: string) => !isLowerPosition(p);

// ------------------------------------------------------------------ durations

export class SymbolDuration {
  actualNotes: number;
  normalNotes: number;
  fraction: Frac;
  constructor(
    public baseDuration: Frac,
    public dots: number,
    actual: number,
    normal: number,
    public kern: number,
  ) {
    const an = new Frac(actual, normal);
    this.actualNotes = an.n;
    this.normalNotes = an.d;
    let dur = baseDuration;
    let add = dur.div(2);
    for (let i = 0; i < dots; i++) {
      dur = dur.add(add);
      add = add.div(2);
    }
    if (this.actualNotes !== this.normalNotes) dur = dur.mul(new Frac(this.normalNotes, this.actualNotes));
    this.fraction = dur;
  }
}

function priorPowerOfTwo(n: number): number {
  if (n < 1) return 1;
  return 2 ** Math.floor(Math.log2(n));
}

export function kernToDuration(kern: string): SymbolDuration {
  if (kern.endsWith('m')) return new SymbolDuration(new Frac(1), 0, 1, 1, 4);
  let i = 0;
  while (i < kern.length && kern[i] >= '0' && kern[i] <= '9') i++;
  const base = i ? parseInt(kern.slice(0, i), 10) : 4;
  const dots = [...kern.slice(i)].filter((c) => c === '.').length;
  if (kern.includes('G')) return new SymbolDuration(new Frac(0), dots, 1, 1, base);
  if (base === 0) return new SymbolDuration(new Frac(1), dots, 1, 1, base);
  if ((base & (base - 1)) === 0) return new SymbolDuration(new Frac(1, base), dots, 1, 1, base);
  const normal = priorPowerOfTwo(base);
  return new SymbolDuration(new Frac(1, normal), dots, base, normal, normal);
}

// ------------------------------------------------------------------ symbols

export class EncodedSymbol {
  /** transformer attention → staff image coordinates (unused here) */
  private dur: SymbolDuration | null = null;
  constructor(
    public rhythm: string,
    public pitch = NONOTE,
    public lift = NONOTE,
    public articulation = NONOTE,
    public slur = NONOTE,
    public position = NONOTE,
  ) {}

  clone(): EncodedSymbol {
    return new EncodedSymbol(this.rhythm, this.pitch, this.lift, this.articulation, this.slur, this.position);
  }

  toString(): string {
    return [this.rhythm, this.pitch, this.lift, this.articulation, this.slur, this.position].join(' ');
  }

  key(): string {
    return this.toString();
  }

  removeTuplet(): EncodedSymbol {
    const m = /^(note|rest)_(\d+)(.*)$/s.exec(this.rhythm);
    if (!m) return this;
    let d = parseInt(m[2], 10);
    if (d % 3 === 0) d = (d / 3) * 2;
    else if (d % 5 === 0) d = (d / 5) * 4;
    else if (d % 7 === 0) d = (d / 7) * 4;
    else return this;
    const r = this.clone();
    r.rhythm = `${m[1]}_${d}${m[3]}`;
    return r;
  }

  toUpperPosition(): EncodedSymbol {
    if (isUpperOrNoPosition(this.position)) return this;
    const r = this.clone();
    r.position = this.position.replace('lower', 'upper');
    return r;
  }

  getDuration(): SymbolDuration {
    if (this.dur) return this.dur;
    if (!this.rhythm.startsWith('note') && !this.rhythm.startsWith('rest')) return new SymbolDuration(new Frac(0), 0, 1, 1, 1);
    this.dur = kernToDuration(this.rhythm.split('_')[1]);
    return this.dur;
  }
}

const isNoteOrRest = (r: string) => r.startsWith('note') || r.startsWith('rest');
export { isNoteOrRest };

/** Python sorted() of EncodedSymbols: __lt__ is str(self) > str(other), i.e. descending by text (stable). */
export function sortSymbols(chord: EncodedSymbol[]): EncodedSymbol[] {
  return chord
    .map((s, i) => ({ s, i, t: s.toString() }))
    .sort((a, b) => (a.t > b.t ? -1 : a.t < b.t ? 1 : a.i - b.i))
    .map((x) => x.s);
}

function removeRedundantClefsKeysTimes(chords: EncodedSymbol[][]): EncodedSymbol[][] {
  let cu = '';
  let cl = '';
  let key = '';
  let time = '';
  return chords.map((chord) => {
    const out: EncodedSymbol[] = [];
    for (const s of chord) {
      if (s.rhythm.startsWith('clef')) {
        if (isUpperOrNoPosition(s.position)) {
          if (s.rhythm !== cu) {
            cu = s.rhythm;
            out.push(s);
          }
        } else if (s.rhythm !== cl) {
          cl = s.rhythm;
          out.push(s);
        }
      } else if (s.rhythm.startsWith('keySignature')) {
        if (s.rhythm !== key) {
          key = s.rhythm;
          out.push(s);
        }
      } else if (s.rhythm.startsWith('timeSignature')) {
        if (s.rhythm !== time) {
          time = s.rhythm;
          out.push(s);
        }
      } else out.push(s);
    }
    return out;
  });
}

function removeDuplicatedPitches(chord: EncodedSymbol[]): EncodedSymbol[] {
  if (chord.length <= 1 || !isNoteOrRest(chord[0].rhythm)) return chord;
  const by = new Map<string, EncodedSymbol>();
  const order: string[] = [];
  for (const s of chord) {
    const k = `${s.pitch} ${s.position}`;
    if (by.has(k)) {
      // (homr stores the longer one under the pitch alone, which leaves the first one in place)
      if (s.getDuration().fraction.gt((by.get(k) as EncodedSymbol).getDuration().fraction)) by.set(s.pitch, s);
    } else {
      by.set(k, s);
      order.push(k);
    }
  }
  return order.map((k) => by.get(k) as EncodedSymbol);
}

export function groupIntoChords(symbols: EncodedSymbol[]): EncodedSymbol[][] {
  const chords: EncodedSymbol[][] = [];
  let inChord = false;
  for (const s of symbols) {
    if (s.rhythm === 'chord') inChord = true;
    else if (inChord && chords.length) {
      chords[chords.length - 1].push(s);
      inChord = false;
    } else chords.push([s]);
  }
  return chords;
}

function flattenChords(chords: EncodedSymbol[][]): EncodedSymbol[] {
  const out: EncodedSymbol[] = [];
  for (const chord of chords) {
    let inChord = false;
    for (const s of chord) {
      if (inChord) out.push(new EncodedSymbol('chord'));
      out.push(s);
      inChord = true;
    }
  }
  return out;
}

function groupIntoMeasures(chords: EncodedSymbol[][]): EncodedSymbol[][][] {
  const measures: EncodedSymbol[][][] = [];
  let cur: EncodedSymbol[][] = [];
  for (const c of chords) {
    cur.push(c);
    if (c.length && (c[0].rhythm.includes('barline') || c[0].rhythm.includes('repeat'))) {
      measures.push(cur);
      cur = [];
    }
  }
  if (cur.length) measures.push(cur);
  return measures;
}

function measureDuration(m: EncodedSymbol[][]): Frac {
  let total = Frac.ZERO;
  for (const chord of m) {
    let d = Frac.ZERO;
    for (const s of chord) {
      if (isNoteOrRest(s.rhythm)) {
        const f = s.getDuration().fraction;
        if (f.gt(Frac.ZERO) && (f.lt(d) || d.eq(Frac.ZERO))) d = f;
      }
    }
    total = total.add(d);
  }
  return total;
}

function fixOverEagerTuplets(chords: EncodedSymbol[][]): EncodedSymbol[][] {
  const measures = groupIntoMeasures(chords);
  const durs = measures.map(measureDuration);
  const typical = durs.length ? [...durs].sort((a, b) => a.cmp(b))[durs.length >> 1] : Frac.ZERO;
  const out = measures.map((m) => (measureDuration(m).lt(typical) ? m.map((c) => c.map((s) => s.removeTuplet())) : m));
  return out.flat();
}

function onlyKeepLowerStaffIfThereIsAClef(chords: EncodedSymbol[][]): EncodedSymbol[][] {
  let hasLower = false;
  let lineStart = 0;
  return chords.map((chord, i) => {
    if (chord.some((s) => s.rhythm === 'newline')) {
      hasLower = false;
      lineStart = i + 1;
    }
    const out: EncodedSymbol[] = [];
    for (const s of chord) {
      if (hasLower) out.push(s);
      else if (i - lineStart < 5 && s.rhythm.startsWith('clef') && isLowerPosition(s.position)) {
        hasLower = true;
        out.push(s);
      } else out.push(s.toUpperPosition());
    }
    return out;
  });
}

/** homr remove_duplicated_symbols */
export function removeDuplicatedSymbols(symbols: EncodedSymbol[], cleanupTuplets = true): EncodedSymbol[] {
  let chords = groupIntoChords(symbols);
  if (cleanupTuplets) {
    chords = fixOverEagerTuplets(chords);
    chords = onlyKeepLowerStaffIfThereIsAClef(chords);
  }
  chords = chords.map(removeDuplicatedPitches);
  chords = removeRedundantClefsKeysTimes(chords);
  return flattenChords(chords);
}

/** homr sort_token_chords */
export function sortTokenChords(symbols: EncodedSymbol[]): EncodedSymbol[][] {
  return groupIntoChords(symbols).map(sortSymbols);
}
