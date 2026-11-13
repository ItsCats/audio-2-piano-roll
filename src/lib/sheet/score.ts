/** Builds the notation Score of an arrangement: grid → quantize → voices → clefs/octave marks → tempo marks. */
import type { Difficulty, KeyInfo, Note, PedalRange, SheetGridLock, SheetKey, SheetMark, SheetMeter, SheetTempo, TempoInfo, TempoUnit } from '../music/types';
import { chooseClefs, findOttavas } from './clefs';
import { buildGrid, gridFromLock } from './grid';
import { quantize, type RawNote } from './quantize';
import { keyFifths } from './spelling';
import { minorTonicOf } from './keys';
import { DIV, LEVEL_RULES, type ClefSign, type KeySig, type NoteMarks, type Score, type StaffVoices, type TempoMark, type TimeMap } from './types';
import { assignVoices } from './voices';

export interface ScoreInput {
  notes: (Pick<Note, 'midi' | 'start' | 'dur' | 'hand'> & Partial<Pick<Note, 'id' | 'pin' | 'finger' | 'art'>>)[];
  tempo: TempoInfo;
  key?: Pick<KeyInfo, 'tonic' | 'mode'> | null;
  duration: number;
  level: Difficulty;
  /** The song's locked grid (Song.sheet.grid): measures come from it, and note pins are used. */
  lock?: SheetGridLock;
  /** At least this many measures (Song.sheet.bars). */
  bars?: number;
  /** Song.sheet keys / meters / tempos (used with the lock). */
  keys?: SheetKey[];
  meters?: SheetMeter[];
  tempos?: SheetTempo[];
  /** Arrangement.marks. */
  marks?: SheetMark[];
  /** Arrangement.pedal when Arrangement.showPedal: written as pedal marks. */
  pedal?: PedalRange[];
}

/** Quarters in one beat of a tempo unit. */
export const TEMPO_UNIT_Q: Record<TempoUnit, number> = { q: 1, h: 2, e: 0.5, 'q.': 1.5 };

/** Whether a note's pin still holds: set by a sheet edit and the note not moved or resized since. */
export const pinValid = (n: Partial<Pick<Note, 'pin' | 'start' | 'dur'>>): boolean => !!n.pin && n.pin.t === n.start && n.pin.d === n.dur;

function tempoMarks(time: TimeMap, measureStartTimes: number[], measureCount: number, user?: SheetTempo[]): TempoMark[] {
  const inferred = inferredTempoMarks(time, measureStartTimes, measureCount);
  if (!user?.length) return inferred;
  // a tempo mark placed on the sheet replaces the inferred ones from its measure on
  const marks = user.map((u): TempoMark => ({ measure: Math.min(measureCount - 1, time.measureOf(u.pos)), bpm: u.bpm, qpm: Math.round(u.bpm * TEMPO_UNIT_Q[u.unit] * 100) / 100, unit: u.unit, ...(u.text ? { text: u.text } : {}) }));
  const firstUser = Math.min(...marks.map((mk) => mk.measure));
  const out = [...inferred.filter((mk) => mk.measure < firstUser), ...marks].sort((a, b) => a.measure - b.measure);
  return out.filter((mk, i) => i + 1 >= out.length || out[i + 1].measure !== mk.measure);
}

function inferredTempoMarks(time: TimeMap, measureStartTimes: number[], measureCount: number): TempoMark[] {
  const qPerBeat = 4 / time.beatUnit;
  const markBpm = (bpm: number) => (time.compound ? bpm / 3 : bpm);
  const round = (x: number) => (time.source === 'estimated' ? Math.max(5, Math.round(x / 5) * 5) : Math.round(x));
  const toQpm = (shown: number) => (time.compound ? shown * 3 : shown) * qPerBeat;
  const first = round(markBpm(time.bpm));
  const marks: TempoMark[] = [{ measure: 0, bpm: first, qpm: Math.round(toQpm(first) * 100) / 100 }];
  if (time.source === 'estimated') return marks;
  // local tempo of each bar (beat units per minute)
  const local: number[] = [];
  for (let m = 0; m < measureCount; m++) {
    const len = time.measureLenAt(m);
    const secs = measureStartTimes[m + 1] - measureStartTimes[m];
    local.push(secs > 0 ? markBpm((len / DIV / qPerBeat) * (60 / secs)) : NaN);
  }
  let cur = marks[0].bpm;
  for (let m = 1; m + 1 < measureCount; m++) {
    const a = local[m];
    const b = local[m + 1];
    if (!(a > 0 && b > 0)) continue;
    const far = (x: number) => Math.abs(x / cur - 1) >= 0.08;
    if (far(a) && far(b) && Math.abs(a / b - 1) < 0.04) {
      const bpm = round(a);
      if (bpm === cur) continue;
      marks.push({ measure: m, bpm, qpm: Math.round(toQpm(bpm) * 100) / 100 });
      cur = bpm;
    }
  }
  return marks;
}

export function buildScore(input: ScoreInput): Score {
  const { tempo, duration, level } = input;
  const notes = input.notes.filter((n) => Number.isFinite(n.start) && Number.isFinite(n.dur) && n.midi >= 0 && n.midi <= 127);
  const time = input.lock ? gridFromLock(input.lock, tempo.source, input.meters) : buildGrid(tempo, duration, notes);
  const base = LEVEL_RULES[level];
  // compound meters (6/8 …): no triplets, rests on the dotted-quarter beat (Easy) or 8ths, and a
  // lone 8th stays an 8th (the quarter grid is not a unit there)
  const rules = time.compound
    ? { ...base, grids: base.grids.filter((g) => g !== 3), restGrid: base.restGrid >= 12 ? 18 : base.restGrid, maxStep: 6 }
    : base;
  const raw: RawNote[] = notes.map((n) => ({
    midi: n.midi,
    on: time.toPos(n.start),
    off: time.toPos(n.start + Math.max(0.01, n.dur)),
    staff: n.hand === 'R' ? 1 : n.hand === 'L' ? 2 : n.midi >= 60 ? 1 : 2,
    ids: n.id !== undefined ? [n.id] : [],
    ...(input.lock && pinValid(n) && n.pin!.off > n.pin!.on ? { pin: { on: n.pin!.on, off: n.pin!.off } } : {}),
  }));
  const q = quantize(raw, rules);
  const vctx = {
    beatLen: time.beatLen,
    isBeat: time.changes
      ? (pos: number) => {
          const m = time.measureOf(pos);
          return (pos - time.measureStart(m)) % time.meterAt(m).beatLen === 0;
        }
      : (pos: number) => (pos - time.measureStart(time.measureOf(pos))) % time.beatLen === 0,
    tripletQuarters: q.tripletQuarters,
  };
  const staves = ([1, 2] as const).map(
    (s): StaffVoices => ({ staff: s, voices: assignVoices(q.notes.filter((n) => n.staff === s), s, rules, vctx) }),
  ) as [StaffVoices, StaffVoices];
  let end = 0;
  for (const sv of staves) for (const v of sv.voices) for (const c of v) end = Math.max(end, c.off);
  const measureCount = Math.max(1, time.measureOf(Math.max(0, end - 1)) + 1, input.lock ? Math.min(10000, input.bars ?? 0) : 0);
  const measureStartTimes: number[] = [];
  for (let m = 0; m <= measureCount; m++) measureStartTimes.push(time.posToTime(time.measureStart(m)));

  let fifths = keyFifths(input.key);
  let mode: 'major' | 'minor' = input.key?.mode === 'minor' ? 'minor' : 'major';
  let minorTonic = input.key && mode === 'minor' ? ((Math.round(input.key.tonic) % 12) + 12) % 12 : undefined;
  // key signatures placed on the sheet (one at pos 0 replaces the song's key on the sheet)
  const keys: KeySig[] = [{ measure: 0, fifths, mode, minorTonic }];
  if (input.lock && input.keys?.length) {
    for (const k of [...input.keys].sort((a, b) => a.pos - b.pos)) {
      const m = Math.min(measureCount - 1, time.measureOf(k.pos));
      const ks: KeySig = { measure: m, fifths: k.fifths, mode: k.mode, ...(k.mode === 'minor' ? { minorTonic: minorTonicOf(k.fifths) } : {}) };
      if (keys[keys.length - 1].measure === m) keys[keys.length - 1] = ks;
      else keys.push(ks);
    }
    ({ fifths, mode, minorTonic } = keys[0]);
    for (let i = keys.length - 1; i > 0; i--) if (keys[i].fifths === keys[i - 1].fifths && keys[i].mode === keys[i - 1].mode) keys.splice(i, 1);
  }

  // clefs per staff per measure from the notes shown in each measure
  const clefs = staves.map((sv) => {
    const per: number[][] = Array.from({ length: measureCount }, () => []);
    for (const v of sv.voices)
      for (const c of v) {
        const m0 = time.measureOf(c.on);
        const m1 = Math.min(measureCount - 1, time.measureOf(c.off - 1));
        for (let m = m0; m <= m1; m++) per[m].push(...c.midis);
      }
    return chooseClefs(per, sv.staff === 1 ? 'G' : 'F', rules.clefChanges, fifths);
  }) as [ClefSign[], ClefSign[]];
  const ottavas = staves.flatMap((sv) => {
    const cl = clefs[sv.staff - 1];
    const clefAt = (pos: number) => cl[Math.min(measureCount - 1, time.measureOf(pos))];
    const changeAfter = (pos: number) => {
      for (let m = time.measureOf(pos) + 1; m < measureCount; m++) if (cl[m] !== cl[m - 1]) return time.measureStart(m);
      return Infinity;
    };
    return findOttavas(sv, clefAt, changeAfter);
  });
  return {
    level,
    time,
    fifths,
    mode,
    minorTonic,
    measureCount,
    measureStartTimes,
    notes: q.notes,
    staves,
    tripletQuarters: q.tripletQuarters,
    clefs,
    ottavas,
    tempoMarks: tempoMarks(time, measureStartTimes, measureCount, input.lock ? input.tempos : undefined),
    keys,
    ...extras(input, time, rules.level),
  };
}

/** Markings, fingering / articulations and written pedal (only when there are any: older songs' Scores are unchanged). */
function extras(input: ScoreInput, time: TimeMap, level: Difficulty): Pick<Score, 'marks' | 'noteMarks' | 'pedals'> {
  const out: Pick<Score, 'marks' | 'noteMarks' | 'pedals'> = {};
  if (input.marks?.length) out.marks = input.marks;
  let nm: Map<number, NoteMarks> | undefined;
  for (const n of input.notes) {
    if (n.id === undefined || (!n.finger && !n.art?.length)) continue;
    nm ??= new Map();
    nm.set(n.id, { ...(n.finger ? { finger: n.finger } : {}), ...(n.art?.length ? { art: n.art } : {}) });
  }
  if (nm) out.noteMarks = nm;
  if (input.pedal) {
    const step = level === 'easy' ? 6 : 3;
    const snap = (t: number) => Math.max(0, Math.round(time.toPos(t) / step) * step);
    const ps: { on: number; off: number }[] = [];
    for (const p of [...input.pedal].sort((a, b) => a.start - b.start)) {
      if (!Number.isFinite(p.start) || !Number.isFinite(p.end)) continue;
      const on = snap(p.start);
      const off = Math.max(on + step, snap(p.end));
      const last = ps[ps.length - 1];
      if (last && on < last.off) last.off = Math.max(last.off, off);
      else ps.push({ on, off });
    }
    out.pedals = ps;
  }
  return out;
}
