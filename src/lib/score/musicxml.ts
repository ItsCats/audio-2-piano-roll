/**
 * MusicXML (partwise or timewise, any version) → ScoreIR. Reads what matters for playing the
 * piece: divisions, <backup>/<forward>, chords, voices, staves, ties, tuplets (via durations),
 * grace notes, transposing instruments, tempo (sound tempo, metronome marks, tempo
 * words), time and key signatures, dynamics and accents, fermatas, sustain pedal, and the repeat
 * structure (repeat barlines, volta endings, segno / coda / D.C. / D.S. / Fine).
 */
import {
  ACCENT_DYNAMIC,
  DYNAMIC_VEL,
  jumpFromWords,
  parseEndingNumbers,
  resolveCodaSigns,
  tempoFromWords,
  type IRMeasure,
  type IRNote,
  type IRPart,
  type ScoreIR,
} from './ir';
import { child, childNum, childText, childrenNamed, parseXml, type XmlElement } from './xml';

const STEP_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const TYPE_QUARTERS: Record<string, number> = {
  maxima: 32,
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
};
const KEYBOARD_NAME = /piano|klavier|keyboard|organ|orgel|harpsichord|cembalo|clavi|celest|pianoforte|forte ?piano|synth|e\.? ?p\.?\b|rhodes/i;
const EPS = 1e-6;

/** Is this text a MusicXML score (by its root element)? */
export function looksLikeMusicXml(text: string): boolean {
  return /<score-(partwise|timewise)[\s>]/.test(text.slice(0, 5000)) || /<score-(partwise|timewise)[\s>]/.test(text);
}

/** score-timewise → score-partwise (same elements, measures grouped by part). */
export function timewiseToPartwise(root: XmlElement): XmlElement {
  const parts = new Map<string, XmlElement>();
  const rest = root.children.filter((c) => c.name !== 'measure');
  for (const m of childrenNamed(root, 'measure')) {
    for (const p of childrenNamed(m, 'part')) {
      const id = p.attrs.id ?? '';
      let part = parts.get(id);
      if (!part) parts.set(id, (part = { name: 'part', attrs: { id }, children: [], text: '' }));
      part.children.push({ name: 'measure', attrs: { ...m.attrs }, children: p.children, text: '' });
    }
  }
  return { name: 'score-partwise', attrs: root.attrs, children: [...rest, ...parts.values()], text: '' };
}

const typeQuarters = (unit: string, dots: number) => {
  const q = TYPE_QUARTERS[unit] ?? 1;
  return q * (2 - 1 / 2 ** dots);
};

function parseTimeBeats(s: string): number {
  // "3+2" → 5; "3" → 3
  const v = s
    .split('+')
    .map((x) => parseFloat(x))
    .filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) : NaN;
}

/** Concert key fifths of a written key in a transposing part. */
function concertFifths(fifths: number, chromatic: number): number {
  if (!chromatic) return fifths;
  let f = fifths + ((((chromatic % 12) + 12) % 12) * 7) % 12;
  while (f > 6) f -= 12;
  while (f < -6) f += 12;
  return f;
}


interface RawNote extends IRNote {
  m: number;
}

export function musicXmlToIR(text: string): ScoreIR {
  let root = parseXml(text);
  if (root.name === 'score-timewise') root = timewiseToPartwise(root);
  if (root.name !== 'score-partwise') {
    if (root.name === 'opus') throw new Error('This file is a MusicXML opus (a list of scores). Open one of its scores instead.');
    throw new Error('This file is not a MusicXML score.');
  }
  const warnings: string[] = [];

  // ---- title / composer
  const work = child(root, 'work');
  const workTitle = childText(work, 'work-title');
  const movement = childText(root, 'movement-title');
  const ident = child(root, 'identification');
  let composer = childrenNamed(ident, 'creator').find((c) => c.attrs.type === 'composer')?.text.trim() || '';
  let creditTitle = '';
  for (const cr of childrenNamed(root, 'credit')) {
    const type = childText(cr, 'credit-type');
    const words = childrenNamed(cr, 'credit-words').map((w) => w.text.trim()).filter(Boolean).join(' ');
    if (type === 'title' && !creditTitle) creditTitle = words;
    if (type === 'composer' && !composer) composer = words;
  }
  const title = workTitle && movement && workTitle !== movement ? `${workTitle} — ${movement}` : workTitle || movement || creditTitle;

  // ---- parts
  const partList = child(root, 'part-list');
  const scoreParts = new Map<string, XmlElement>();
  for (const sp of childrenNamed(partList, 'score-part')) scoreParts.set(sp.attrs.id ?? '', sp);
  const partEls = childrenNamed(root, 'part');
  if (!partEls.length) throw new Error('This MusicXML file has no parts.');

  const parts: IRPart[] = [];
  const measures: IRMeasure[] = [];
  const lengths: number[][] = [];
  let seq = 0;
  let endingId = 0;
  const endingsFromPart: number[] = []; // measure index → part whose endings were used
  /** segno / coda / To Coda marks, placed once the measure lengths are known */
  const marks: { m: number; pos: number; kind: 'segno' | 'coda' | 'toCoda'; id?: string }[] = [];
  const keyFromPart: number[] = [];

  partEls.forEach((partEl, pi) => {
    const sp = scoreParts.get(partEl.attrs.id ?? '');
    const name = childText(sp, 'part-name') || childText(child(sp, 'score-instrument'), 'instrument-name') || `Part ${pi + 1}`;
    const instrName = childrenNamed(sp, 'score-instrument').map((si) => childText(si, 'instrument-name')).join(' ');
    const midiInstr = childrenNamed(sp, 'midi-instrument');
    const drumChannel = midiInstr.length > 0 && midiInstr.every((mi) => childNum(mi, 'midi-channel') === 10 || child(mi, 'midi-unpitched'));
    const part: IRPart = { name, staves: 1, keyboard: KEYBOARD_NAME.test(`${name} ${instrName}`) };
    parts.push(part);

    let divisions = 1;
    let chromatic = 0;
    let beats = 4;
    let beatType = 4;
    const percussionStaff = new Set<number>();
    const raw: RawNote[] = [];
    let hadPitched = false;
    let hadUnpitched = false;

    childrenNamed(partEl, 'measure').forEach((mEl, mi) => {
      let M = measures[mi];
      if (!M) {
        M = measures[mi] = {
          label: mEl.attrs.number ?? String(mi + 1),
          length: 0,
          beats,
          beatType,
          tempos: [],
          notes: [],
          dynamics: [],
          pedal: [],
          fermatas: [],
        };
        lengths[mi] = [];
      }
      if (mEl.attrs.implicit === 'yes') M.implicit = true;
      // positions in divisions (integers in practice, so triplets stay exact) until converted with at()
      let cursor = 0;
      let high = 0;
      let lastStart = 0;
      const dv = (d: number) => (Number.isFinite(d) && d > 0 ? d : 0);
      const at = (d: number) => d / divisions;

      /** <sound> attributes; returns its dynamics value (NaN when none). */
      const readSound = (snd: XmlElement | undefined, pos: number, hasWordsJump: boolean, hasPedalMark: boolean): number => {
        if (!snd) return NaN;
        const a = snd.attrs;
        const t = parseFloat(a.tempo);
        if (t > 0 && Number.isFinite(t)) M.tempos.push({ pos, qpm: t });
        if (a.dacapo === 'yes' && !hasWordsJump) M.jump = { ...M.jump, to: 'start' };
        if (a.dalsegno !== undefined && !hasWordsJump) M.jump = { ...M.jump, to: 'segno' };
        if (a.segno !== undefined) marks.push({ m: mi, pos, kind: 'segno' });
        if (a.coda !== undefined) marks.push({ m: mi, pos, kind: 'coda' });
        if (a.tocoda !== undefined) marks.push({ m: mi, pos, kind: 'toCoda' });
        if (a.fine !== undefined) M.fine = true;
        if (a['damper-pedal'] !== undefined && !hasPedalMark) {
          const v = a['damper-pedal'];
          M.pedal.push({ pos, type: v === 'yes' || parseFloat(v) >= 50 ? 'down' : 'up' });
        }
        return parseFloat(a.dynamics ?? '');
      };

      for (const el of mEl.children) {
        switch (el.name) {
          case 'attributes': {
            const d = childNum(el, 'divisions');
            if (d > 0 && d !== divisions) {
              // a change inside a measure: keep the positions reached so far
              cursor = (cursor * d) / divisions;
              high = (high * d) / divisions;
              lastStart = (lastStart * d) / divisions;
              divisions = d;
            }
            const st = childNum(el, 'staves');
            if (st >= 1) part.staves = Math.max(part.staves, Math.round(st));
            const tr = child(el, 'transpose');
            if (tr) chromatic = (childNum(tr, 'chromatic') || 0) + 12 * (childNum(tr, 'octave-change') || 0);
            const time = child(el, 'time');
            if (time && !child(time, 'senza-misura')) {
              const b = parseTimeBeats(childrenNamed(time, 'beats').map((x) => x.text.trim()).join('+'));
              const bt = childNum(time, 'beat-type');
              if (b > 0 && bt > 0) {
                if (mi > 0 && (b !== beats || bt !== beatType)) M.timeChange = true;
                beats = b;
                beatType = bt;
              }
              M.beats = beats;
              M.beatType = beatType;
            }
            const key = child(el, 'key');
            const fifths = childNum(key, 'fifths');
            if (key && Number.isFinite(fifths) && keyFromPart[mi] === undefined) {
              keyFromPart[mi] = pi;
              M.key = { fifths: concertFifths(Math.round(fifths), chromatic), mode: childText(key, 'mode') === 'minor' ? 'minor' : 'major' };
            }
            for (const clef of childrenNamed(el, 'clef')) {
              const n = parseInt(clef.attrs.number ?? '1', 10) || 1;
              if (childText(clef, 'sign') === 'percussion') percussionStaff.add(n);
              else percussionStaff.delete(n);
            }
            break;
          }
          case 'backup':
            cursor = Math.max(0, cursor - dv(childNum(el, 'duration')));
            break;
          case 'forward':
            cursor += dv(childNum(el, 'duration'));
            high = Math.max(high, cursor);
            break;
          case 'direction':
          case 'sound': {
            const off = child(el, 'offset');
            const pos = at(Math.max(0, cursor + (off && off.attrs.sound === 'yes' ? parseFloat(off.text) || 0 : 0)));
            let level: number | null = null;
            let hasTempoMark = false;
            let wordsJump = false;
            let pedalMark = false;
            const words: string[] = [];
            const types = el.name === 'direction' ? childrenNamed(el, 'direction-type').flatMap((dt) => dt.children) : [];
            for (const t of types) {
              switch (t.name) {
                case 'dynamics':
                  for (const d of t.children) {
                    const k = d.name === 'other-dynamics' ? d.text.trim().toLowerCase() : d.name;
                    if (DYNAMIC_VEL[k] !== undefined) {
                      M.dynamics.push({ part: pi, pos, vel: DYNAMIC_VEL[k], kind: 'level' });
                      level = DYNAMIC_VEL[k];
                    } else if (ACCENT_DYNAMIC[k]) {
                      M.dynamics.push({ part: pi, pos, vel: ACCENT_DYNAMIC[k].vel, kind: 'accent', after: ACCENT_DYNAMIC[k].after });
                      level = ACCENT_DYNAMIC[k].vel;
                    }
                  }
                  break;
                case 'metronome': {
                  const units = childrenNamed(t, 'beat-unit');
                  const pm = parseFloat(childText(t, 'per-minute').replace(/^[^\d]*/, ''));
                  if (units.length === 1 && pm > 0) {
                    // dots after the (single) beat unit
                    const dots = childrenNamed(t, 'beat-unit-dot').length;
                    hasTempoMark = true;
                    if (!el.children.some((c) => c.name === 'sound' && parseFloat(c.attrs.tempo) > 0))
                      M.tempos.push({ pos, qpm: pm * typeQuarters(units[0].text.trim(), dots) });
                  }
                  break;
                }
                case 'words':
                  words.push(t.text);
                  break;
                case 'segno':
                  marks.push({ m: mi, pos, kind: 'segno' });
                  break;
                case 'coda':
                  if (!el.children.some((c) => c.name === 'sound' && (c.attrs.coda !== undefined || c.attrs.tocoda !== undefined))) M.codaSign = { pos };
                  break;
                case 'pedal': {
                  const ty = t.attrs.type;
                  pedalMark = true;
                  if (ty === 'start' || ty === 'resume') M.pedal.push({ pos, type: 'down' });
                  else if (ty === 'stop' || ty === 'discontinue') M.pedal.push({ pos, type: 'up' });
                  else if (ty === 'change') M.pedal.push({ pos, type: 'change' });
                  break;
                }
                // octave-shift: MusicXML pitches are the sounding pitches (the mark only changes how they
                // are displayed), so nothing to do
              }
            }
            for (const w of words) {
              const j = jumpFromWords(w);
              if (j) {
                if (j.jump) {
                  M.jump = j.jump;
                  wordsJump = true;
                }
                if (j.toCoda) marks.push({ m: mi, pos, kind: 'toCoda', id: j.id });
                if (j.fine) M.fine = true;
                if (j.coda) marks.push({ m: mi, pos, kind: 'coda', id: j.id });
                if (j.segno) marks.push({ m: mi, pos, kind: 'segno' });
              }
            }
            const snd = el.name === 'sound' ? el : child(el, 'sound');
            const hadTempo = M.tempos.length;
            const sdyn = readSound(snd, pos, wordsJump, pedalMark);
            // <sound dynamics>: percent of forte (MIDI velocity 90)
            if (Number.isFinite(sdyn) && level === null) M.dynamics.push({ part: pi, pos, vel: Math.max(0.05, Math.min(1, (sdyn * 0.9) / 127)), kind: 'level' });
            if (!hasTempoMark && M.tempos.length === hadTempo && words.length) {
              const qpm = tempoFromWords(words.join(' '));
              if (qpm) M.tempos.push({ pos, qpm });
            }
            break;
          }
          case 'barline': {
            const loc = el.attrs.location ?? 'right';
            const rep = child(el, 'repeat');
            if (rep?.attrs.direction === 'forward') M.repeatStart = true;
            if (rep?.attrs.direction === 'backward') {
              const times = parseInt(rep.attrs.times ?? '', 10);
              M.repeatEnd = Math.max(M.repeatEnd ?? 0, times >= 1 ? times : 2);
              if (!(times >= 1)) M.repeatTimesImplied = true;
            }
            const end = child(el, 'ending');
            if (end && (endingsFromPart[mi] === undefined || endingsFromPart[mi] === pi)) {
              endingsFromPart[mi] = pi;
              const passes = parseEndingNumbers(end.attrs.number ?? '');
              if (end.attrs.type === 'start' && passes.length) (M as IRMeasure & { _endStart?: number[] })._endStart = passes;
              if (end.attrs.type === 'stop' || end.attrs.type === 'discontinue') (M as IRMeasure & { _endStop?: boolean })._endStop = true;
            }
            if (child(el, 'segno')) marks.push({ m: mi, pos: loc === 'left' ? 0 : Infinity, kind: 'segno' });
            if (child(el, 'coda')) M.codaSign = { pos: loc === 'left' ? 0 : Infinity };
            if (child(el, 'fermata') && loc === 'right') {
              /* a fermata on the barline: held at the end of the bar (applied below, once the length is known) */
              (M as IRMeasure & { _barFermata?: boolean })._barFermata = true;
            }
            break;
          }
          case 'note': {
            if (child(el, 'cue')) {
              if (!child(el, 'chord')) {
                cursor += dv(childNum(el, 'duration'));
                high = Math.max(high, cursor);
              }
              break;
            }
            const isChord = !!child(el, 'chord');
            const graceEl = child(el, 'grace');
            const durDiv = graceEl ? 0 : dv(childNum(el, 'duration'));
            const dur = at(durDiv);
            const pos = at(isChord ? lastStart : cursor);
            if (!isChord) {
              lastStart = cursor;
              cursor += durDiv;
              high = Math.max(high, cursor);
            }
            const staff = childNum(el, 'staff') || 1;
            const nots = childrenNamed(el, 'notations');
            const hasFermata = nots.some((n) => !!child(n, 'fermata'));
            if (hasFermata && dur > 0) M.fermatas.push({ pos, dur });
            const pitch = child(el, 'pitch');
            if (child(el, 'unpitched')) hadUnpitched = true;
            if (!pitch || percussionStaff.has(staff)) {
              if (pitch) hadUnpitched = true;
              break;
            }
            const step = childText(pitch, 'step').toUpperCase();
            const octave = childNum(pitch, 'octave');
            if (STEP_PC[step] === undefined || !Number.isFinite(octave)) break;
            const alter = Math.round(childNum(pitch, 'alter') || 0);
            const written = (octave + 1) * 12 + STEP_PC[step] + alter;
            hadPitched = true;
            const ties = childrenNamed(el, 'tie').map((t) => t.attrs.type);
            for (const n of nots) for (const t of childrenNamed(n, 'tied')) ties.push(t.attrs.type === 'continue' ? 'both' : t.attrs.type);
            const arts = nots.flatMap((n) => childrenNamed(n, 'articulations').flatMap((a) => a.children.map((c) => c.name)));
            const accent = arts.includes('strong-accent') ? 0.18 : arts.includes('accent') ? 0.12 : 0;
            const dynAttr = parseFloat(el.attrs.dynamics);
            const note: RawNote = {
              part: pi,
              staff,
              voice: `${staff}:${childText(el, 'voice') || '1'}`,
              pos,
              dur,
              midi: written + chromatic,
              m: mi,
              seq: seq++,
              ...(isChord ? { chord: true } : {}),
              ...(ties.includes('start') || ties.includes('both') ? { tieStart: true } : {}),
              ...(ties.includes('stop') || ties.includes('both') ? { tieStop: true } : {}),
              ...(graceEl ? { grace: graceEl.attrs.slash === 'yes' ? 'acciaccatura' : 'appoggiatura' } : {}),
              ...(Number.isFinite(dynAttr) ? { vel: Math.max(0.05, Math.min(1, (dynAttr * 0.9) / 127)) } : {}),
              ...(accent ? { accent } : {}),
            };
            raw.push(note);
            break;
          }
        }
      }
      lengths[mi].push(at(high));
    });

    if (!hadPitched && hadUnpitched) {
      part.ignored = true;
      warnings.push(`“${name}” is a drum part and was left out.`);
    } else if (drumChannel && !hadPitched) part.ignored = true;
    for (const n of raw) {
      const { m, ...note } = n;
      measures[m].notes.push(note);
    }
  });

  // ---- measure lengths, endings
  let open: { id: number; passes: number[] } | null = null;
  measures.forEach((M, mi) => {
    const content = Math.max(0, ...lengths[mi]);
    const nominal = (M.beats * 4) / M.beatType;
    M.length = content > EPS ? content : nominal;
    const ext = M as IRMeasure & { _endStart?: number[]; _endStop?: boolean; _barFermata?: boolean };
    if (ext._endStart) open = { id: ++endingId, passes: ext._endStart };
    if (open) M.ending = open;
    if (ext._endStop) open = null;
    if (ext._barFermata) M.fermatas.push({ pos: Math.max(0, M.length - Math.min(1, M.length)), dur: Math.min(1, M.length) });
    if (M.codaSign && !Number.isFinite(M.codaSign.pos)) M.codaSign = { pos: M.length };
    delete ext._endStart;
    delete ext._endStop;
    delete ext._barFermata;
  });
  // a segno or coda at the very end of a measure belongs to the next one; a To Coda at the very
  // start of a measure means "after the previous one"
  for (const mk of marks) {
    const M = measures[mk.m];
    const end = !Number.isFinite(mk.pos) || mk.pos >= M.length - EPS;
    if (mk.kind === 'toCoda') {
      const T = measures[mk.pos <= EPS && mk.m > 0 ? mk.m - 1 : mk.m];
      T.toCoda = true;
      if (mk.id) T.toCodaId = mk.id;
    } else {
      const T = measures[end && mk.m + 1 < measures.length ? mk.m + 1 : mk.m];
      if (mk.kind === 'segno') T.segno = true;
      else {
        T.coda = true;
        if (mk.id) T.codaId = mk.id;
      }
    }
  }
  resolveCodaSigns(measures);
  return { title: title || undefined, composer: composer || undefined, parts, measures, warnings };
}
