/**
 * Symbols of the voices → MusicXML: port of homr/music_xml_generator.py (without the image-position
 * comments and the title) and of homr/relieur.py, which joins the pages of a document (relieur is
 * based on https://github.com/papoteur-mga/relieur, Apache-2.0).
 *
 * Derived from homr (AGPL-3.0, Copyright the homr contributors, https://github.com/liebharc/homr).
 */
import { El } from './xml';
import { EMPTY, EncodedSymbol, Frac, fmax, fmedian, fmin, isLowerPosition, isNoteOrRest, NONOTE, sortTokenChords, type SymbolDuration } from './vocabulary';

const DURATION_OF_QUARTER = 16;

class ConversionState {
  beats = 4 * DURATION_OF_QUARTER;
  tremolo = 'stop';
  voltaNumber = 1;
  lastVoltaMeasure = -10;
  constructor(
    public division: number,
    public nominator: Frac,
  ) {}
  startVolta(m: number): number {
    this.voltaNumber = m === this.lastVoltaMeasure + 1 ? this.voltaNumber + 1 : 1;
    return this.voltaNumber;
  }
  stopVolta(m: number): number {
    this.lastVoltaMeasure = m;
    return this.voltaNumber;
  }
  toggleTremolo(): string {
    this.tremolo = this.tremolo === 'start' ? 'stop' : 'start';
    return this.tremolo;
  }
}

class SymbolChord {
  constructor(
    public symbols: EncodedSymbol[],
    public tupletMarks: Map<string, string> = new Map(),
  ) {}
  markFor(s: EncodedSymbol): string {
    return this.tupletMarks.get(s.position) ?? '';
  }
  isBarline(): boolean {
    if (!this.symbols.length) return false;
    const r = this.symbols[0].rhythm;
    return r.includes('barline') || r.includes('repeat');
  }
  getDuration(): Frac {
    const d = this.symbols.filter((s) => isNoteOrRest(s.rhythm)).map((s) => s.getDuration().fraction);
    return d.length ? fmin(d) : Frac.ZERO;
  }
  intoPositions(): SymbolChord[] {
    const buckets = new Map<string, EncodedSymbol[]>();
    for (const s of this.symbols) {
      let b = buckets.get(s.position);
      if (!b) buckets.set(s.position, (b = []));
      b.push(s);
    }
    const chords = [...buckets.values()].map((s) => new SymbolChord(s, this.tupletMarks));
    // voices of only rests first (stable sort, reverse=True on a bool key)
    const restOnly = (c: SymbolChord) => c.symbols.every((s) => s.rhythm.startsWith('rest'));
    return chords.map((c, i) => ({ c, i })).sort((a, b) => Number(restOnly(b.c)) - Number(restOnly(a.c)) || a.i - b.i).map((x) => x.c);
  }
}

const getStaff = (s: EncodedSymbol) => (isLowerPosition(s.position) ? 2 : 1);
const xmlVoice = (staff: number, layer: number) => (staff - 1) * 4 + layer + 1;
const POSITION_ATTR = 'homr-position';
const isSecondVoice = (n: El) => (n.get(POSITION_ATTR) ?? '').endsWith('2');
/** int(fraction * division) */
const intDiv = (f: Frac, division: number) => {
  const p = f.mul(division);
  return Math.trunc(p.n / p.d);
};

function timed(group: SymbolChord): EncodedSymbol[] {
  return group.symbols.filter((s) => isNoteOrRest(s.rhythm) && s.getDuration().fraction.gt(Frac.ZERO));
}

function advanceToNextGroup(group: SymbolChord, clock: Frac, sounding: Frac[]): Frac {
  const t = group.symbols.filter((s) => isNoteOrRest(s.rhythm)).map((s) => s.getDuration().fraction).filter((d) => d.gt(Frac.ZERO));
  if (!t.length) return Frac.ZERO;
  sounding.push(...t.map((d) => clock.add(d)));
  return fmin(sounding.filter((e) => e.gt(clock))).sub(clock);
}

class GroupClock {
  time = Frac.ZERO;
  sounding: Frac[] = [];
  voiceFree = new Map<string, Frac>();
  waitForVoices(group: SymbolChord): Frac {
    const free = timed(group).map((s) => this.voiceFree.get(s.position) ?? Frac.ZERO);
    const f = free.length ? fmax(free) : Frac.ZERO;
    const d = f.sub(this.time);
    const gap = d.gt(Frac.ZERO) ? d : Frac.ZERO;
    this.time = this.time.add(gap);
    const t = this.time;
    this.sounding = this.sounding.filter((e) => e.gt(t));
    return gap;
  }
  advance(group: SymbolChord): Frac {
    const shortest = new Map<string, Frac>();
    for (const s of timed(group)) {
      const d = s.getDuration().fraction;
      const cur = shortest.get(s.position);
      shortest.set(s.position, cur && cur.lt(d) ? cur : d);
    }
    for (const [p, d] of shortest) this.voiceFree.set(p, this.time.add(d));
    const adv = advanceToNextGroup(group, this.time, this.sounding);
    this.time = this.time.add(adv);
    const t = this.time;
    this.sounding = this.sounding.filter((e) => e.gt(t));
    return adv;
  }
}

// ------------------------------------------------------------------ tuplets

const isPow2 = (v: number) => v > 0 && (v & (v - 1)) === 0;

function isTupletSym(s: EncodedSymbol): boolean {
  if (!isNoteOrRest(s.rhythm) || s.rhythm.includes('G')) return false;
  const d = s.getDuration();
  return d.normalNotes !== d.actualNotes;
}

function durationAt(group: SymbolChord, position: string): SymbolDuration | null {
  const t = group.symbols.filter((s) => s.position === position && isNoteOrRest(s.rhythm) && !s.rhythm.includes('G'));
  const tup = t.filter(isTupletSym);
  if (tup.length) return tup[0].getDuration();
  if (t.length) return t[0].getDuration();
  return null;
}

function splitIntoMeasuresG(groups: SymbolChord[]): SymbolChord[][] {
  const out: SymbolChord[][] = [];
  let cur: SymbolChord[] = [];
  for (const g of groups) {
    cur.push(g);
    if (g.isBarline()) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

function startTimes(groups: SymbolChord[]): Frac[] {
  const clock = new GroupClock();
  return groups.map((g) => {
    if (g.symbols.some((s) => isNoteOrRest(s.rhythm))) {
      clock.waitForVoices(g);
      const t = clock.time;
      clock.advance(g);
      return t;
    }
    return clock.time;
  });
}

type RunItem = [number, Frac, Frac];

function splitRun(run: RunItem[], measure: (start: Frac, total: Frac, end: Frac) => Frac): [[number, number][], number[]] {
  const tuplets: [number, number][] = [];
  let pending: number[] = [];
  let total = Frac.ZERO;
  for (const [idx, start, dur] of run) {
    pending.push(idx);
    total = total.add(dur);
    if (isPow2(measure(start, total, start.add(dur)).d)) {
      tuplets.push([pending[0], idx]);
      pending = [];
      total = Frac.ZERO;
    }
  }
  return [tuplets, pending];
}

function markRun(groups: SymbolChord[], position: string, run: RunItem[]): void {
  const byLength = splitRun(run, (_s, total) => total);
  const byGrid = splitRun(run, (_s, _t, end) => end);
  const [tuplets, left] = byLength[1].length <= byGrid[1].length ? byLength : byGrid;
  if (left.length) tuplets.push([left[0], left[left.length - 1]]);
  for (const [first, last] of tuplets) {
    if (first === last) groups[first].tupletMarks.set(position, 'start_stop');
    else {
      groups[first].tupletMarks.set(position, 'start');
      groups[last].tupletMarks.set(position, 'stop');
    }
  }
}

function addTuplets(groups: SymbolChord[], position: string): void {
  const times = startTimes(groups);
  let run: RunItem[] = [];
  let fmt = '1/1';
  groups.forEach((g, i) => {
    const d = durationAt(g, position);
    if (!d) return;
    const cur = `${d.actualNotes}/${d.normalNotes}`;
    if (cur !== fmt && run.length) {
      markRun(groups, position, run);
      run = [];
    }
    fmt = cur;
    if (d.actualNotes !== d.normalNotes) run.push([i, times[i], d.fraction]);
  });
  if (run.length) markRun(groups, position, run);
}

function addTupletStartStop(groups: SymbolChord[]): SymbolChord[] {
  for (const m of splitIntoMeasuresG(groups)) {
    const positions = [...new Set(m.flatMap((g) => g.symbols.filter(isTupletSym).map((s) => s.position)))].sort();
    for (const p of positions) addTuplets(m, p);
  }
  return groups;
}

// ------------------------------------------------------------------ mixed chords

const BEFORE_NOTES = ['clef', 'keySignature', 'timeSignature'];

function splitMixedChord(symbols: EncodedSymbol[]): EncodedSymbol[][] {
  const notes = symbols.filter((s) => isNoteOrRest(s.rhythm));
  if (!notes.length || notes.length === symbols.length) return [symbols];
  const others = symbols.filter((s) => !isNoteOrRest(s.rhythm));
  const after = others.filter((s) => s.rhythm.includes('barline') || s.rhythm.includes('repeat'));
  const before = new Map<string, EncodedSymbol[]>();
  for (const s of others) {
    // `s not in after`: by value (EncodedSymbol.__eq__)
    if (after.some((a) => a.key() === s.key())) continue;
    const kind = s.rhythm.split('_')[0].split('/')[0];
    let b = before.get(kind);
    if (!b) before.set(kind, (b = []));
    b.push(s);
  }
  const rank = (k: string) => (BEFORE_NOTES.includes(k) ? BEFORE_NOTES.indexOf(k) : BEFORE_NOTES.length);
  const ordered = [...before.keys()].map((k, i) => ({ k, i })).sort((a, b) => rank(a.k) - rank(b.k) || a.i - b.i).map((x) => x.k);
  return [...ordered.map((k) => before.get(k) as EncodedSymbol[]), notes, ...after.map((s) => [s])];
}

function splitMixedChords(groups: SymbolChord[]): SymbolChord[] {
  const result: SymbolChord[] = [];
  let splitBarline = false;
  for (const g of groups) {
    const parts = splitMixedChord(g.symbols);
    if (splitBarline && g.isBarline() && parts.length === 1) {
      if (g.symbols[0].rhythm === 'barline' && result[result.length - 1].symbols[0].rhythm !== 'barline') {
        splitBarline = false;
        continue;
      }
      result.pop();
    }
    for (const p of parts) {
      const isNotes = isNoteOrRest(p[0].rhythm);
      result.push(new SymbolChord(p, isNotes ? g.tupletMarks : new Map()));
    }
    splitBarline = parts.length > 1 && result[result.length - 1].isBarline();
  }
  return result;
}

// ------------------------------------------------------------------ elements

function lcm(a: number, b: number): number {
  const g = (x: number, y: number): number => (y ? g(y, x % y) : x);
  return Math.abs(a * b) / g(a, b);
}

function findDivisionAndNominators(voice: SymbolChord[]): [number, Frac[]] {
  const durations: Frac[] = [new Frac(1, 4)];
  let inMeasure = Frac.ZERO;
  const segments: Frac[][] = [[]];
  let hasTime = false;
  for (const chord of voice) {
    if (chord.symbols.length && chord.symbols[0].rhythm.startsWith('timeSignature')) {
      if (inMeasure.gt(Frac.ZERO)) {
        segments[segments.length - 1].push(inMeasure);
        inMeasure = Frac.ZERO;
      }
      if (hasTime) segments.push([]);
      hasTime = true;
    } else if (chord.isBarline() && inMeasure.gt(Frac.ZERO)) {
      segments[segments.length - 1].push(inMeasure);
      inMeasure = Frac.ZERO;
    } else {
      for (const s of chord.symbols) {
        if (isNoteOrRest(s.rhythm)) {
          const f = s.getDuration().fraction;
          if (f.gt(Frac.ZERO)) durations.push(f);
        }
      }
      const d = chord.getDuration();
      if (d.gt(Frac.ZERO)) inMeasure = inMeasure.add(d);
    }
  }
  if (inMeasure.gt(Frac.ZERO)) segments[segments.length - 1].push(inMeasure);
  const den = durations.filter((d) => d.gt(Frac.ZERO)).map((d) => d.d);
  const division = den.length ? den.reduce(lcm) : 1;
  const all = segments.flat();
  if (!all.length) return [division, segments.map(() => new Frac(1))];
  const nominators: Frac[] = [];
  let following = fmedian(all);
  for (const seg of [...segments].reverse()) {
    if (seg.length) following = fmedian(seg);
    nominators.push(following);
  }
  nominators.reverse();
  return [division, nominators];
}

const LIFT_TO_ALTER: Record<string, number> = { N: 0, '#': 1, '##': 2, b: -1, bb: -2 };
const DURATION_NAMES: Record<number, string> = { 0: 'breve', 1: 'whole', 2: 'half', 4: 'quarter', 8: 'eighth', 16: '16th', 32: '32nd', 64: '64th', 128: '128th' };

function buildArticulations(note: El, arts: string, tupletMark: string, state: ConversionState): void {
  const notation = note.sub('notations');
  const xa: El[] = [];
  const xo: El[] = [];
  if (!arts.startsWith('dynamic')) {
    for (const a of arts.split('_')) {
      if (a === '' || a === NONOTE) continue;
      else if (a === 'fermata') notation.sub('fermata');
      else if (a === 'arpeggiate') notation.sub('arpeggiate');
      else if (a === 'accent') xa.push(new El('accent'));
      else if (a === 'accentStrong') xa.push(new El('strong-accent'));
      else if (a === 'mordent') xa.push(new El('mordent'));
      else if (a === 'staccato') xa.push(new El('staccato'));
      else if (a === 'staccatissimo') xa.push(new El('staccatissimo'));
      else if (a === 'tenuto') xa.push(new El('tenuto'));
      else if (a === 'tremolo') {
        const e = new El('tremolo', { type: state.toggleTremolo() });
        e.text = '3';
        xo.push(e);
      } else if (a === 'trill') xo.push(new El('trill-mark'));
      else if (a === 'breathMark') xa.push(new El('breath-mark'));
      else if (a === 'turn') xo.push(new El('inverted-turn'));
      else if (a === 'caesura') xa.push(new El('caesura'));
      else if (a === 'doit') xa.push(new El('doit'));
      else if (a === 'slurStart') notation.sub('slur', { type: 'start' });
      else if (a === 'slurStop') notation.sub('slur', { type: 'stop' });
      else if (a === 'tieStart') notation.sub('tied', { type: 'start' });
      else if (a === 'tieStop') notation.sub('tied', { type: 'stop' });
      // (homr raises on an unknown articulation; the vocabulary has none)
    }
  }
  for (const m of tupletMark.split('_')) if (m) notation.sub('tuplet', { type: m });
  if (xa.length) {
    const p = notation.sub('articulations');
    xa.forEach((c) => p.append(c));
  }
  if (xo.length) {
    const p = notation.sub('ornaments');
    xo.forEach((c) => p.append(c));
  }
}

function buildSlurs(note: El, slurs: string, n: number): void {
  const notation = note.find('notations') ?? note.sub('notations');
  if (slurs === '_' || slurs === '' || slurs === NONOTE) return;
  if (slurs === 'slurStart') notation.sub('slur', { type: 'start', number: String(n) });
  else if (slurs === 'slurStop') notation.sub('slur', { type: 'stop', number: String(n) });
  else if (slurs === 'slurStart_slurStop') {
    notation.sub('slur', { type: 'stop', number: String(n) });
    notation.sub('slur', { type: 'start', number: String(n) });
  }
}

function buildNoteOrRest(m: EncodedSymbol, layer: number, isChord: boolean, state: ConversionState, tupletMark: string): El {
  const note = new El('note');
  if (isChord) note.sub('chord');
  const d = m.getDuration();
  const grace = m.rhythm.includes('G');
  if (grace) note.sub('grace');
  if (m.pitch === EMPTY) note.sub('rest', d.fraction.n === 0 ? { measure: 'yes' } : {});
  else if (m.pitch === NONOTE) note.sub('rest');
  else {
    const p = note.sub('pitch');
    p.sub('step', {}, m.pitch[0]);
    p.sub('octave', {}, m.pitch[1]);
    if (m.lift !== NONOTE && m.lift !== EMPTY) p.sub('alter', {}, String(LIFT_TO_ALTER[m.lift]));
  }
  if (grace) note.sub('type', {}, DURATION_NAMES[d.kern]);
  else if (d.fraction.n > 0) {
    const base = d.kern === 0 ? 1 : d.kern;
    note.sub('duration', {}, String(Math.max(1, intDiv(d.fraction, state.division))));
    note.sub('type', {}, DURATION_NAMES[base]);
  } else {
    note.sub('duration', {}, String(state.beats));
    note.sub('type', {}, DURATION_NAMES[0]);
  }
  for (let i = 0; i < d.dots; i++) note.sub('dot');
  if (d.actualNotes !== d.normalNotes) {
    const tm = note.sub('time-modification');
    tm.sub('actual-notes', {}, String(d.actualNotes));
    tm.sub('normal-notes', {}, String(d.normalNotes));
  }
  const staff = getStaff(m);
  note.sub('voice', {}, String(xmlVoice(staff, layer)));
  note.sub('staff', {}, String(staff));
  note.set(POSITION_ATTR, m.position);
  const isTuplet = d.actualNotes !== d.normalNotes;
  buildArticulations(note, m.articulation, isTuplet ? tupletMark : '', state);
  buildSlurs(note, m.slur, staff);
  return note;
}

function buildBackup(d: Frac, state: ConversionState): El {
  const b = new El('backup');
  b.sub('duration', {}, String(Math.max(1, intDiv(d, state.division))));
  return b;
}

function buildForward(d: Frac, state: ConversionState): El {
  const b = new El('forward');
  b.sub('duration', {}, String(Math.max(1, intDiv(d, state.division))));
  return b;
}

function buildMeasureRest(s: EncodedSymbol, state: ConversionState): El {
  const n = new El('note');
  n.sub('rest', { measure: 'yes' });
  n.sub('duration', {}, String(Math.max(1, intDiv(state.nominator, state.division))));
  n.sub('voice', {}, '1');
  n.sub('staff', {}, String(getStaff(s)));
  return n;
}

function groupNotes(notes: EncodedSymbol[]): [Frac, EncodedSymbol[]][] {
  const maxD = fmax(notes.map((n) => n.getDuration().fraction));
  const groups = new Map<string, [Frac, EncodedSymbol[]]>();
  for (const n of notes) {
    const d = n.getDuration();
    const f = n.rhythm.includes('G') ? Frac.ZERO : d.fraction.n === 0 ? maxD : d.fraction;
    let g = groups.get(f.key());
    if (!g) groups.set(f.key(), (g = [f, []]));
    g[1].push(n);
  }
  return [...groups.values()].sort((a, b) => a[0].cmp(b[0]));
}

function buildNoteChord(chord: SymbolChord, state: ConversionState, chordDuration: Frac): El[] {
  const byD = groupNotes(chord.symbols);
  const out: El[] = [];
  byD.forEach(([gd, gn], i) => {
    const notes = gn.filter((n) => n.pitch !== EMPTY && n.pitch !== NONOTE);
    const rests = gn.filter((n) => n.pitch === EMPTY || n.pitch === NONOTE);
    let first = true;
    for (const n of notes) {
      out.push(buildNoteOrRest(n, i, !first, state, chord.markFor(n)));
      first = false;
    }
    if (rests.length && gd.gt(Frac.ZERO)) {
      if (notes.length) out.push(buildBackup(gd, state));
      out.push(buildNoteOrRest(rests[0], i, false, state, chord.markFor(rests[0])));
    }
    if (i !== byD.length - 1 && gd.gt(Frac.ZERO)) out.push(buildBackup(gd, state));
  });
  const maxD = byD[byD.length - 1][0];
  if (chordDuration.lt(maxD)) out.push(buildBackup(maxD.sub(chordDuration), state));
  return out;
}

function rebalanceMeasureVoices(measure: El): void {
  type Ev = { staff: number; start: number; end: number; notes: El[] };
  const events: Ev[] = [];
  let t = 0;
  let lastStart = 0;
  for (const c of measure.children) {
    if (c.tag === 'backup') {
      const d = c.find('duration');
      if (d) t -= parseInt(d.text ?? '0', 10);
      continue;
    }
    if (c.tag === 'forward') {
      const d = c.find('duration');
      if (d) t += parseInt(d.text ?? '0', 10);
      continue;
    }
    if (c.tag !== 'note') continue;
    const de = c.find('duration');
    const dur = de ? parseInt(de.text ?? '0', 10) : 0;
    const se = c.find('staff');
    const staff = se ? parseInt(se.text ?? '1', 10) : 1;
    const isChord = c.find('chord') !== null;
    const start = isChord ? lastStart : t;
    const end = start + dur;
    const last = events[events.length - 1];
    if (isChord && last && last.staff === staff && last.start === start && last.end === end) last.notes.push(c);
    else if (isChord) events.push({ staff, start, end, notes: [c] });
    else {
      lastStart = start;
      t += dur;
      events.push({ staff, start, end, notes: [c] });
    }
  }
  const byStaff = new Map<number, Ev[]>();
  for (const e of events) {
    let l = byStaff.get(e.staff);
    if (!l) byStaff.set(e.staff, (l = []));
    l.push(e);
  }
  for (const [staff, evs] of byStaff) {
    const sorted = evs.map((e, i) => ({ e, i })).sort((a, b) => a.e.start - b.e.start || a.e.end - b.e.end || a.i - b.i).map((x) => x.e);
    let active: [number, number][] = [];
    for (const ev of sorted) {
      active = active.filter(([end]) => end > ev.start);
      const used = new Set(active.map(([, v]) => v));
      let v = isSecondVoice(ev.notes[0]) ? 2 : 1;
      if (used.has(v)) {
        v = 1;
        while (used.has(v)) v++;
      }
      active.push([ev.end, v]);
      const xv = String(xmlVoice(staff, v - 1));
      for (const n of ev.notes) {
        const ve = n.find('voice');
        if (ve) ve.text = xv;
      }
    }
  }
}

function addStems(part: El): void {
  for (const measure of part.findall('measure')) {
    const notes = measure.findall('note').filter((n) => n.find('rest') === null);
    const staffs = [...new Set(notes.map((n) => n.findtext('staff', '1')))];
    for (const staff of staffs) {
      const on = notes.filter((n) => n.findtext('staff', '1') === staff);
      const voices = new Set(on.filter((n) => n.get(POSITION_ATTR)).map(isSecondVoice));
      if (voices.size < 2) continue;
      for (const note of on) {
        const stem = new El('stem');
        stem.text = isSecondVoice(note) ? 'down' : 'up';
        const se = note.find('staff');
        const pos = se ? note.children.indexOf(se) : note.children.length;
        note.insert(pos, stem);
      }
    }
  }
}

function notePitch(n: El): string | null {
  const p = n.find('pitch');
  if (!p) return null;
  return ['step', 'alter', 'octave'].map((k) => p.findtext(k, '')).join('|');
}

function getSlur(n: El, type: string): [El, El] | null {
  for (const notation of n.findall('notations')) for (const s of notation.findall('slur')) if (s.get('type') === type) return [s, notation];
  return null;
}

function addTie(note: El, type: string, notation: El): void {
  const tie = new El('tie', { type });
  const d = note.find('duration');
  note.insert(d ? note.children.indexOf(d) + 1 : 0, tie);
  notation.insert(0, new El('tied', { type }));
}

function groupIntoEvents(measure: El): El[][] {
  const events: El[][] = [];
  for (const n of measure.findall('note')) {
    if (n.find('chord') !== null && events.length) events[events.length - 1].push(n);
    else events.push([n]);
  }
  return events;
}

function tieEvent(before: El[], after: El[]): void {
  for (const start of before) {
    const begins = getSlur(start, 'start');
    if (!begins) continue;
    const pitch = notePitch(start);
    if (pitch === null) continue;
    for (const stop of after) {
      if (notePitch(stop) !== pitch) continue;
      const ends = getSlur(stop, 'stop');
      if (!ends) continue;
      begins[1].remove(begins[0]);
      ends[1].remove(ends[0]);
      addTie(start, 'start', begins[1]);
      addTie(stop, 'stop', ends[1]);
      break;
    }
  }
}

function convertTies(part: El): void {
  const prev = new Map<string, El[]>();
  for (const m of part.findall('measure')) {
    for (const ev of groupIntoEvents(m)) {
      const f = ev[0];
      const k = `${f.findtext('staff', '1')}|${f.findtext('voice', '1')}`;
      const before = prev.get(k);
      prev.set(k, ev);
      if (before) tieEvent(before, ev);
    }
  }
}

function buildMeasures(voice: EncodedSymbol[], hasTwoStaves: boolean): El[] {
  let clock = new GroupClock();
  let measureNumber = 1;
  let restMeasures = 0;
  const groups = splitMixedChords(addTupletStartStop(sortTokenChords(voice).map((c) => new SymbolChord(c))));
  const [division, nominators] = findDivisionAndNominators(groups);
  const state = new ConversionState(division, nominators[0]);
  let timeNo = 0;
  const measures: El[] = [];
  let cur = new El('measure', { number: String(measureNumber) });
  const measureRests = (m: El) => {
    const positions = hasTwoStaves ? ['upper', 'lower'] : ['upper'];
    positions.forEach((p, i) => {
      if (i > 0) m.append(buildBackup(state.nominator, state));
      m.append(buildMeasureRest(new EncodedSymbol('measureRest', NONOTE, NONOTE, NONOTE, NONOTE, p), state));
    });
  };
  const close = () => {
    rebalanceMeasureVoices(cur);
    measures.push(cur);
    clock = new GroupClock();
    for (let k = 0; k < restMeasures; k++) {
      measureNumber++;
      const m = new El('measure', { number: String(measureNumber) });
      measureRests(m);
      measures.push(m);
    }
    restMeasures = 0;
  };
  const getAttributes = (last: El | null, force = false) => (last && !force ? last : cur.sub('attributes'));
  const getBarline = (location: string): El => cur.children.find((c) => c.tag === 'barline' && c.get('location') === location) ?? cur.sub('barline', { location });
  const first = getAttributes(null);
  first.sub('divisions', {}, String(Math.trunc(division / 4)));
  if (hasTwoStaves) {
    first.sub('staves', {}, '2');
    first.sub('part-symbol', {}, 'brace');
  }
  let attributes: El | null = first;
  const newMeasure = () => {
    close();
    measureNumber++;
    cur = new El('measure', { number: String(measureNumber) });
  };
  groups.forEach((group, gi) => {
    const sym = group.symbols[0];
    const r = sym.rhythm;
    const last = attributes;
    attributes = null;
    if (isNoteOrRest(r)) {
      if (group.symbols.length === 1 && r.endsWith('m')) {
        attributes = getAttributes(last);
        let dur = 0;
        if (attributes.find('measure-style') === null) {
          dur = parseInt(r.split('_')[1].replace('m', ''), 10);
          attributes.sub('measure-style').sub('multiple-rest', {}, String(dur));
        }
        if (dur > 0) {
          measureRests(cur);
          restMeasures = dur - 1;
        }
      } else {
        const positions = group.intoPositions();
        const gap = clock.waitForVoices(group);
        if (gap.gt(Frac.ZERO)) cur.append(buildForward(gap, state));
        const adv = clock.advance(group);
        positions.forEach((p, k) => {
          const cd = k === positions.length - 1 ? adv : Frac.ZERO;
          for (const x of buildNoteChord(p, state, cd)) cur.append(x);
        });
      }
      return;
    }
    if (r === 'measureRest') {
      const sorted = group.symbols.map((s, i) => ({ s, i })).sort((a, b) => getStaff(a.s) - getStaff(b.s) || a.i - b.i);
      sorted.forEach(({ s }, k) => {
        if (k > 0) cur.append(buildBackup(state.nominator, state));
        cur.append(buildMeasureRest(s, state));
      });
    } else if (r === 'newline') {
      if (gi !== groups.length - 1) cur.sub('print', { 'new-system': 'yes' });
    } else if (r.startsWith('clef')) {
      attributes = getAttributes(last, true);
      for (const c of group.symbols) {
        if (!c.rhythm.startsWith('clef')) continue;
        const sl = c.rhythm.split('_')[1];
        const clef = attributes.sub('clef', { number: String(getStaff(c)) });
        clef.sub('sign', {}, sl[0]);
        clef.sub('line', {}, sl[1]);
      }
    } else if (r.startsWith('keySignature')) {
      attributes = getAttributes(last);
      attributes.sub('key').sub('fifths', {}, r.split('_')[1]);
    } else if (r.startsWith('timeSignature')) {
      attributes = getAttributes(last);
      state.nominator = nominators[Math.min(timeNo, nominators.length - 1)];
      timeNo++;
      const t = attributes.sub('time');
      const den = r.split('/')[1];
      const beats = Math.max(intDiv(state.nominator, parseInt(den, 10)), 1);
      t.sub('beats', {}, String(beats));
      t.sub('beat-type', {}, den);
      state.beats = beats;
    } else if (r.includes('barline')) {
      if (r !== 'barline') getBarline('right').sub('bar-style', {}, r === 'bolddoublebarline' ? 'heavy-heavy' : 'light-light');
      newMeasure();
    } else if (r === 'repeatStart') {
      newMeasure();
      const b = getBarline('right');
      if (!b.find('repeat')) b.sub('repeat', { direction: 'forward' });
    } else if (r === 'repeatEnd') {
      const b = getBarline('right');
      if (!b.find('repeat')) b.sub('repeat', { direction: 'backward' });
      newMeasure();
    } else if (r === 'repeatEndStart') {
      const b = getBarline('right');
      if (!b.find('repeat')) b.sub('repeat', { direction: 'backward' });
      newMeasure();
      const b2 = getBarline('right');
      if (!b2.find('repeat')) b2.sub('repeat', { direction: 'forward' });
    } else if (r.startsWith('voltaStart')) {
      const n = state.startVolta(measureNumber);
      getBarline('left').sub('ending', { type: 'start', number: String(n) });
    } else if (r.startsWith('voltaStop') || r.startsWith('voltaDiscontinue')) {
      const n = state.stopVolta(measureNumber);
      getBarline('right').sub('ending', { type: r.startsWith('voltaStop') ? 'stop' : 'discontinue', number: String(n) });
    } else if (r.startsWith('dynamic') || sym.articulation.startsWith('dynamic')) {
      for (const d of group.symbols) buildDynamic(d, cur);
    }
  });
  if (cur.children.length || !measures.length) close();
  if (!measures[0].find('attributes/time')) {
    const t = first.sub('time');
    t.sub('beats', {}, String(Math.max(intDiv(state.nominator, 4), 1)));
    t.sub('beat-type', {}, '4');
  }
  return measures;
}

function buildDynamic(d: EncodedSymbol, measure: El): void {
  const marks: El[] = [];
  if (d.rhythm.startsWith('dynamic')) {
    const name = d.rhythm.split('_').slice(1).join('_');
    if (name !== 'empty') marks.push(new El(name));
  }
  if (d.articulation.startsWith('dynamic')) {
    const t = new El('other-dynamics');
    t.text = d.articulation.split('_').slice(1).join('_').replace('piu', 'più');
    marks.push(t);
  }
  if (!marks.length) return;
  const dir = measure.sub('direction', { placement: 'below' });
  const dyn = dir.sub('direction-type').sub('dynamics');
  marks.forEach((m) => dyn.append(m));
  dir.sub('staff', {}, String(getStaff(d)));
}

function buildPart(voice: EncodedSymbol[], index: number, hasTwoStaves: boolean): El {
  const part = new El('part', { id: `P${index + 1}` });
  for (const m of buildMeasures(voice, hasTwoStaves)) part.append(m);
  convertTies(part);
  addStems(part);
  for (const n of part.iter('note')) n.removeAttr(POSITION_ATTR);
  return part;
}

/** homr generate_xml (no title, no metronome): one part per voice. */
export function generateXml(voices: EncodedSymbol[][], title = ''): El {
  const root = new El('score-partwise', { version: '4.0' });
  root.sub('work').sub('work-title', {}, title);
  root.sub('identification').sub('encoding').sub('software', {}, 'homr');
  root.sub('defaults');
  const two = voices.map((v) => v.some((s) => isLowerPosition(s.position)));
  const pl = root.sub('part-list');
  two.forEach((t, i) => {
    const id = `P${i + 1}`;
    const [name, inst, sound, program] = t ? ['Piano', 'Piano', 'keyboard.piano', 1] : ['Voice', 'Voice', 'voice', 54];
    const sp = pl.sub('score-part', { id });
    sp.sub('part-name', {}, String(name));
    const si = sp.sub('score-instrument', { id: `${id}-I1` });
    si.sub('instrument-name', {}, String(inst));
    si.sub('instrument-sound', {}, String(sound));
    const mi = sp.sub('midi-instrument', { id: `${id}-I1` });
    mi.sub('midi-channel', {}, String(i + 1));
    mi.sub('midi-program', {}, String(program));
    mi.sub('volume', {}, '100');
    mi.sub('pan', {}, '0');
  });
  voices.forEach((v, i) => root.append(buildPart(v, i, two[i])));
  return root;
}

// ------------------------------------------------------------------ pages (relieur)

function attrsOf(e: El, keys: [string, string][]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [tag, name] of keys) for (const a of e.findall(tag)) out[name] = a.text ?? '';
  return out;
}
const CLEF = (e: El) => attrsOf(e, [['sign', 'Sign'], ['sign', 'Line'], ['clef-octave-change', 'ClefOctaveChange']]);
const TIME = (e: El) => attrsOf(e, [['beats', 'Beats'], ['beat-type', 'BeatType'], ['interchangeable', 'Interchangeable'], ['senza-misura', 'SenzaMisura']]);
const KEY = (e: El) => attrsOf(e, [['fifths', 'Fifths'], ['key-alter', 'KeyAlter'], ['mode', 'Mode']]);
const same = (a: Record<string, string> | undefined, b: Record<string, string>) => a !== undefined && JSON.stringify(a) === JSON.stringify(b);

/**
 * homr's relieur process_concat: appends the measures of the later pages' parts to the first page's
 * parts (by part order), renumbered, dropping repeated divisions / key / time / clef from each later
 * page's first measure. (Python homr fails when the first page lacks one of them; here it is kept.)
 */
export function joinPages(pages: El[]): El {
  const m = pages[0];
  const lastAttrs: Record<string, unknown>[] = [];
  for (const p of m.findall('part')) {
    const pa: Record<string, unknown> = {};
    for (const meas of p.findall('measure')) {
      for (const at of meas.findall('attributes')) {
        for (const d of at.findall('divisions')) pa.Divisions = d.text;
        for (const k of at.findall('key')) pa.Key = KEY(k);
        for (const t of at.findall('time')) pa.Time = TIME(t);
        for (const c of at.findall('clef')) pa.Clef = CLEF(c);
      }
    }
    lastAttrs.push(pa);
  }
  for (const b of pages.slice(1)) {
    m.findall('part').forEach((p1, ip) => {
      let curLen = p1.findall('measure').length;
      b.findall('part').forEach((part, ib) => {
        if (ib !== ip) return;
        for (const meas of part.findall('measure')) {
          const num = parseInt(meas.get('number') ?? '0', 10);
          if (num === 1) {
            for (const at of meas.findall('attributes')) {
              const la = lastAttrs[ib] ?? {};
              for (const d of at.findall('divisions')) if (la.Divisions === d.text) at.remove(d);
              for (const k of at.findall('key')) if (same(la.Key as Record<string, string>, KEY(k))) at.remove(k);
              for (const t of at.findall('time')) if (same(la.Time as Record<string, string>, TIME(t))) at.remove(t);
              for (const c of at.findall('clef')) if (same(la.Clef as Record<string, string>, CLEF(c))) at.remove(c);
            }
          }
          meas.set('number', String(num + curLen));
          p1.append(meas);
        }
        curLen = p1.findall('measure').length;
      });
    });
  }
  return m;
}
