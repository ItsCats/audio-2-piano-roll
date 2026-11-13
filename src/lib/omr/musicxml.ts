/**
 * Recognised measures (kern.ts) → MusicXML (partwise 4.0, one piano part on two staves), so a read
 * PDF / photo goes through exactly the same import as a MusicXML file (src/lib/score importMusicXml).
 *
 * Each staff's notes are packed into as few voices as possible (a note goes to the first voice that is
 * free at its start; chords are notes with the same start and length), gaps are filled with rests in
 * the first voice of a staff and with <forward> in the others, and every measure is padded to its
 * length so the importer's bar lines match the recognised ones.
 */
import { add, cmp, eq, frac, lcmDen, sub, type Frac } from './frac';
import type { Clef, KernMeasure, KernNote, KernPiece, Staff } from './kern';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const TYPES: [number, string][] = [
  [8, 'breve'],
  [4, 'whole'],
  [2, 'half'],
  [1, 'quarter'],
  [1 / 2, 'eighth'],
  [1 / 4, '16th'],
  [1 / 8, '32nd'],
  [1 / 16, '64th'],
  [1 / 32, '128th'],
];
const TUPLETS: [number, number][] = [
  [3, 2],
  [5, 4],
  [6, 4],
  [7, 4],
  [7, 8],
  [9, 8],
  [11, 8],
];

/** Note type, dots and tuplet ratio for a duration in quarter notes (null: no standard written value). */
export function noteType(q: number): { type: string; dots: number; tuplet?: [number, number] } | null {
  const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  const plain = (v: number) => {
    for (const [base, type] of TYPES) for (let dots = 0; dots <= 2; dots++) if (close(v, base * (2 - 1 / 2 ** dots))) return { type, dots };
    return null;
  };
  const p = plain(q);
  if (p) return p;
  for (const [actual, normal] of TUPLETS) {
    const t = plain((q * actual) / normal);
    if (t) return { ...t, tuplet: [actual, normal] };
  }
  return null;
}

interface Event {
  onset: Frac;
  dur: Frac;
  notes: KernNote[];
  grace: boolean;
}

function events(notes: KernNote[]): Event[] {
  const out: Event[] = [];
  const sorted = notes
    .filter((n) => !n.rest)
    .sort((a, b) => cmp(a.onset, b.onset) || (a.grace ? -1 : 0) - (b.grace ? -1 : 0) || cmp(b.dur, a.dur) || (b.midi ?? 0) - (a.midi ?? 0));
  for (const n of sorted) {
    const prev = out[out.length - 1];
    const grace = !!n.grace;
    if (prev && !grace && !prev.grace && eq(prev.onset, n.onset) && eq(prev.dur, n.dur)) {
      if (!prev.notes.some((m) => m.midi === n.midi)) prev.notes.push(n);
      continue;
    }
    out.push({ onset: n.onset, dur: n.dur, notes: [n], grace });
  }
  return out;
}

/** Packs chords into voices: the first voice that is free when the chord starts. */
function voices(evs: Event[]): Event[][] {
  const vs: { end: Frac; evs: Event[] }[] = [];
  for (const e of evs) {
    let v = vs.find((x) => cmp(x.end, e.onset) <= 0);
    if (!v) {
      v = { end: e.onset, evs: [] };
      vs.push(v);
    }
    v.evs.push(e);
    v.end = add(e.onset, e.dur);
  }
  return vs.map((v) => v.evs);
}

function clefXml(staff: Staff, c: Clef): string {
  return `<clef number="${staff}"><sign>${c.sign}</sign><line>${c.line}</line>${c.octave ? `<clef-octave-change>${c.octave}</clef-octave-change>` : ''}</clef>`;
}

export interface MusicXmlOptions {
  title?: string;
  /** <software> in the identification block */
  software?: string;
}

/** The recognised piece as a MusicXML document. */
export function kernToMusicXml(piece: KernPiece, opts: MusicXmlOptions = {}): string {
  const times: Frac[] = [];
  for (const m of piece.measures) {
    times.push(m.start, m.length);
    for (const n of m.notes) times.push(n.onset, n.dur);
  }
  const divisions = lcmDen(times);
  /** quarter-note time → whole divisions (rounded when the piece needs more than 10080 per quarter) */
  const dv = (f: Frac) => Math.round((f.n * divisions) / f.d);
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">');
  out.push('<score-partwise version="4.0">');
  if (opts.title) out.push(`<work><work-title>${esc(opts.title)}</work-title></work>`);
  out.push(`<identification><encoding><software>${esc(opts.software ?? 'Piano2Vision sheet-music reader (beta)')}</software></encoding></identification>`);
  out.push('<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>');
  out.push('<part id="P1">');
  const hasPickup = !!piece.measures[0]?.pickup;
  piece.measures.forEach((m, i) => {
    const number = hasPickup ? i : i + 1;
    out.push(`<measure number="${number}"${m.pickup ? ' implicit="yes"' : ''}>`);
    out.push(...measureBody(m, i === 0, divisions, dv));
    if (i === piece.measures.length - 1) out.push('<barline location="right"><bar-style>light-heavy</bar-style></barline>');
    out.push('</measure>');
  });
  out.push('</part>');
  out.push('</score-partwise>');
  return out.join('\n');
}

function measureBody(m: KernMeasure, first: boolean, divisions: number, dv: (f: Frac) => number): string[] {
  const out: string[] = [];
  const attrs: string[] = [];
  if (first) attrs.push(`<divisions>${divisions}</divisions>`);
  if (m.fifths !== undefined) attrs.push(`<key><fifths>${Math.max(-7, Math.min(7, m.fifths))}</fifths></key>`);
  if (m.meter) attrs.push(`<time><beats>${m.meter.beats}</beats><beat-type>${m.meter.beatType}</beat-type></time>`);
  if (first) attrs.push('<staves>2</staves>');
  for (const s of [1, 2] as Staff[]) if (m.clefs?.[s]) attrs.push(clefXml(s, m.clefs[s]!));
  if (attrs.length) out.push(`<attributes>${attrs.join('')}</attributes>`);
  const end = add(m.start, m.length);
  const parts: { staff: Staff; voice: number; evs: Event[] }[] = [];
  for (const staff of [1, 2] as Staff[]) {
    const vs = voices(events(m.notes.filter((n) => n.staff === staff)));
    if (!vs.length) vs.push([]);
    vs.forEach((evs, k) => parts.push({ staff, voice: (staff - 1) * 4 + k + 1, evs }));
  }
  parts.forEach((p, pi) => {
    let cursor = m.start;
    const firstOfStaff = pi === 0 || parts[pi - 1].staff !== p.staff;
    const gap = (to: Frac) => {
      const d = dv(sub(to, cursor));
      if (d <= 0) return;
      if (firstOfStaff) {
        const gq = sub(to, cursor);
        const t = noteType(gq.n / gq.d);
        out.push(`<note><rest/><duration>${d}</duration><voice>${p.voice}</voice>${t ? typeXml(t) : ''}<staff>${p.staff}</staff></note>`);
      } else out.push(`<forward><duration>${d}</duration><voice>${p.voice}</voice><staff>${p.staff}</staff></forward>`);
      cursor = to;
    };
    for (const e of p.evs) {
      if (cmp(e.onset, cursor) > 0) gap(e.onset);
      // never run past the bar line (cannot happen with the default bar snapping)
      let dur = e.dur;
      if (cmp(add(e.onset, dur), end) > 0) dur = cmp(end, e.onset) > 0 ? sub(end, e.onset) : frac(0);
      if (!e.grace && dv(dur) <= 0) continue;
      const t = noteType(e.grace ? 0.5 : dur.n / dur.d);
      e.notes.forEach((n, k) => {
        const ties: string[] = [];
        const tied: string[] = [];
        if (n.tie === 'stop' || n.tie === 'both') (ties.push('<tie type="stop"/>'), tied.push('<tied type="stop"/>'));
        if (n.tie === 'start' || n.tie === 'both') (ties.push('<tie type="start"/>'), tied.push('<tied type="start"/>'));
        out.push(
          '<note>' +
            (e.grace ? '<grace slash="yes"/>' : '') +
            (k > 0 ? '<chord/>' : '') +
            `<pitch><step>${n.step}</step>${n.alter ? `<alter>${n.alter}</alter>` : ''}<octave>${n.octave}</octave></pitch>` +
            (e.grace ? '' : `<duration>${dv(dur)}</duration>`) +
            ties.join('') +
            `<voice>${p.voice}</voice>` +
            (t ? typeXml(t) : '') +
            `<staff>${p.staff}</staff>` +
            (tied.length ? `<notations>${tied.join('')}</notations>` : '') +
            '</note>',
        );
      });
      if (!e.grace) cursor = add(e.onset, dur);
    }
    if (firstOfStaff && cmp(cursor, end) < 0) gap(end);
    const back = dv(sub(cursor, m.start));
    if (pi < parts.length - 1 && back > 0) out.push(`<backup><duration>${back}</duration></backup>`);
  });
  return out;
}

function typeXml(t: { type: string; dots: number; tuplet?: [number, number] }): string {
  return (
    `<type>${t.type}</type>` +
    '<dot/>'.repeat(t.dots) +
    (t.tuplet ? `<time-modification><actual-notes>${t.tuplet[0]}</actual-notes><normal-notes>${t.tuplet[1]}</normal-notes></time-modification>` : '')
  );
}
