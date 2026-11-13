/**
 * MusicXML 4.0 (partwise) writer for a Score: one piano part on a grand staff, voices 1/2 on the
 * treble staff and 5/6 on the bass staff. Can write a range of measures (for rendering the sheet
 * in chunks): the range starts with a complete <attributes> block and the octave marks in force.
 */
import { AccidentalTracker, spellChord, type Spelled } from './spelling';
import { DIV, type Chord, type Score, type Staff } from './types';
import { buckets, voiceItems, type Item } from './voiceItems';
import { keyAt } from './keys';
import { writtenIndex } from './written';
import type { DynamicValue, SheetMark } from '../music/types';
import { DYNAMIC_LEVEL } from './dynamics';

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

const spelledMemo = new WeakMap<Chord, Spelled[]>();
/** Spelling of a chord's notes (ascending) in the key of the measure it starts in, the same for every tied piece of it. */
export function spelled(score: Score, c: Chord): Spelled[] {
  let sp = spelledMemo.get(c);
  if (!sp) {
    const k = score.keys.length > 1 ? keyAt(score, score.time.measureOf(c.on)) : null;
    spelledMemo.set(c, (sp = k ? spellChord(c.midis, k.fifths, k.minorTonic) : spellChord(c.midis, score.fifths, score.minorTonic)));
  }
  return sp;
}

/** Inserts a notation (slur, fingering …) into a written <note>. */
function addNotation(note: string, tag: string): string {
  if (note.includes('<notations>')) return note.replace('<notations>', `<notations>${tag}`);
  return note.replace(/<\/note>$/, `<notations>${tag}</notations></note>`);
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
  extra = '',
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
  if (extra) nots.push(extra);
  if (nots.length) s += `<notations>${nots.join('')}</notations>`;
  out.push(s + '</note>');
};

const octaveShift = (type: 'down' | 'up' | 'stop', staff: Staff) =>
  `<direction${type === 'stop' ? '' : ` placement="${type === 'down' ? 'above' : 'below'}"`}><direction-type><octave-shift type="${type}" size="8"/></direction-type><staff>${staff}</staff></direction>`;

function metronome(score: Score, bpm: number, qpm: number, mark?: { unit?: string; text?: string }): string {
  const t = score.time;
  let unit = t.compound ? 'quarter' : t.beatUnit === 2 ? 'half' : t.beatUnit === 8 ? 'eighth' : 'quarter';
  let dot = t.compound ? '<beat-unit-dot/>' : '';
  if (mark?.unit) {
    unit = mark.unit === 'h' ? 'half' : mark.unit === 'e' ? 'eighth' : 'quarter';
    dot = mark.unit === 'q.' ? '<beat-unit-dot/>' : '';
  }
  const words = mark?.text ? `<direction-type><words font-weight="bold">${xmlEscape(mark.text)}</words></direction-type>` : '';
  return `<direction placement="above">${words}<direction-type><metronome parentheses="no"><beat-unit>${unit}</beat-unit>${dot}<per-minute>${bpm}</per-minute></metronome></direction-type><staff>1</staff><sound tempo="${qpm}"/></direction>`;
}

/** A direction (dynamics, hairpin, words, pedal) placed in a staff's voice-1 stream at a position. */
interface Dir {
  pos: number;
  xml: string;
  /** Sorts stops before starts at the same position. */
  order: number;
}

const DYN_SOUND = (v: DynamicValue) => Math.round(((DYNAMIC_LEVEL[v] * 127) / 90) * 10000) / 100;
const dirXml = (placement: 'above' | 'below', type: string, staff: Staff, sound = '') =>
  `<direction placement="${placement}"><direction-type>${type}</direction-type><staff>${staff}</staff>${sound}</direction>`;

/** Number (1–6) of each slur / hairpin, so overlapping ones are told apart; the same for every chunk. */
function spanNumbers<T>(items: T[], range: (x: T) => [number, number]): Map<T, number> {
  const out = new Map<T, number>();
  const open: { end: number; n: number }[] = [];
  for (const x of [...items].sort((a, b) => range(a)[0] - range(b)[0])) {
    const [a, b] = range(x);
    for (let i = open.length - 1; i >= 0; i--) if (open[i].end < a) open.splice(i, 1);
    let n = 1;
    while (n < 6 && open.some((o) => o.n === n)) n++;
    open.push({ end: b, n });
    out.set(x, n);
  }
  return out;
}

interface MarkPlan {
  /** Directions per staff and measure (key `${staff}|${m}`). */
  dirs: Map<string, Dir[]>;
  /** Extra notations per note id: written on its first / last piece. */
  first: Map<number, string[]>;
  last: Map<number, string[]>;
  /** Slurs open across the chunk start / still open at its end, per staff. */
  openAtStart: Map<Staff, string[]>;
  closeAtEnd: Map<Staff, string[]>;
}

/** Everything the markings add to the measures [from, to). */
function planMarks(score: Score, from: number, to: number): MarkPlan | null {
  const marks = score.marks ?? [];
  if (!marks.length && !score.noteMarks && !score.pedals) return null;
  const t = score.time;
  const A = t.measureStart(from);
  const B = t.measureStart(to);
  const plan: MarkPlan = { dirs: new Map(), first: new Map(), last: new Map(), openAtStart: new Map(), closeAtEnd: new Map() };
  const push = (staff: Staff, pos: number, xml: string, order: number, stop = false) => {
    // a stop at a bar line closes in the measure before it
    const m = stop && pos > 0 ? t.measureOf(pos - 1) : t.measureOf(pos);
    if (m < from || m >= to) return;
    const k = `${staff}|${m}`;
    let a = plan.dirs.get(k);
    if (!a) plan.dirs.set(k, (a = []));
    a.push({ pos, xml, order });
  };
  const add = (map: Map<number, string[]>, id: number, tag: string) => {
    let a = map.get(id);
    if (!a) map.set(id, (a = []));
    a.push(tag);
  };
  const staffOf = (s: 0 | 1 | 2): Staff => (s === 2 ? 2 : 1);
  const wedges = marks.filter((x): x is Extract<SheetMark, { kind: 'wedge' }> => x.kind === 'wedge' && x.end > x.pos);
  const wedgeNo = spanNumbers(wedges, (w) => [w.pos, w.end]);
  for (const mk of marks) {
    if (mk.kind === 'dyn') {
      if (mk.pos >= A && mk.pos < B) push(staffOf(mk.staff), mk.pos, dirXml('below', `<dynamics><${mk.value}/></dynamics>`, staffOf(mk.staff), `<sound dynamics="${DYN_SOUND(mk.value)}"/>`), 1);
    } else if (mk.kind === 'text') {
      if (mk.pos >= A && mk.pos < B) {
        const style = mk.style === 'bold' ? ' font-weight="bold"' : mk.style === 'italic' ? ' font-style="italic"' : '';
        push(mk.staff, mk.pos, dirXml(mk.above ? 'above' : 'below', `<words${style}>${xmlEscape(mk.text)}</words>`, mk.staff), 2);
      }
    } else if (mk.kind === 'wedge') {
      if (mk.end <= A || mk.pos >= B || mk.end <= mk.pos) continue;
      const n = wedgeNo.get(mk) ?? 1;
      const st = staffOf(mk.staff);
      push(st, Math.max(A, mk.pos), dirXml('below', `<wedge type="${mk.dir === 'cresc' ? 'crescendo' : 'diminuendo'}" number="${n}"/>`, st), 1);
      push(st, Math.min(B, mk.end), dirXml('below', `<wedge type="stop" number="${n}"/>`, st), 0, true);
    }
  }
  // slurs: on the first piece of `from` and the last piece of `to`; split at the chunk edges
  const slurs = marks.filter((x): x is Extract<SheetMark, { kind: 'slur' }> => x.kind === 'slur');
  if (slurs.length) {
    const idx = writtenIndex(score).byId;
    const ends = slurs
      .map((sl) => {
        const a = idx.get(sl.from)?.[0];
        const ps = idx.get(sl.to);
        const b = ps?.[ps.length - 1];
        return a && b && b.pieceOff > a.pieceOn ? { sl, a, b } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    const no = spanNumbers(ends, (e) => [e.a.pieceOn, e.b.pieceOff]);
    for (const e of ends) {
      const n = no.get(e) ?? 1;
      const placement = e.sl.below ? 'below' : 'above';
      if (e.b.measure < from || e.a.measure >= to) continue;
      const start = `<slur type="start" number="${n}" placement="${placement}"/>`;
      const stop = `<slur type="stop" number="${n}"/>`;
      if (e.a.measure >= from) add(plan.first, e.sl.from, start);
      else plan.openAtStart.set(e.a.staff, [...(plan.openAtStart.get(e.a.staff) ?? []), start]);
      if (e.b.measure < to) add(plan.last, e.sl.to, stop);
      else plan.closeAtEnd.set(e.a.staff, [...(plan.closeAtEnd.get(e.a.staff) ?? []), stop]);
    }
  }
  // fingering (first piece) and articulations (staccato on the last piece, the rest on the first)
  if (score.noteMarks)
    for (const [id, nm] of score.noteMarks) {
      const ps = writtenIndex(score).byId.get(id);
      if (!ps?.length) continue;
      if (nm.finger) add(plan.first, id, `<technical><fingering placement="${ps[0].staff === 2 ? 'below' : 'above'}">${nm.finger}</fingering></technical>`);
      for (const a of nm.art ?? []) {
        const tag = a === 'marcato' ? '<strong-accent type="up"/>' : `<${a}/>`;
        add(a === 'staccato' ? plan.last : plan.first, id, `<articulations>${tag}</articulations>`);
      }
    }
  // pedal: start / stop (a release and a new press within a grid step: change); split at the chunk edges
  if (score.pedals?.length) {
    const step = score.level === 'easy' ? 6 : 3;
    const ped = (type: 'start' | 'stop' | 'change') => dirXml('below', `<pedal type="${type}" line="yes" sign="yes"/>`, 2);
    // lines: ranges joined by changes
    const lines: { on: number; off: number; changes: number[] }[] = [];
    for (const p of score.pedals) {
      const l = lines[lines.length - 1];
      if (l && p.on - l.off <= step) {
        l.changes.push(Math.max(p.on, l.off));
        l.off = Math.max(l.off, p.off);
      } else lines.push({ on: p.on, off: p.off, changes: [] });
    }
    for (const l of lines) {
      if (l.off <= A || l.on >= B) continue;
      push(2, Math.max(A, l.on), ped('start'), 1);
      for (const c of l.changes) if (c > Math.max(A, l.on) && c < B) push(2, c, ped('change'), 1);
      push(2, Math.min(B, l.off), ped('stop'), 0, true);
    }
  }
  for (const a of plan.dirs.values()) a.sort((x, y) => x.pos - y.pos || x.order - y.order);
  return plan;
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
  const plan = planMarks(score, from, to);
  const keyed = score.keys.length > 1;
  const firstNote = new Map<Staff, number>();
  const lastNote = new Map<Staff, number>();
  for (let m = from; m < to; m++) {
    const a = t.measureStart(m);
    const len = t.measureLenAt(m);
    const b = a + len;
    x.push(`<measure number="${t.pickup ? m : m + 1}"${t.pickup && m === 0 ? ' implicit="yes"' : ''}>`);
    if (breaks.has(m) && m !== from) x.push('<print new-system="yes"/>');
    const clefChanged = (s: 0 | 1) => m === from || score.clefs[s][m] !== score.clefs[s][m - 1];
    const key = keyed ? keyAt(score, m) : null;
    const prevKey = keyed && m > 0 ? keyAt(score, m - 1) : null;
    const keyChanged = !!key && !!prevKey && (key.fifths !== prevKey.fifths || key.mode !== prevKey.mode);
    const meter = t.changes ? t.meterAt(m) : null;
    const prevMeter = t.changes && m > 0 ? t.meterAt(m - 1) : null;
    const meterChanged = !!meter && !!prevMeter && (meter.beatsPerBar !== prevMeter.beatsPerBar || meter.beatUnit !== prevMeter.beatUnit);
    if (m === from || clefChanged(0) || clefChanged(1) || keyChanged || meterChanged) {
      x.push('<attributes>');
      if (m === from) x.push(`<divisions>${DIV}</divisions>`);
      if (m === from || keyChanged) {
        const k = key ?? { fifths: score.fifths, mode: score.mode };
        // naturals cancel the old signature when it loses sharps or flats
        const cancel = keyChanged && prevKey!.fifths !== 0 && (Math.sign(prevKey!.fifths) !== Math.sign(k.fifths) || Math.abs(k.fifths) < Math.abs(prevKey!.fifths)) ? `<cancel>${prevKey!.fifths}</cancel>` : '';
        x.push(`<key>${cancel}<fifths>${k.fifths}</fifths><mode>${k.mode}</mode></key>`);
      }
      if (m === from || meterChanged) {
        const mt = meter ?? t;
        // a range that starts later (a chunk of the on-screen sheet) carries the time signature without showing it again
        x.push(`<time${m > 0 && !meterChanged ? ' print-object="no"' : ''}><beats>${mt.beatsPerBar}</beats><beat-type>${mt.beatUnit}</beat-type></time>`);
      }
      if (m === from) x.push('<staves>2</staves>');
      for (const s of [0, 1] as const)
        if (clefChanged(s)) x.push(`<clef number="${s + 1}"><sign>${score.clefs[s][m]}</sign><line>${score.clefs[s][m] === 'G' ? 2 : 4}</line></clef>`);
      x.push('</attributes>');
    }
    const mk = marks.get(m);
    if (mk) x.push(metronome(score, mk.bpm, mk.qpm, mk));

    // items for every staff/voice, then accidentals in time order per staff
    const streams: { staff: Staff; voice: 0 | 1; items: Item[]; stem: string }[] = [];
    for (const s of [0, 1] as const) {
      const v1 = voiceItems(score, bk[s][0][m], m, 0);
      const hasV2 = bk[s][1][m].length > 0;
      streams.push({ staff: (s + 1) as Staff, voice: 0, items: v1, stem: hasV2 ? 'up' : '' });
      if (hasV2) streams.push({ staff: (s + 1) as Staff, voice: 1, items: voiceItems(score, bk[s][1][m], m, 1), stem: 'down' });
    }
    for (const s of [1, 2] as Staff[]) {
      const tracker = new AccidentalTracker(key ? key.fifths : score.fifths);
      const notes = streams
        .filter((st) => st.staff === s)
        .flatMap((st) => st.items.filter((it) => it.kind === 'note'))
        .sort((p, q) => p.piece.pos - q.piece.pos);
      for (const it of notes) it.acc = spelled(score, it.chord!).map((sp) => tracker.need(sp, !!it.tieStop));
    }
    // each direction goes into a voice with an item starting right at it (its own staff first), so it
    // is drawn exactly there; otherwise before the voice-1 item it falls in
    const placed = new Map<number, Dir[]>();
    if (plan)
      for (const s of [1, 2] as Staff[])
        for (const d of plan.dirs.get(`${s}|${m}`) ?? []) {
          const own = streams.map((st, i) => ({ st, i })).sort((x, y) => Number(x.st.staff !== s) - Number(y.st.staff !== s) || x.st.voice - y.st.voice);
          const exact = d.pos < b ? own.find(({ st }) => st.items.some((it) => it.kind !== 'forward' && it.piece.pos === d.pos)) : undefined;
          const i = exact?.i ?? streams.findIndex((st) => st.staff === s && st.voice === 0);
          let a = placed.get(i);
          if (!a) placed.set(i, (a = []));
          a.push(d);
        }
    let first = true;
    for (const [si, st] of streams.entries()) {
      if (!first) x.push(`<backup><duration>${len}</duration></backup>`);
      first = false;
      const voiceNo = (st.staff === 1 ? 1 : 5) + st.voice;
      if (st.voice === 0 && m === from)
        for (const o of score.ottavas) if (o.staff === st.staff && o.start < a && o.stop > a) x.push(octaveShift(o.shift > 0 ? 'down' : 'up', st.staff));
      const dirs = (placed.get(si) ?? []).sort((x, y) => x.pos - y.pos || x.order - y.order);
      let di = 0;
      for (const it of st.items) {
        while (di < dirs.length && dirs[di].pos < it.piece.pos + it.piece.dur && dirs[di].pos < b) x.push(dirs[di++].xml);
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
        // articulations once per chord; fingering and slurs on their own chord tone
        const done = new Set<string>();
        spelled(score, c).forEach((sp, j) => {
          let extra = '';
          if (plan) {
            for (const id of c.srcByMidi?.[j] ?? []) {
              const tags = [...(!it.tieStop ? (plan.first.get(id) ?? []) : []), ...(!it.tieStart ? (plan.last.get(id) ?? []) : [])];
              for (const tag of tags) {
                if (tag.startsWith('<articulations>')) {
                  if (done.has(tag)) continue;
                  done.add(tag);
                }
                extra += tag;
              }
            }
          }
          if (!firstNote.has(st.staff)) firstNote.set(st.staff, x.length);
          lastNote.set(st.staff, x.length);
          fmtNote(x, it, sp, j > 0, voiceNo, st.staff, st.stem, it.acc?.[j] ?? null, extra);
        });
        if (it.lastOfChord && c.ottavaStop) x.push(octaveShift('stop', st.staff));
      }
      while (di < dirs.length) x.push(dirs[di++].xml);
      if (st.voice === 0 && m === to - 1 && to < score.measureCount)
        for (const o of score.ottavas) if (o.staff === st.staff && o.start < b && o.stop > b) x.push(octaveShift('stop', st.staff));
    }
    if (m === score.measureCount - 1) x.push('<barline location="right"><bar-style>light-heavy</bar-style></barline>');
    x.push('</measure>');
  }
  // slurs that cross the chunk edges: re-opened on its first note of the staff, closed on its last
  if (plan)
    for (const s of [1, 2] as Staff[]) {
      const f = firstNote.get(s);
      const l = lastNote.get(s);
      for (const tag of plan.openAtStart.get(s) ?? []) if (f !== undefined) x[f] = addNotation(x[f], tag);
      for (const tag of plan.closeAtEnd.get(s) ?? []) if (l !== undefined) x[l] = addNotation(x[l], tag);
    }
  x.push('</part>');
  x.push('</score-partwise>');
  return x.join('\n');
}
