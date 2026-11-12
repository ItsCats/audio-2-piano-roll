/**
 * Measures and the time map of a song: song seconds ↔ positions in divisions, from the song's
 * beat grid (tracked beats, a MIDI tempo map, or a regular grid when there is none).
 */
import { beatToTime, regularBeats, timeToBeat, upperBound } from '../music/beats';
import type { TempoInfo } from '../music/types';
import { DIV, type TimeMap } from './types';

export function resolveMeter(tempo: TempoInfo): { beatsPerBar: number; beatUnit: 2 | 4 | 8; compound: boolean } {
  const bpb = Number.isInteger(tempo.beatsPerBar) && tempo.beatsPerBar >= 1 && tempo.beatsPerBar <= 16 ? tempo.beatsPerBar : 4;
  let unit: 2 | 4 | 8 = tempo.beatUnit === 2 || tempo.beatUnit === 8 ? tempo.beatUnit : 4;
  if (!tempo.beatUnit && tempo.source === 'midi' && (bpb === 6 || bpb === 9 || bpb === 12)) unit = 8;
  return { beatsPerBar: bpb, beatUnit: unit, compound: unit === 8 && bpb % 3 === 0 };
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
  const { beatsPerBar, beatUnit, compound } = resolveMeter(tempo);
  const firstStart = notes.length ? Math.min(...notes.map((n) => n.start)) : 0;
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
    const minQ = Math.min(...notes.map((n) => toQ(n.start)));
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
  const pickup = Math.round(pickupQ * DIV);
  const measureLen = Math.round(measureQ * DIV);
  const beatLen = compound ? 18 : beatUnit === 2 ? 24 : beatUnit === 8 ? 6 : 12;
  const measureStart = (m: number) => (pickup ? (m <= 0 ? 0 : pickup + (m - 1) * measureLen) : Math.max(0, m) * measureLen);
  const measureOf = (pos: number) => {
    if (pos <= 0) return 0;
    if (!pickup) return Math.floor(pos / measureLen);
    return pos < pickup ? 0 : 1 + Math.floor((pos - pickup) / measureLen);
  };
  return {
    beatsPerBar,
    beatUnit,
    compound,
    beatLen,
    measureLen,
    pickup,
    toPos: (t) => (toQ(t) - originQ) * DIV,
    posToTime: (pos) => beatToTime(beats, (pos / DIV + originQ) / qPerBeat + db, bpm),
    measureStart,
    measureOf,
    bpm,
    source: tempo.source,
  };
}
