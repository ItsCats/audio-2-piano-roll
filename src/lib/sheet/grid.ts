/**
 * Measures and the time map of a song: song seconds ↔ positions in divisions, from the song's
 * beat grid (tracked beats, a MIDI tempo map, or a regular grid when there is none).
 */
import { beatToTime, estimateTempo, regularBeats, timeToBeat, upperBound } from '../music/beats';
import type { Note, SheetGridLock, SheetMeter, TempoInfo } from '../music/types';
import { DIV, type TimeMap } from './types';

export function resolveMeter(tempo: TempoInfo): { beatsPerBar: number; beatUnit: 2 | 4 | 8; compound: boolean } {
  const bpb = Number.isInteger(tempo.beatsPerBar) && tempo.beatsPerBar >= 1 && tempo.beatsPerBar <= 16 ? tempo.beatsPerBar : 4;
  let unit: 2 | 4 | 8 = tempo.beatUnit === 2 || tempo.beatUnit === 8 ? tempo.beatUnit : 4;
  if (!tempo.beatUnit && tempo.source === 'midi' && (bpb === 6 || bpb === 9 || bpb === 12)) unit = 8;
  return { beatsPerBar: bpb, beatUnit: unit, compound: unit === 8 && bpb % 3 === 0 };
}

/**
 * Share of note onsets that sit on the tempo map's 16th or triplet-8th grid (within 1/32 of a
 * quarter). A written-out MIDI file scores near 1; a recorded performance over a default
 * 120 BPM header scores about 0.4.
 */
export function gridFit(tempo: TempoInfo, onsets: number[]): number {
  if (tempo.beats.length < 2 || !onsets.length) return 1;
  const qPerBeat = 4 / resolveMeter(tempo).beatUnit;
  const pts = [0, 0.25, 1 / 3, 0.5, 2 / 3, 0.75, 1];
  const step = Math.max(1, Math.floor(onsets.length / 3000));
  let hit = 0;
  let n = 0;
  for (let i = 0; i < onsets.length; i += step) {
    const q = timeToBeat(tempo.beats, onsets[i], tempo.bpm) * qPerBeat;
    const x = q - Math.floor(q);
    if (pts.some((p) => Math.abs(x - p) <= 1 / 32)) hit++;
    n++;
  }
  return hit / n;
}

/**
 * The tempo to write the sheet with. A MIDI file whose tempo map is one constant tempo that the
 * notes don't follow (a recorded performance with a default 120 BPM header, e.g. MAESTRO) gets
 * its beats tracked from the notes instead, like an audio transcription; anything else is kept.
 */
export function sheetTempo(tempo: TempoInfo, notes: Note[], duration: number): TempoInfo {
  if (tempo.source !== 'midi' || tempo.beats.length < 8 || notes.length < 16) return tempo;
  const ibis = tempo.beats.slice(1).map((b, i) => b - tempo.beats[i]);
  const med = median(ibis);
  if (!(med > 0) || ibis.some((d) => Math.abs(d / med - 1) > 0.005)) return tempo;
  if (gridFit(tempo, notes.map((n) => n.start)) >= 0.6) return tempo;
  const est = estimateTempo(notes, duration);
  return est.beats.length >= 4 ? est : tempo;
}

function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

function localBpm(beats: number[], from: number, count: number): number {
  const ibis: number[] = [];
  for (let i = Math.max(0, from); i < Math.min(beats.length - 1, from + count); i++) ibis.push(beats[i + 1] - beats[i]);
  const m = median(ibis);
  return m > 0 ? 60 / m : NaN;
}

/**
 * Builds the beat grid and measures.
 * - Beats: `tempo.beats` when there are at least 2, otherwise a regular grid at `tempo.bpm`
 *   starting at the first note.
 * - Estimated tempo only: ≥ 180 BPM takes every second beat (the tracker probably locked onto
 *   8th notes); < 45 BPM adds midpoints.
 * - A pickup measure (implicit, whole beats) when the music starts before the first downbeat;
 *   leading empty bars are dropped.
 */
export function buildGrid(tempo: TempoInfo, duration: number, notes: { start: number }[]): TimeMap {
  return gridFromLock(gridParams(tempo, duration, notes), tempo.source);
}

/** The values a TimeMap is made from (the same as a Song.sheet grid lock). */
export function gridParams(tempo: TempoInfo, duration: number, notes: { start: number }[]): SheetGridLock {
  const { beatsPerBar, beatUnit } = resolveMeter(tempo);
  // loops, not Math.min(...notes): Safari can't spread tens of thousands of arguments
  let firstStart = notes.length ? Infinity : 0;
  for (const n of notes) if (n.start < firstStart) firstStart = n.start;
  const fallbackBpm = tempo.bpm > 0 && Number.isFinite(tempo.bpm) ? tempo.bpm : 120;
  let beats: number[];
  let db: number;
  if (tempo.beats.length >= 2) {
    beats = tempo.beats;
    db = Math.max(0, Math.min(beats.length - 1, Math.round(tempo.downbeatIndex) || 0));
  } else {
    beats = regularBeats(fallbackBpm, Math.max(0, firstStart), Math.max(duration, firstStart + 1));
    db = Math.max(0, upperBound(beats, firstStart + 1e-6) - 1);
  }
  if (tempo.source === 'estimated' && beats.length >= 4) {
    const bpm0 = localBpm(beats, 0, beats.length);
    if (bpm0 >= 180) {
      const s = db % 2;
      beats = beats.filter((_, i) => i % 2 === s);
      db = (db - s) / 2;
    } else if (bpm0 < 45) {
      const out: number[] = [];
      for (let i = 0; i < beats.length; i++) {
        out.push(beats[i]);
        if (i + 1 < beats.length) out.push((beats[i] + beats[i + 1]) / 2);
      }
      beats = out;
      db *= 2;
    }
  }
  const bpmBeats = localBpm(beats, db, beatsPerBar * 2);
  const bpm = Number.isFinite(bpmBeats) ? bpmBeats : fallbackBpm;
  const qPerBeat = 4 / beatUnit;
  const toQ = (t: number) => (timeToBeat(beats, t, bpm) - db) * qPerBeat;
  const measureQ = beatsPerBar * qPerBeat;
  const tol = qPerBeat / 8;
  let originQ = 0;
  let pickupQ = 0;
  if (notes.length) {
    const minQ = toQ(firstStart);
    if (minQ < -tol) {
      const need = -minQ;
      if (need <= measureQ + tol) {
        const p = Math.max(1, Math.ceil(need / qPerBeat - 0.125)) * qPerBeat;
        if (p >= measureQ - 1e-9) originQ = -measureQ;
        else {
          originQ = -p;
          pickupQ = p;
        }
      } else originQ = -Math.ceil(need / measureQ - 0.125 / beatsPerBar) * measureQ;
    } else if (minQ >= measureQ - tol) {
      originQ = Math.floor((minQ + tol) / measureQ) * measureQ;
    }
  }
  return { beats, db, bpm, beatsPerBar, beatUnit, originQ, pickup: Math.round(pickupQ * DIV) };
}

/** Beat group (divisions) and compound flag of a meter. */
export function meterShape(beatsPerBar: number, beatUnit: 2 | 4 | 8): { compound: boolean; beatLen: number; measureLen: number } {
  const compound = beatUnit === 8 && beatsPerBar % 3 === 0;
  return { compound, beatLen: compound ? 18 : beatUnit === 2 ? 24 : beatUnit === 8 ? 6 : 12, measureLen: Math.round(beatsPerBar * (4 / beatUnit) * DIV) };
}

/** A run of measures in one meter (time-signature changes split the piece into these). */
interface Seg {
  pos: number;
  m0: number;
  len: number;
  beatsPerBar: number;
  beatUnit: 2 | 4 | 8;
  compound: boolean;
  beatLen: number;
}

/**
 * The TimeMap of grid values (buildGrid's, or a song's locked grid). `meters` (Song.sheet.meters)
 * relabel the bars from a measure start: positions and seconds never change, only the grouping
 * into measures (a change that isn't on a bar line ends the measure before it early).
 */
export function gridFromLock(lock: SheetGridLock, source: TempoInfo['source'], meters?: SheetMeter[]): TimeMap {
  const { beats, db, bpm, beatsPerBar, beatUnit, originQ, pickup } = lock;
  const { compound, beatLen, measureLen } = meterShape(beatsPerBar, beatUnit);
  const qPerBeat = 4 / beatUnit;
  const toQ = (t: number) => (timeToBeat(beats, t, bpm) - db) * qPerBeat;
  const base = {
    beatsPerBar,
    beatUnit,
    compound,
    beatLen,
    measureLen,
    pickup,
    toPos: (t: number) => (toQ(t) - originQ) * DIV,
    posToTime: (pos: number) => beatToTime(beats, (pos / DIV + originQ) / qPerBeat + db, bpm),
    bpm,
    source,
  };
  if (!meters?.length) {
    // one meter: the plain formulas
    const measureStart = (m: number) => (pickup ? (m <= 0 ? 0 : pickup + (m - 1) * measureLen) : Math.max(0, m) * measureLen);
    const measureOf = (pos: number) => {
      if (pos <= 0) return 0;
      if (!pickup) return Math.floor(pos / measureLen);
      return pos < pickup ? 0 : 1 + Math.floor((pos - pickup) / measureLen);
    };
    const meter = { beatsPerBar, beatUnit, compound, beatLen, measureLen };
    return {
      ...base,
      measureStart,
      measureOf,
      measureLenAt: (m) => (pickup && m <= 0 ? pickup : measureLen),
      meterAt: () => meter,
      changes: false,
    };
  }
  // measure-0 segment (a meter at pos 0 relabels it; the pickup stays), then one per change
  const at0 = meters.find((x) => x.pos === 0);
  const first = at0 ? { beatsPerBar: at0.beatsPerBar, beatUnit: at0.beatUnit, ...meterShape(at0.beatsPerBar, at0.beatUnit) } : { beatsPerBar, beatUnit, compound, beatLen, measureLen };
  const segs: Seg[] = [{ pos: 0, m0: 0, len: first.measureLen, beatsPerBar: first.beatsPerBar, beatUnit: first.beatUnit, compound: first.compound, beatLen: first.beatLen }];
  const segStart = (sg: Seg, m: number) => (sg.m0 === 0 && pickup ? (m <= 0 ? 0 : pickup + (m - 1) * sg.len) : sg.pos + (m - sg.m0) * sg.len);
  const segOf = (sg: Seg, pos: number) => (sg.m0 === 0 && pickup ? (pos < pickup ? 0 : 1 + Math.floor((pos - pickup) / sg.len)) : sg.m0 + Math.floor((pos - sg.pos) / sg.len));
  for (const x of [...meters].sort((a, b) => a.pos - b.pos)) {
    if (x.pos <= 0 || (pickup && x.pos < pickup)) continue;
    const prev = segs[segs.length - 1];
    if (x.pos <= prev.pos) continue;
    const pm = segOf(prev, x.pos);
    const m0 = segStart(prev, pm) === x.pos ? pm : pm + 1;
    const sh = meterShape(x.beatsPerBar, x.beatUnit);
    const sg: Seg = { pos: x.pos, m0, len: sh.measureLen, beatsPerBar: x.beatsPerBar, beatUnit: x.beatUnit, compound: sh.compound, beatLen: sh.beatLen };
    if (m0 === prev.m0) segs[segs.length - 1] = { ...sg, pos: prev.pos };
    else segs.push(sg);
  }
  const segByM = (m: number) => {
    let i = segs.length - 1;
    while (i > 0 && segs[i].m0 > m) i--;
    return segs[i];
  };
  const segByPos = (pos: number) => {
    let i = segs.length - 1;
    while (i > 0 && segs[i].pos > pos) i--;
    return segs[i];
  };
  const measureStart = (m: number) => (m <= 0 ? 0 : segStart(segByM(m), m));
  const measureOf = (pos: number) => (pos <= 0 ? 0 : segOf(segByPos(pos), pos));
  return {
    ...base,
    beatsPerBar: first.beatsPerBar,
    beatUnit: first.beatUnit,
    compound: first.compound,
    beatLen: first.beatLen,
    measureLen: first.measureLen,
    measureStart,
    measureOf,
    measureLenAt: (m) => measureStart(m + 1) - measureStart(m),
    meterAt: (m) => {
      const sg = segByM(m);
      return { beatsPerBar: sg.beatsPerBar, beatUnit: sg.beatUnit, compound: sg.compound, beatLen: sg.beatLen, measureLen: sg.len };
    },
    changes: true,
  };
}
