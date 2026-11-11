/**
 * Generates Easy / Medium / Hard arrangements from the full (cleaned) transcription.
 *
 *  HARD   — the full transcription with both hands, untouched timing.
 *  MEDIUM — melody plus up to two supporting chord tones in the right hand, bass plus one
 *           consonant chord tone in the left hand, fast passages thinned to a 16th-note grid,
 *           light quantisation.
 *  EASY   — a single-line melody (skyline with ornament removal and octave-jump smoothing,
 *           kept in a comfortable range) over sustained left-hand bass notes on strong beats,
 *           quantised to 8th notes.
 */
import type { Arrangement, Difficulty, Note, PedalRange, TempoInfo } from './types';
import { clusterOnsets } from './hands';
import { beatPeriodAt, beatToTime, timeToBeat } from './beats';
import { quantizeNotes } from './quantize';
import { newNoteId, sortNotes } from './cleanup';

const CONSONANCE: Record<number, number> = { 3: 0.9, 4: 1, 5: 0.7, 7: 1, 8: 0.8, 9: 0.9, 12: 0.95, 15: 0.8, 16: 0.8 };

function fixSamePitchOverlaps(notes: Note[]): Note[] {
  const sorted = sortNotes(notes);
  const lastByPitch = new Map<number, Note>();
  const out: Note[] = [];
  for (const n of sorted) {
    const prev = lastByPitch.get(n.midi);
    if (prev && Math.abs(prev.start - n.start) < 0.01) {
      prev.dur = Math.max(prev.dur, n.dur);
      prev.vel = Math.max(prev.vel, n.vel);
      continue;
    }
    if (prev && prev.start + prev.dur > n.start) prev.dur = Math.max(0.03, n.start - prev.start - 0.005);
    lastByPitch.set(n.midi, n);
    out.push(n);
  }
  return out;
}

function quantStrength(tempo: TempoInfo): number {
  // weak tempo estimates should not drag notes onto a wrong grid
  return tempo.confidence > 0.25 ? 1 : tempo.confidence > 0.1 ? 0.6 : 0.3;
}

export function generateHard(base: Note[]): Note[] {
  return sortNotes(base.map((n) => ({ ...n })));
}

export function generateMedium(base: Note[], tempo: TempoInfo): Note[] {
  const clusters = clusterOnsets(base, 0.04);
  const rh: Note[][] = [];
  const lh: Note[][] = [];
  for (const c of clusters) {
    const r = c.filter((n) => n.hand === 'R').sort((a, b) => b.midi - a.midi);
    const l = c.filter((n) => n.hand === 'L').sort((a, b) => a.midi - b.midi);
    if (r.length) {
      const top = r[0];
      const support = r
        .slice(1)
        .filter((n) => top.midi - n.midi <= 12)
        .map((n) => ({ n, s: (CONSONANCE[top.midi - n.midi] ?? 0.2) + n.vel * 0.5 }))
        .sort((a, b) => b.s - a.s)
        .slice(0, r.length >= 4 ? 2 : 1)
        .map((x) => x.n);
      rh.push([top, ...support]);
    }
    if (l.length) {
      const bass = l[0];
      const extra = l
        .slice(1)
        .filter((n) => n.midi - bass.midi <= 16)
        .map((n) => ({ n, s: (CONSONANCE[n.midi - bass.midi] ?? 0.1) + n.vel * 0.3 }))
        .sort((a, b) => b.s - a.s)
        .slice(0, 1)
        .map((x) => x.n);
      lh.push([bass, ...extra]);
    }
  }
  const thin = (groups: Note[][], divisions: number): Note[] => {
    const kept: Note[][] = [];
    for (const g of groups) {
      const prev = kept[kept.length - 1];
      const minGap = (beatPeriodAt(tempo.beats, g[0].start, tempo.bpm) / divisions) * 0.85;
      if (prev && g[0].start - prev[0].start < minGap) {
        const strength = (x: Note[]) => Math.max(...x.map((n) => n.vel)) + x[0].midi / 400;
        if (strength(g) > strength(prev) + 0.15) kept[kept.length - 1] = g;
        continue;
      }
      kept.push(g);
    }
    return kept.flat();
  };
  const notes = [...thin(rh, 4), ...thin(lh, 2)].map((n) => ({ ...n, id: newNoteId() }));
  const q = quantizeNotes(notes, tempo, {
    subdivision: 4,
    strength: quantStrength(tempo),
    quantizeDurations: false,
    window: 0.45,
  });
  return fixSamePitchOverlaps(q);
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function generateEasy(base: Note[], tempo: TempoInfo, duration: number): Note[] {
  if (!base.length) return [];
  const clusters = clusterOnsets(base, 0.05);
  const medVel = median(base.map((n) => n.vel));
  // 1) skyline melody candidates
  let cands: Note[] = [];
  for (const c of clusters) {
    const r = c.filter((n) => n.hand === 'R');
    const pool = r.length ? r : c.filter((n) => n.midi >= 57);
    if (!pool.length) continue;
    const top = pool.reduce((a, b) => (b.midi > a.midi ? b : a));
    cands.push(top);
  }
  // drop ornaments: very short and quieter than typical
  cands = cands.filter((n) => {
    const eighth = beatPeriodAt(tempo.beats, n.start, tempo.bpm) / 2;
    return !(n.dur < eighth * 0.4 && n.vel < medVel * 0.85);
  });
  // 2) at most one melody note per 8th-note slot
  const bySlot = new Map<number, Note>();
  for (const n of cands) {
    const slot = Math.round(timeToBeat(tempo.beats, n.start, tempo.bpm) * 2);
    const prev = bySlot.get(slot);
    const score = (x: Note) => x.vel + Math.min(x.dur, 1) * 0.4 + x.midi / 300;
    if (!prev || score(n) > score(prev)) bySlot.set(slot, n);
  }
  let melody = [...bySlot.values()].sort((a, b) => a.start - b.start).map((n) => ({ ...n, hand: 'R' as const }));
  // 3) comfortable register & octave-jump smoothing
  const med = median(melody.map((n) => n.midi));
  const globalShift = med > 84 ? -12 * Math.ceil((med - 79) / 12) : med < 60 ? 12 * Math.ceil((60 - med) / 12) : 0;
  const recent: number[] = [];
  melody = melody.map((n) => {
    let p = n.midi + globalShift;
    if (recent.length) {
      const ref = median(recent.slice(-6));
      while (p - ref > 12 && p - 12 >= 55) p -= 12;
      while (ref - p > 12 && p + 12 <= 91) p += 12;
    }
    recent.push(p);
    return { ...n, midi: p };
  });
  // monophonic: each melody note ends when the next begins
  for (let i = 0; i < melody.length - 1; i++) {
    const gap = melody[i + 1].start - melody[i].start;
    melody[i].dur = Math.max(0.08, Math.min(melody[i].dur, gap - 0.01));
  }

  // 4) left hand: one sustained bass note per strong beat group
  const lhNotes: Note[] = [];
  const sortedBase = sortNotes(base);
  const step = tempo.bpm < 75 ? 1 : 2; // beats per LH note
  const firstBeat = Math.floor(timeToBeat(tempo.beats, sortedBase[0].start, tempo.bpm));
  const lastBeat = Math.ceil(timeToBeat(tempo.beats, duration, tempo.bpm));
  const phase = ((tempo.downbeatIndex % step) + step) % step;
  let b0 = firstBeat - (((firstBeat - phase) % step) + step) % step;
  let j = 0;
  for (; b0 <= lastBeat; b0 += step) {
    const t0 = beatToTime(tempo.beats, b0, tempo.bpm);
    const t1 = beatToTime(tempo.beats, b0 + step, tempo.bpm);
    const tol = (t1 - t0) * 0.2;
    while (j < sortedBase.length && sortedBase[j].start < t0 - tol) j++;
    let lowest: Note | null = null;
    for (let k = j; k < sortedBase.length && sortedBase[k].start < t1 - tol; k++) {
      const n = sortedBase[k];
      if (n.hand !== 'L') continue;
      if (!lowest || n.midi < lowest.midi) lowest = n;
    }
    if (!lowest) {
      // nothing new: let the previous bass note keep sounding if the source still does
      continue;
    }
    let p = lowest.midi;
    while (p < 45) p += 12;
    while (p > 57) p -= 12;
    const start = Math.abs(lowest.start - t0) < (t1 - t0) / 2 ? t0 : lowest.start;
    const prev = lhNotes[lhNotes.length - 1];
    if (prev && prev.midi === p && Math.abs(prev.start + prev.dur - start) < 0.15) {
      prev.dur = t1 - prev.start - 0.02;
      continue;
    }
    lhNotes.push({
      id: newNoteId(),
      midi: p,
      start,
      dur: Math.max(0.15, t1 - start - 0.02),
      vel: Math.min(1, 0.35 + lowest.vel * 0.45),
      hand: 'L',
    });
  }
  // keep the left hand below the melody
  for (const l of lhNotes) {
    const over = melody.find((m) => m.start <= l.start + 0.05 && m.start + m.dur > l.start && m.midi - l.midi < 4);
    if (over && l.midi - 12 >= 36) l.midi -= 12;
  }
  const rh = melody.map((n) => ({ ...n, id: newNoteId(), vel: Math.min(1, 0.45 + n.vel * 0.45) }));
  const q = quantizeNotes([...rh, ...lhNotes], tempo, {
    subdivision: 2,
    strength: quantStrength(tempo),
    quantizeDurations: false,
    window: 0.5,
  });
  return fixSamePitchOverlaps(q);
}

export function generateArrangement(
  difficulty: Difficulty,
  base: Note[],
  basePedal: PedalRange[],
  tempo: TempoInfo,
  duration: number,
): Arrangement {
  const notes =
    difficulty === 'hard' ? generateHard(base) : difficulty === 'medium' ? generateMedium(base, tempo) : generateEasy(base, tempo, duration);
  return {
    notes,
    pedal: difficulty === 'easy' ? [] : basePedal.map((p) => ({ ...p })),
    edited: false,
    generatedAt: Date.now(),
  };
}

export function generateAllArrangements(
  base: Note[],
  basePedal: PedalRange[],
  tempo: TempoInfo,
  duration: number,
): Record<Difficulty, Arrangement> {
  return {
    easy: generateArrangement('easy', base, basePedal, tempo, duration),
    medium: generateArrangement('medium', base, basePedal, tempo, duration),
    hard: generateArrangement('hard', base, basePedal, tempo, duration),
  };
}
