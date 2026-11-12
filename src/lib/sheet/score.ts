/** Builds the notation Score of an arrangement: grid → quantize → voices → clefs/octave marks → tempo marks. */
import type { Difficulty, KeyInfo, Note, TempoInfo } from '../music/types';
import { chooseClefs, findOttavas } from './clefs';
import { buildGrid } from './grid';
import { quantize, type RawNote } from './quantize';
import { keyFifths } from './spelling';
import { DIV, LEVEL_RULES, type ClefSign, type Score, type StaffVoices, type TempoMark, type TimeMap } from './types';
import { assignVoices } from './voices';

export interface ScoreInput {
  notes: Pick<Note, 'midi' | 'start' | 'dur' | 'hand'>[];
  tempo: TempoInfo;
  key?: Pick<KeyInfo, 'tonic' | 'mode'> | null;
  duration: number;
  level: Difficulty;
}

function tempoMarks(time: TimeMap, measureStartTimes: number[], measureCount: number): TempoMark[] {
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
    const len = m === 0 && time.pickup ? time.pickup : time.measureLen;
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
  const time = buildGrid(tempo, duration, notes);
  const base = LEVEL_RULES[level];
  const rules = time.compound ? { ...base, grids: base.grids.filter((g) => g !== 3) } : base;
  const raw: RawNote[] = notes.map((n) => ({
    midi: n.midi,
    on: time.toPos(n.start),
    off: time.toPos(n.start + Math.max(0.01, n.dur)),
    staff: n.hand === 'R' ? 1 : n.hand === 'L' ? 2 : n.midi >= 60 ? 1 : 2,
  }));
  const q = quantize(raw, rules);
  const vctx = {
    beatLen: time.beatLen,
    isBeat: (pos: number) => (pos - time.measureStart(time.measureOf(pos))) % time.beatLen === 0,
    tripletQuarters: q.tripletQuarters,
  };
  const staves = ([1, 2] as const).map(
    (s): StaffVoices => ({ staff: s, voices: assignVoices(q.notes.filter((n) => n.staff === s), s, rules, vctx) }),
  ) as [StaffVoices, StaffVoices];
  let end = 0;
  for (const sv of staves) for (const v of sv.voices) for (const c of v) end = Math.max(end, c.off);
  const measureCount = Math.max(1, time.measureOf(Math.max(0, end - 1)) + 1);
  const measureStartTimes: number[] = [];
  for (let m = 0; m <= measureCount; m++) measureStartTimes.push(time.posToTime(time.measureStart(m)));

  const fifths = keyFifths(input.key);
  const mode = input.key?.mode === 'minor' ? 'minor' : 'major';
  const minorTonic = input.key && mode === 'minor' ? ((Math.round(input.key.tonic) % 12) + 12) % 12 : undefined;

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
    tempoMarks: tempoMarks(time, measureStartTimes, measureCount),
  };
}
