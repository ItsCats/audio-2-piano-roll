/**
 * MusicXML 4.0 (partwise) writer for a Score: one piano part on a grand staff, voices 1/2 on the
 * treble staff and 5/6 on the bass staff. Can write a range of measures (for rendering the sheet
 * in chunks): the range starts with a complete <attributes> block and the octave marks in force.
 */
import { decompose, beams, type Piece, type RhythmContext, type BeamValue } from './rhythm';
import { AccidentalTracker, spellChord, type Spelled } from './spelling';
import { DIV, type Chord, type Score, type Staff } from './types';

export const CREDIT_LINE = 'Transcribed with Piano2Vision';

export interface MusicXmlOptions {
  title: string;
  artist?: string;
  /** First measure (inclusive), default 0. */
  from?: number;
  /** Last measure (exclusive), default all. */
  to?: number;
  /** Measures that start a new line (<print new-system="yes"/>). */
  breaks?: Iterable<number>;
  /** Add the title, composer and credit-line <credit> elements (file export). */
  credits?: boolean;
  /** Override the encoding date (tests). */
  date?: string;
}

export const xmlEscape = (s: string) =>
  s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

interface Item {
  kind: 'note' | 'rest' | 'forward' | 'mrest';
  piece: Piece;
  chord?: Chord;
  tieStart?: boolean;
  tieStop?: boolean;
  firstOfChord?: boolean;
  lastOfChord?: boolean;
  tuplet?: 'start' | 'stop';
  beams?: [number, BeamValue][];
  acc?: (string | null)[];
}

/** Chords of each (staff, voice) bucketed per measure. */
function bucket(score: Score): Chord[][][][] {
  const t = score.time;
  return score.staves.map((sv) =>
    sv.voices.map((voice) => {
      const per: Chord[][] = Array.from({ length: score.measureCount }, () => []);
      for (const c of voice) {
        const m0 = t.measureOf(c.on);
        const m1 = Math.min(score.measureCount - 1, t.measureOf(c.off - 1));
        for (let m = m0; m <= m1; m++) per[m].push(c);
      }
      return per;
    }),
  );
}

const spelledMemo = new WeakMap<Chord, Spelled[]>();
/** Spelling of a chord's notes (ascending), the same for every tied piece of it. */
function spelled(score: Score, c: Chord): Spelled[] {
  let sp = spelledMemo.get(c);
  if (!sp) spelledMemo.set(c, (sp = spellChord(c.midis, score.fifths, score.minorTonic)));
  return sp;
}

const memo = new WeakMap<Score, Chord[][][][]>();
function buckets(score: Score) {
  let b = memo.get(score);
  if (!b) memo.set(score, (b = bucket(score)));
  return b;
}

function tripletMarks(items: Item[]) {
  for (const it of items) {
    if (!it.piece.triplet || it.kind === 'forward') continue;
    const inQ = it.piece.pos % DIV;
    if (inQ === 0) it.tuplet = 'start';
    else if (inQ + it.piece.dur === DIV) it.tuplet = 'stop';
  }
}

/** Items (notes, rests, forwards) of one voice in one measure, covering the whole measure. */
function voiceItems(score: Score, chords: Chord[], m: number, voice: 0 | 1): Item[] {
  const t = score.time;
  const a = t.measureStart(m);
  const len = m === 0 && t.pickup ? t.pickup : t.measureLen;
  const b = a + len;
  const ctx: RhythmContext = { measureStart: a, measureLen: len, beatLen: t.beatLen, compound: t.compound, isTriplet: (q) => score.tripletQuarters.has(q) };
  const items: Item[] = [];
  if (!chords.length) {
    // a whole-measure rest; in a pickup measure written out (readers take measure rests as full bars)
    if (voice === 1) items.push({ kind: 'forward', piece: { pos: a, dur: len, type: 'whole', dots: 0, triplet: false } });
    else if (len === t.measureLen) items.push({ kind: 'mrest', piece: { pos: a, dur: len, type: 'whole', dots: 0, triplet: false } });
    else for (const piece of decompose(a, b, ctx, true)) items.push({ kind: 'rest', piece });
    return items;
  }
  const notesInQuarter = new Set<number>();
  if (voice === 1)
    for (const c of chords) for (let q = Math.floor(Math.max(c.on, a) / DIV); q * DIV < Math.min(c.off, b); q++) notesInQuarter.add(q);
  const gap = (p: number, e: number) => {
    if (voice === 0) {
      for (const piece of decompose(p, e, ctx, true)) items.push({ kind: 'rest', piece });
      return;
    }
    // voice 2: invisible forwards, but real rests inside triplet quarters it plays in
    let x = p;
    while (x < e) {
      const q = Math.floor(x / DIV);
      if (score.tripletQuarters.has(q) && notesInQuarter.has(q)) {
        const y = Math.min(e, (q + 1) * DIV);
        for (const piece of decompose(x, y, ctx, true)) items.push({ kind: 'rest', piece });
        x = y;
      } else {
        let y = x;
        while (y < e) {
          const qq = Math.floor(y / DIV);
          if (score.tripletQuarters.has(qq) && notesInQuarter.has(qq)) break;
          y = Math.min(e, (qq + 1) * DIV);
        }
        items.push({ kind: 'forward', piece: { pos: x, dur: y - x, type: 'quarter', dots: 0, triplet: false } });
        x = y;
      }
    }
  };
  let p = a;
  for (const c of chords) {
    const on = Math.max(c.on, a);
    const off = Math.min(c.off, b);
    if (off <= on) continue;
    if (on > p) gap(p, on);
    const pieces = decompose(on, off, ctx);
    pieces.forEach((piece, i) => {
      items.push({
        kind: 'note',
        piece,
        chord: c,
        tieStop: i > 0 || c.on < a,
        tieStart: i < pieces.length - 1 || c.off > b,
        firstOfChord: i === 0 && c.on >= a,
        lastOfChord: i === pieces.length - 1 && c.off <= b,
      });
    });
    p = off;
  }
  if (p < b) gap(p, b);
  tripletMarks(items);
  // beams
  const beamItems = items.map((it) => ({ pos: it.piece.pos, dur: it.piece.dur, type: it.piece.type, triplet: it.piece.triplet, rest: it.kind !== 'note' }));
  const easyHalfBar = score.level === 'easy' && len === 48 && t.beatLen === 12;
  const bs = beams(beamItems, ctx, easyHalfBar ? 24 : undefined);
  items.forEach((it, i) => (it.beams = bs[i]));
  return items;
}

const fmtNote = (
  out: string[],
  it: Item,
  sp: Spelled | null,
  chordTone: boolean,
  voiceNo: number,
  staff: Staff,
  stem: string,
  acc: string | null,
) => {
  const pc = it.piece;
  let s = '<note>';
  if (chordTone) s += '<chord/>';
  if (sp === null) s += it.kind === 'mrest' ? '<rest measure="yes"/>' : '<rest/>';
  else {
    s += `<pitch><step>${sp.step}</step>${sp.alter ? `<alter>${sp.alter}</alter>` : ''}<octave>${sp.octave}</octave></pitch>`;
  }
  s += `<duration>${pc.dur}</duration>`;
  if (sp !== null && it.tieStop) s += '<tie type="stop"/>';
  if (sp !== null && it.tieStart) s += '<tie type="start"/>';
  s += `<voice>${voiceNo}</voice>`;
  if (it.kind !== 'mrest') s += `<type>${pc.type}</type>${pc.dots ? '<dot/>' : ''}`;
  if (acc) s += `<accidental>${acc}</accidental>`;
  if (pc.triplet) s += '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>';
  if (stem && sp !== null) s += `<stem>${stem}</stem>`;
  s += `<staff>${staff}</staff>`;
  if (!chordTone && it.beams?.length) for (const [n, v] of it.beams) s += `<beam number="${n}">${v}</beam>`;
  const nots: string[] = [];
  if (sp !== null && it.tieStop) nots.push('<tied type="stop"/>');
  if (sp !== null && it.tieStart) nots.push('<tied type="start"/>');
  if (!chordTone && it.tuplet) nots.push(`<tuplet type="${it.tuplet}"${it.tuplet === 'start' ? ' bracket="no"' : ''}/>`);
  if (nots.length) s += `<notations>${nots.join('')}</notations>`;
  out.push(s + '</note>');
};

const octaveShift = (type: 'down' | 'up' | 'stop', staff: Staff) =>
  `<direction${type === 'stop' ? '' : ` placement="${type === 'down' ? 'above' : 'below'}"`}><direction-type><octave-shift type="${type}" size="8"/></direction-type><staff>${staff}</staff></direction>`;

function metronome(score: Score, bpm: number, qpm: number): string {
  const t = score.time;
  const unit = t.compound ? 'quarter' : t.beatUnit === 2 ? 'half' : t.beatUnit === 8 ? 'eighth' : 'quarter';
  const dot = t.compound ? '<beat-unit-dot/>' : '';
  return `<direction placement="above"><direction-type><metronome parentheses="no"><beat-unit>${unit}</beat-unit>${dot}<per-minute>${bpm}</per-minute></metronome></direction-type><staff>1</staff><sound tempo="${qpm}"/></direction>`;
}

export function toMusicXml(score: Score, opts: MusicXmlOptions): string {
  const t = score.time;
  const from = Math.max(0, Math.min(score.measureCount - 1, opts.from ?? 0));
  const to = Math.max(from + 1, Math.min(score.measureCount, opts.to ?? score.measureCount));
  const breaks = new Set(opts.breaks ?? []);
  const bk = buckets(score);
  const x: string[] = [];
  x.push('<?xml version="1.0" encoding="UTF-8" standalone="no"?>');
  x.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  x.push('<score-partwise version="4.0">');
  const title = xmlEscape(opts.title || 'Untitled');
  const artist = opts.artist ? xmlEscape(opts.artist) : '';
  x.push(`<work><work-title>${title}</work-title></work>`);
  x.push('<identification>');
  if (artist) x.push(`<creator type="composer">${artist}</creator>`);
  // the credit names the software, not a rights holder: it goes in <encoding>, never in <rights>
  x.push(`<encoding><software>${CREDIT_LINE}</software><encoding-date>${opts.date ?? new Date().toISOString().slice(0, 10)}</encoding-date></encoding>`);
  x.push('</identification>');
  if (opts.credits) {
    x.push(`<credit page="1"><credit-type>title</credit-type><credit-words justify="center" valign="top" font-size="20">${title}</credit-words></credit>`);
    if (artist) x.push(`<credit page="1"><credit-type>composer</credit-type><credit-words justify="right" valign="top" font-size="11">${artist}</credit-words></credit>`);
    // printed at the foot of page 1; no credit-type "rights" for the same reason
    x.push(`<credit page="1"><credit-words justify="center" valign="bottom" font-size="8">${CREDIT_LINE}</credit-words></credit>`);
  }
  x.push(
    '<part-list><score-part id="P1"><part-name print-object="no">Piano</part-name>' +
      '<score-instrument id="P1-I1"><instrument-name>Piano</instrument-name></score-instrument>' +
      '<midi-instrument id="P1-I1"><midi-channel>1</midi-channel><midi-program>1</midi-program></midi-instrument>' +
      '</score-part></part-list>',
  );
  x.push('<part id="P1">');
  const marks = new Map(score.tempoMarks.map((mk) => [mk.measure, mk]));
  for (let m = from; m < to; m++) {
    const a = t.measureStart(m);
    const len = m === 0 && t.pickup ? t.pickup : t.measureLen;
    const b = a + len;
    x.push(`<measure number="${t.pickup ? m : m + 1}"${t.pickup && m === 0 ? ' implicit="yes"' : ''}>`);
    if (breaks.has(m) && m !== from) x.push('<print new-system="yes"/>');
    const clefChanged = (s: 0 | 1) => m === from || score.clefs[s][m] !== score.clefs[s][m - 1];
    if (m === from || clefChanged(0) || clefChanged(1)) {
      x.push('<attributes>');
      if (m === from) {
        x.push(`<divisions>${DIV}</divisions>`);
        x.push(`<key><fifths>${score.fifths}</fifths><mode>${score.mode}</mode></key>`);
        // a range that starts later (a chunk of the on-screen sheet) carries the time signature without showing it again
        x.push(`<time${m > 0 ? ' print-object="no"' : ''}><beats>${t.beatsPerBar}</beats><beat-type>${t.beatUnit}</beat-type></time>`);
        x.push('<staves>2</staves>');
      }
      for (const s of [0, 1] as const)
        if (clefChanged(s)) x.push(`<clef number="${s + 1}"><sign>${score.clefs[s][m]}</sign><line>${score.clefs[s][m] === 'G' ? 2 : 4}</line></clef>`);
      x.push('</attributes>');
    }
    const mk = marks.get(m);
    if (mk) x.push(metronome(score, mk.bpm, mk.qpm));

    // items for every staff/voice, then accidentals in time order per staff
    const streams: { staff: Staff; voice: 0 | 1; items: Item[]; stem: string }[] = [];
    for (const s of [0, 1] as const) {
      const v1 = voiceItems(score, bk[s][0][m], m, 0);
      const hasV2 = bk[s][1][m].length > 0;
      streams.push({ staff: (s + 1) as Staff, voice: 0, items: v1, stem: hasV2 ? 'up' : '' });
      if (hasV2) streams.push({ staff: (s + 1) as Staff, voice: 1, items: voiceItems(score, bk[s][1][m], m, 1), stem: 'down' });
    }
    for (const s of [1, 2] as Staff[]) {
      const tracker = new AccidentalTracker(score.fifths);
      const notes = streams
        .filter((st) => st.staff === s)
        .flatMap((st) => st.items.filter((it) => it.kind === 'note'))
        .sort((p, q) => p.piece.pos - q.piece.pos);
      for (const it of notes) it.acc = spelled(score, it.chord!).map((sp) => tracker.need(sp, !!it.tieStop));
    }
    let first = true;
    for (const st of streams) {
      if (!first) x.push(`<backup><duration>${len}</duration></backup>`);
      first = false;
      const voiceNo = (st.staff === 1 ? 1 : 5) + st.voice;
      if (st.voice === 0 && m === from)
        for (const o of score.ottavas) if (o.staff === st.staff && o.start < a && o.stop > a) x.push(octaveShift(o.shift > 0 ? 'down' : 'up', st.staff));
      for (const it of st.items) {
        if (it.kind === 'forward') {
          x.push(`<forward><duration>${it.piece.dur}</duration><voice>${voiceNo}</voice><staff>${st.staff}</staff></forward>`);
          continue;
        }
        if (it.kind !== 'note') {
          fmtNote(x, it, null, false, voiceNo, st.staff, '', null);
          continue;
        }
        const c = it.chord!;
        if (it.firstOfChord && c.ottavaStart) x.push(octaveShift(c.ottavaStart > 0 ? 'down' : 'up', st.staff));
        spelled(score, c).forEach((sp, j) => fmtNote(x, it, sp, j > 0, voiceNo, st.staff, st.stem, it.acc?.[j] ?? null));
        if (it.lastOfChord && c.ottavaStop) x.push(octaveShift('stop', st.staff));
      }
      if (st.voice === 0 && m === to - 1 && to < score.measureCount)
        for (const o of score.ottavas) if (o.staff === st.staff && o.start < b && o.stop > b) x.push(octaveShift('stop', st.staff));
    }
    if (m === score.measureCount - 1) x.push('<barline location="right"><bar-style>light-heavy</bar-style></barline>');
    x.push('</measure>');
  }
  x.push('</part>');
  x.push('</score-partwise>');
  return x.join('\n');
}
