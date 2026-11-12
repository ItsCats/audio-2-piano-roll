/**
 * MuseScore 3, 4 and 5 scores (.mscx, or the .mscx inside an .mscz) → ScoreIR.
 *
 * A subset of MuseScore's own file format: notes, rests and chords per voice, tuplets (nested),
 * ties (old <Spanner type="Tie"> and the newer <Tie> with element ids), grace notes, time / key
 * signatures, tempo, dynamics, accents, fermatas, sustain pedal and octave lines (<Spanner> in a
 * voice, or the newer score-wide <SpannerMap>), repeats, voltas, segno / coda / D.C. / D.S. /
 * Fine (markers and jumps). MuseScore stores concert pitch without octave lines, so octave lines
 * are applied here. Files from MuseScore 2 and older have a different layout and are not read
 * (the caller tells the user to export MusicXML instead).
 */
import {
  ACCENT_DYNAMIC,
  DYNAMIC_VEL,
  parseEndingNumbers,
  type IRMeasure,
  type IRNote,
  type IRPart,
  type ScoreIR,
} from './ir';
import { child, childNum, childText, childrenNamed, deepText, parseXml, type XmlElement } from './xml';

export class MscxError extends Error {}

const DURATION_Q: Record<string, number> = {
  long: 16,
  breve: 8,
  whole: 4,
  half: 2,
  quarter: 1,
  eighth: 0.5,
  '16th': 0.25,
  '32nd': 0.125,
  '64th': 0.0625,
  '128th': 0.03125,
  '256th': 0.015625,
  '512th': 0.0078125,
  '1024th': 0.00390625,
};
const KEYBOARD_ID = /^keyboard\.|piano|organ|harpsichord|clavi|celesta/i;
const OTTAVA: Record<string, number> = { '8va': 12, '8vb': -12, '15ma': 24, '15mb': -24, '22ma': 36, '22mb': -36, '0': 12, '1': -12, '2': 24, '3': -24, '4': 36, '5': -36 };
const GRACE_BEFORE = ['acciaccatura', 'appoggiatura', 'grace4', 'grace16', 'grace32'];
const GRACE_AFTER = ['grace8after', 'grace16after', 'grace32after'];

/** "3/4" (of a whole note) → quarters. */
function fractionQ(s: string): number {
  const m = /^\s*(-?\d+)\s*\/\s*(\d+)\s*$/.exec(s);
  if (!m || +m[2] === 0) return NaN;
  return (4 * +m[1]) / +m[2];
}

/** Relative location (<measures>, <fractions>) of a spanner end. */
function location(el: XmlElement | undefined): { measures: number; q: number } | null {
  const loc = child(el, 'location');
  if (!loc) return null;
  const measures = parseInt(childText(loc, 'measures') || '0', 10) || 0;
  const fr = childText(loc, 'fractions');
  const q = fr ? fractionQ(fr) : 0;
  return { measures, q: Number.isFinite(q) ? q : 0 };
}

interface SpanStart {
  type: string;
  el: XmlElement;
  staff: number; // global staff index (0-based)
  /** absolute written position in quarters */
  from: number;
  to: number;
}

export function mscxToIR(text: string): ScoreIR {
  const root = parseXml(text);
  if (root.name !== 'museScore') throw new MscxError('This is not a MuseScore file.');
  const version = parseFloat(root.attrs.version ?? '0');
  if (!(version >= 3)) throw new MscxError('This file was saved by MuseScore 2 or older, which can’t be read here.');
  const score = child(root, 'Score');
  if (!score) throw new MscxError('This MuseScore file has no score inside.');
  const warnings: string[] = [];

  // ---- title / composer
  const meta = (name: string) => childrenNamed(score, 'metaTag').find((m) => m.attrs.name === name)?.text.trim() ?? '';
  const frameText = (style: string) => {
    for (const st of childrenNamed(score, 'Staff'))
      for (const box of childrenNamed(st, 'VBox'))
        for (const t of childrenNamed(box, 'Text')) {
          const s = childText(t, 'style').toLowerCase();
          if (s === style) return deepText(child(t, 'text')!).trim();
        }
    return '';
  };
  const workTitle = meta('workTitle');
  const movement = meta('movementTitle');
  const title = (workTitle && movement && workTitle !== movement ? `${workTitle} — ${movement}` : workTitle || movement) || frameText('title');
  const composer = meta('composer') || frameText('composer');

  // ---- parts and staves (global staff index in score order)
  const parts: IRPart[] = [];
  const staffPart: { part: number; staff: number; percussion: boolean }[] = [];
  for (const p of childrenNamed(score, 'Part')) {
    const instr = child(p, 'Instrument');
    const name = childText(child(instr, 'InstrumentLabel'), 'longName') || childText(instr, 'longName') || childText(p, 'trackName') || childText(instr, 'trackName') || `Part ${parts.length + 1}`;
    const id = instr?.attrs.id ?? childText(instr, 'instrumentId');
    const drums = childText(instr, 'useDrumset') === '1';
    const staves = childrenNamed(p, 'Staff');
    const pi = parts.length;
    const part: IRPart = { name: name.replace(/<[^>]*>/g, ''), staves: Math.max(1, staves.length), keyboard: KEYBOARD_ID.test(`${id} ${childText(instr, 'instrumentId')}`) || /piano|keyboard|organ/i.test(name) };
    parts.push(part);
    staves.forEach((s, k) => {
      const group = child(s, 'StaffType')?.attrs.group ?? 'pitched';
      staffPart.push({ part: pi, staff: k + 1, percussion: drums || group === 'percussion' || group === 'tablature-percussion' });
    });
  }
  const staffEls = childrenNamed(score, 'Staff').filter((s) => childrenNamed(s, 'Measure').length > 0);
  if (!staffEls.length) throw new MscxError('This MuseScore file has no music in it.');
  while (staffPart.length < staffEls.length) {
    parts.push({ name: `Part ${parts.length + 1}`, staves: 1, keyboard: false });
    staffPart.push({ part: parts.length - 1, staff: 1, percussion: false });
  }

  // ---- measure lengths and time signatures from the first staff
  const first = childrenNamed(staffEls[0], 'Measure');
  const measures: IRMeasure[] = [];
  let beats = 4;
  let beatType = 4;
  first.forEach((mEl, mi) => {
    let timeChange = false;
    for (const v of childrenNamed(mEl, 'voice').slice(0, 1))
      for (const ts of childrenNamed(v, 'TimeSig')) {
        const n = childNum(ts, 'sigN');
        const d = childNum(ts, 'sigD');
        if (n > 0 && d > 0) {
          if (mi > 0 && (n !== beats || d !== beatType)) timeChange = true;
          beats = n;
          beatType = d;
        }
      }
    const len = fractionQ(mEl.attrs.len ?? '');
    const nominal = (beats * 4) / beatType;
    measures.push({
      label: String(mi + 1),
      length: Number.isFinite(len) && len > 0 ? len : nominal,
      beats,
      beatType,
      ...(timeChange ? { timeChange: true } : {}),
      ...(Number.isFinite(len) && len > 0 && len < nominal && mi === 0 ? { implicit: true } : {}),
      tempos: [],
      notes: [],
      dynamics: [],
      pedal: [],
      fermatas: [],
    });
  });
  // measure numbers start again at 1 in each section (applied once the section breaks are known)
  const relabel = () => {
    let k = 0;
    for (const M of measures) M.label = String(M.newSection ? (k = 1) : ++k);
  };
  const startQ: number[] = [0];
  for (const m of measures) startQ.push(startQ[startQ.length - 1] + m.length);
  const totalQ = startQ[startQ.length - 1];
  /** written position in quarters → measure index and position in it */
  const locate = (abs: number): { m: number; pos: number } => {
    let lo = 0;
    let hi = measures.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (startQ[mid] <= abs + 1e-9) lo = mid;
      else hi = mid - 1;
    }
    return { m: lo, pos: Math.max(0, abs - startQ[lo]) };
  };
  const endOf = (startM: number, startPos: number, loc: { measures: number; q: number } | null): number => {
    if (!loc) return Infinity;
    const m = Math.max(0, Math.min(measures.length, startM + loc.measures));
    return startQ[m] + startPos + loc.q;
  };

  // ---- notes, directions, spanners
  let seq = 0;
  let endingId = 0;
  const spans: SpanStart[] = [];
  const byEid = new Map<string, IRNote>();
  const tieTo: { from: string; to: string }[] = [];
  const markers: { m: number; label: string; kind: string }[] = [];
  const jumps: { m: number; jumpTo: string; playUntil: string; continueAt: string; playRepeats: boolean }[] = [];
  let keyDone = false;

  // section breaks on frames between measures (first staff): the next measure starts a new section
  {
    let k = 0;
    let pending = false;
    for (const el of staffEls[0].children) {
      if (el.name === 'Measure') {
        if (pending && k > 0 && measures[k]) measures[k].newSection = true;
        pending = false;
        k++;
      } else if (/Box$/.test(el.name) && childrenNamed(el, 'LayoutBreak').some((b) => childText(b, 'subtype') === 'section')) pending = true;
    }
  }
  staffEls.forEach((staffEl, si) => {
    const sp = staffPart[si];
    const part = parts[sp.part];
    childrenNamed(staffEl, 'Measure').forEach((mEl, mi) => {
      const M = measures[mi];
      if (!M) return;
      if (si === 0) {
        if (child(mEl, 'startRepeat')) M.repeatStart = true;
        const er = child(mEl, 'endRepeat');
        if (er) M.repeatEnd = Math.max(2, parseInt(er.text, 10) || 2);
        for (const mk of childrenNamed(mEl, 'Marker')) {
          const label = childText(mk, 'label');
          const kind = (childText(mk, 'markerType') || childText(mk, 'subtype') || label).toLowerCase();
          markers.push({ m: mi, label, kind });
        }
        for (const j of childrenNamed(mEl, 'Jump'))
          jumps.push({ m: mi, jumpTo: childText(j, 'jumpTo'), playUntil: childText(j, 'playUntil'), continueAt: childText(j, 'continueAt'), playRepeats: childText(j, 'playRepeats') === '1' });
        // a section break after this measure: the next one starts a new section
        if (childrenNamed(mEl, 'LayoutBreak').some((b) => childText(b, 'subtype') === 'section') && measures[mi + 1]) measures[mi + 1].newSection = true;
      }
      childrenNamed(mEl, 'voice').forEach((vEl, vi) => {
        let cursor = 0;
        const ratios: number[] = [];
        const ratio = () => ratios.reduce((a, b) => a * b, 1);
        let fermataPending = false;
        const voice = `${sp.staff}:${vi + 1}`;
        for (const el of vEl.children) {
          switch (el.name) {
            case 'KeySig': {
              // the first staff's key (concert pitch), or the first key found anywhere
              const ck = childNum(el, 'concertKey');
              const k = Number.isFinite(ck) ? ck : childNum(el, 'accidental');
              if (Number.isFinite(k) && (si === 0 || !keyDone)) {
                M.key = { fifths: Math.round(k), mode: childText(el, 'mode') === 'minor' ? 'minor' : 'major' };
                keyDone = true;
              }
              break;
            }
            case 'Tempo': {
              const t = childNum(el, 'tempo');
              if (si === 0 && vi === 0 && t > 0) M.tempos.push({ pos: cursor, qpm: t * 60 });
              break;
            }
            case 'Dynamic': {
              const st = childText(el, 'subtype');
              const vel = childNum(el, 'velocity');
              if (ACCENT_DYNAMIC[st]) M.dynamics.push({ part: sp.part, pos: cursor, vel: ACCENT_DYNAMIC[st].vel, kind: 'accent', after: ACCENT_DYNAMIC[st].after });
              else if (DYNAMIC_VEL[st] !== undefined || vel > 0) M.dynamics.push({ part: sp.part, pos: cursor, vel: vel > 0 ? Math.min(1, vel / 127) : DYNAMIC_VEL[st], kind: 'level' });
              break;
            }
            case 'Tuplet': {
              const normal = childNum(el, 'normalNotes');
              const actual = childNum(el, 'actualNotes');
              ratios.push(normal > 0 && actual > 0 ? normal / actual : 1);
              break;
            }
            case 'endTuplet':
              ratios.pop();
              break;
            case 'location': {
              const loc = location({ name: 'x', attrs: {}, children: [el], text: '' });
              if (loc) cursor += loc.q;
              break;
            }
            case 'Fermata':
              fermataPending = true;
              break;
            case 'Spanner': {
              const type = el.attrs.type ?? '';
              const next = child(el, 'next');
              if (!next || !['Pedal', 'Ottava', 'Volta'].includes(type)) break;
              const from = startQ[mi] + cursor;
              spans.push({ type, el: child(el, type) ?? el, staff: si, from, to: endOf(mi, cursor, location(next)) });
              break;
            }
            case 'Chord':
            case 'Rest': {
              const dt = childText(el, 'durationType');
              const dots = parseInt(childText(el, 'dots') || '0', 10) || 0;
              let dur = dt === 'measure' ? fractionQ(childText(el, 'duration')) : (DURATION_Q[dt] ?? 1) * (2 - 1 / 2 ** dots);
              if (!Number.isFinite(dur)) dur = M.length;
              const graceBefore = GRACE_BEFORE.find((g) => child(el, g));
              const graceAfter = GRACE_AFTER.find((g) => child(el, g));
              const isGrace = !!(graceBefore || graceAfter);
              if (!isGrace) dur *= ratio();
              const hasFermata = fermataPending || !!child(el, 'Fermata');
              if (!isGrace && hasFermata) M.fermatas.push({ pos: cursor, dur });
              if (!isGrace) fermataPending = false;
              if (el.name === 'Chord' && !sp.percussion) {
                // cross-staff notes (written on the other staff of the part) count as that staff's
                const staffMove = parseInt(childText(el, 'staffMove') || '0', 10) || 0;
                const arts = childrenNamed(el, 'Articulation').map((a) => childText(a, 'subtype').toLowerCase());
                const accent = arts.some((a) => a.includes('marcato')) ? 0.18 : arts.some((a) => a.includes('accent') || a.includes('sforzato')) ? 0.12 : 0;
                childrenNamed(el, 'Note').forEach((nEl, k) => {
                  if (childText(nEl, 'play') === '0') return;
                  const pitch = childNum(nEl, 'pitch');
                  if (!Number.isFinite(pitch)) return;
                  let tieStart = false;
                  let tieStop = false;
                  for (const s of childrenNamed(nEl, 'Spanner'))
                    if (s.attrs.type === 'Tie') {
                      if (child(s, 'next')) tieStart = true;
                      if (child(s, 'prev')) tieStop = true;
                    }
                  const note: IRNote = {
                    part: sp.part,
                    staff: Math.max(1, Math.min(part.staves, sp.staff + staffMove)),
                    voice,
                    pos: cursor,
                    dur: isGrace ? 0 : dur,
                    midi: Math.round(pitch),
                    seq: seq++,
                    ...(k > 0 ? { chord: true } : {}),
                    ...(tieStart ? { tieStart } : {}),
                    ...(tieStop ? { tieStop } : {}),
                    ...(graceBefore ? { grace: graceBefore === 'acciaccatura' ? ('acciaccatura' as const) : ('appoggiatura' as const) } : {}),
                    ...(graceAfter ? { grace: 'acciaccatura' as const, graceAfter: true } : {}),
                    ...(accent ? { accent } : {}),
                  };
                  const eid = childText(nEl, 'eid');
                  if (eid) byEid.set(eid, note);
                  for (const t of childrenNamed(nEl, 'Tie')) {
                    const a = childText(t, 'startElement');
                    const b = childText(t, 'endElement');
                    if (a && b) tieTo.push({ from: a, to: b });
                  }
                  (note as IRNote & { _abs?: number })._abs = startQ[mi] + cursor;
                  M.notes.push(note);
                });
              }
              if (!isGrace) cursor += dur;
              break;
            }
          }
        }
      });
    });
  });

  // ---- score-wide spanners (MuseScore 4.6+ / 5)
  for (const sm of childrenNamed(score, 'SpannerMap'))
    for (const el of sm.children) {
      if (!['Pedal', 'Ottava', 'Volta'].includes(el.name)) continue;
      const from = fractionQ(childText(el, 'startTick'));
      const ticks = fractionQ(childText(el, 'ticks'));
      if (!Number.isFinite(from)) continue;
      const track = parseInt(childText(el, 'track') || '0', 10) || 0;
      spans.push({ type: el.name, el, staff: Math.floor(track / 4), from, to: Number.isFinite(ticks) ? from + ticks : totalQ });
    }

  // ties with element ids (MuseScore 4.4+)
  for (const t of tieTo) {
    const a = byEid.get(t.from);
    const b = byEid.get(t.to);
    if (a) a.tieStart = true;
    if (b) b.tieStop = true;
  }

  // ---- spanners: octave lines shift pitches; pedal; voltas
  for (const s of spans) {
    if (s.type === 'Ottava') {
      const shift = OTTAVA[childText(s.el, 'subtype')] ?? 12;
      const sp = staffPart[s.staff];
      if (!sp) continue;
      for (const M of measures)
        for (const n of M.notes) {
          const abs = (n as IRNote & { _abs?: number })._abs ?? 0;
          if (n.part === sp.part && n.staff === sp.staff && abs >= s.from - 1e-9 && abs < s.to - 1e-9) n.midi += shift;
        }
    } else if (s.type === 'Pedal') {
      const a = locate(s.from);
      measures[a.m].pedal.push({ pos: a.pos, type: 'down' });
      const b = locate(Math.min(s.to, totalQ));
      measures[b.m].pedal.push({ pos: s.to >= totalQ ? measures[b.m].length : b.pos, type: 'up' });
    } else if (s.type === 'Volta') {
      if (s.staff !== 0) continue;
      const passes = parseEndingNumbers(childText(s.el, 'endings') || childText(s.el, 'beginText'));
      if (!passes.length) continue;
      const id = ++endingId;
      const a = locate(s.from).m;
      const b = locate(Math.max(s.from, Math.min(s.to, totalQ) - 1e-6)).m;
      for (let m = a; m <= b; m++) measures[m].ending = { id, passes };
    }
  }
  for (const M of measures) for (const n of M.notes) delete (n as IRNote & { _abs?: number })._abs;

  relabel();

  // ---- markers and jumps
  // markers named by a jump: the segno closest before it, the play-until marker after the
  // target, the coda after that
  const markerNear = (label: string, before: number) => {
    const all = markers.filter((mk) => mk.label === label);
    return [...all].reverse().find((mk) => mk.m <= before) ?? all[0];
  };
  const markerFrom = (label: string, from: number) => {
    const all = markers.filter((mk) => mk.label === label);
    return all.find((mk) => mk.m >= from) ?? all[0];
  };
  for (const mk of markers) {
    if (mk.kind === 'segno' || mk.kind === 'varsegno') measures[mk.m].segno = true;
  }
  for (const j of jumps) {
    const M = measures[j.m];
    const target = j.jumpTo && j.jumpTo !== 'start' ? markerNear(j.jumpTo, j.m) : undefined;
    const from = target?.m ?? 0;
    const until = j.playUntil && j.playUntil !== 'end' ? markerFrom(j.playUntil, from) : undefined;
    const cont = until && j.continueAt ? markerFrom(j.continueAt, until.m) : undefined;
    M.jump = {
      to: target ? 'segno' : 'start',
      exact: true,
      ...(target ? { target: target.m } : {}),
      ...(until ? { until: until.m } : {}),
      ...(cont ? { codaAt: cont.m, alCoda: true } : until ? { alFine: true } : {}),
      ...(j.playRepeats ? { playRepeats: true } : {}),
    };
  }
  if (!jumps.length) for (const mk of markers) if (mk.kind === 'fine') measures[mk.m].fine = true;

  // percussion staves: notes dropped; a part with only percussion staves is left out
  parts.forEach((p, pi) => {
    const own = staffPart.filter((s) => s.part === pi);
    if (own.length && own.every((s) => s.percussion)) {
      p.ignored = true;
      warnings.push(`“${p.name}” is a drum part and was left out.`);
    }
  });

  return { title: title || undefined, composer: composer || undefined, parts, measures, warnings };
}
