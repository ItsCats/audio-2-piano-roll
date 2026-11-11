/**
 * Generates Easy / Medium / Hard arrangements from the full (cleaned) transcription.
 *
 *  HARD   — the full transcription with both hands, untouched timing.
 *  MEDIUM — melody plus up to two supporting chord tones in the right hand, bass plus one
 *           consonant chord tone in the left hand, fast passages thinned to a 16th-note grid,
 *           light quantisation.
 *  EASY   — a single-line melody (skyline with ornament removal and octave-jump smoothing,
 *           kept in a comfortable range) over a sustained left-hand bass line that follows the
 *           lowest sounding note beat by beat, quantised to 8th notes.
 *
 * When the transcription carries a sung melody line (notes with role 'melody', from the
 * separated vocal stem), the arrangements are built around it instead:
 *  EASY   right hand = the melody line itself (one note at a time, quantised, register-folded);
 *  MEDIUM right hand = the melody plus up to two consonant chord tones BELOW it taken from the
 *         accompaniment; left hand as usual from the accompaniment;
 *  HARD   everything.
 */
import type { Arrangement, Difficulty, Note, PedalRange, TempoInfo } from './types';
import { clusterOnsets } from './hands';
import { beatPeriodAt, beatToTime, timeToBeat } from './beats';
import { quantizeNotes } from './quantize';
import { newNoteId, songDuration, sortNotes } from './cleanup';

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

/** Two bars of 4/4 without singing count as an instrumental stretch. */
const MELODY_GAP_BEATS = 8;

/**
 * Stretches of at least `minBeats` beats in which no melody note sounds, shrunk by one beat at
 * each end (so instrumental fills never butt against the sung line).
 */
export function melodyGaps(melody: Note[], tempo: TempoInfo, duration: number, minBeats = MELODY_GAP_BEATS): [number, number][] {
  const gaps: [number, number][] = [];
  const mel = sortNotes(melody);
  let cursor = 0;
  const push = (a: number, b: number, last: boolean) => {
    const beat = beatPeriodAt(tempo.beats, a, tempo.bpm);
    if (b - a >= beat * minBeats) gaps.push([a === 0 ? -Infinity : a + beat, last ? Infinity : b - beat]);
  };
  for (const m of mel) {
    if (m.start > cursor) push(cursor, m.start, false);
    cursor = Math.max(cursor, m.start + m.dur);
  }
  if (duration > cursor) push(cursor, duration, true);
  return gaps;
}

function inRanges(ranges: [number, number][], t: number): boolean {
  for (const [a, b] of ranges) if (t >= a && t < b) return true;
  return false;
}

export function generateHard(base: Note[]): Note[] {
  return sortNotes(base.map((n) => ({ ...n })));
}

export function generateMedium(base: Note[], tempo: TempoInfo): Note[] {
  const melody = base.filter((n) => n.role === 'melody');
  const accomp = melody.length ? base.filter((n) => n.role !== 'melody') : base;
  const clusters = clusterOnsets(accomp, 0.04);
  // with a sung line the right hand follows it; the accompaniment's right hand only fills long
  // instrumental stretches
  const gaps = melody.length ? melodyGaps(melody, tempo, songDuration(base)) : [[-Infinity, Infinity] as [number, number]];
  const rh: Note[][] = [];
  const lh: Note[][] = [];
  for (const c of clusters) {
    const r = c.filter((n) => n.hand === 'R').sort((a, b) => b.midi - a.midi);
    const l = c.filter((n) => n.hand === 'L').sort((a, b) => a.midi - b.midi);
    if (r.length && inRanges(gaps, c[0].start)) {
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
  const sungGroups = new Set<Note[]>(melody.length ? melodyWithChordTones(melody, accomp, 2) : []);
  rh.push(...sungGroups);
  rh.sort((a, b) => a[0].start - b[0].start);
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
  const sungNotes = new Set<Note>([...sungGroups].flat());
  const rhKept = thin(rh, 4);
  const keepEnd = rhKept.map((n) => sungNotes.has(n));
  const notes = [...rhKept, ...thin(lh, 2)].map((n) => ({ ...n, id: newNoteId() }));
  const q = quantizeNotes(notes, tempo, {
    subdivision: 4,
    strength: quantStrength(tempo),
    quantizeDurations: false,
    window: 0.45,
  });
  // a sung line (and the chord tones struck with it) keeps its note ends
  for (let i = 0; i < keepEnd.length; i++) if (keepEnd[i]) q[i] = { ...q[i], dur: Math.max(0.06, notes[i].start + notes[i].dur - q[i].start) };
  return fixSamePitchOverlaps(q);
}

/**
 * Melody notes, each with up to `maxTones` consonant accompaniment notes below it (within an
 * octave, not a unison/octave of the melody) that are struck with it (±60 ms) or sound at its
 * onset after starting shortly before. Chord tones are re-timed to the melody note, right hand.
 * Groups are sorted by time; the melody note comes first in each group.
 */
export function melodyWithChordTones(melody: Note[], accomp: Note[], maxTones: number): Note[][] {
  const acc = sortNotes(accomp);
  const starts = acc.map((n) => n.start);
  const groups: Note[][] = [];
  for (const m of sortNotes(melody)) {
    const tones: { n: Note; s: number }[] = [];
    // accompaniment notes starting within [m.start - 0.3, m.start + 0.06]
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] < m.start - 0.3) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < acc.length && acc[k].start <= m.start + 0.06; k++) {
      const a = acc[k];
      const iv = m.midi - a.midi;
      if (iv <= 0 || iv >= 12) continue; // below the melody, within an octave (unison/octave: no)
      const struck = Math.abs(a.start - m.start) <= 0.06;
      if (!struck && a.start + a.dur < m.start + 0.1) continue; // not sounding at the melody onset
      const cons = CONSONANCE[iv];
      if (!cons || cons < 0.7) continue;
      tones.push({ n: a, s: cons + a.vel * 0.5 + (struck ? 0.3 : 0) });
    }
    tones.sort((a, b) => b.s - a.s);
    const picked: Note[] = [];
    for (const t of tones) {
      if (picked.length >= maxTones) break;
      if (picked.some((p) => p.midi === t.n.midi || Math.abs(p.midi - t.n.midi) < 2)) continue; // no seconds
      picked.push(t.n);
    }
    groups.push([
      m,
      ...picked.map((p) => {
        const c: Note = { ...p, start: m.start, dur: Math.max(0.1, Math.min(m.dur, p.start + p.dur - m.start)), hand: 'R' };
        delete c.role;
        return c;
      }),
    ]);
  }
  return groups;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function generateEasy(base: Note[], tempo: TempoInfo, duration: number): Note[] {
  if (!base.length) return [];
  const sung = base.filter((n) => n.role === 'melody');
  const accomp = sung.length ? base.filter((n) => n.role !== 'melody') : base;
  const medVel = median((sung.length ? sung : base).map((n) => n.vel));
  // 1) melody candidates: the sung line when there is one (plus the accompaniment's top line in
  //    long instrumental stretches: intro, interludes, solos), else the right-hand skyline
  const gaps = sung.length ? melodyGaps(sung, tempo, duration) : [[-Infinity, Infinity] as [number, number]];
  const skyline: Note[] = [];
  const rhShare = accomp.filter((n) => n.hand === 'R').length / (accomp.length || 1);
  for (const c of clusterOnsets(accomp, 0.05)) {
    if (!inRanges(gaps, c[0].start)) continue;
    // melody comes from the right hand; only if the song has (almost) no right-hand part do
    // we fall back to the upper register of everything
    const pool = rhShare > 0.1 ? c.filter((n) => n.hand === 'R') : c.filter((n) => n.midi >= 57);
    if (!pool.length) continue;
    skyline.push(pool.reduce((a, b) => (b.midi > a.midi ? b : a)));
  }
  let cands: Note[] = sortNotes([...sung, ...skyline]);
  // drop ornaments: very short and quieter than typical
  cands = cands.filter((n) => {
    const eighth = beatPeriodAt(tempo.beats, n.start, tempo.bpm) / 2;
    return !(n.dur < eighth * 0.4 && n.vel < medVel * 0.85);
  });
  // 2) at most one melody note per 8th-note slot
  const bySlot = new Map<number, Note>();
  const slotEnd = new Map<number, number>();
  for (const n of cands) {
    const slot = Math.round(timeToBeat(tempo.beats, n.start, tempo.bpm) * 2);
    const prev = bySlot.get(slot);
    const score = (x: Note) => x.vel + Math.min(x.dur, 1) * 0.4 + (x.role === 'melody' ? 0 : x.midi / 300);
    if (!prev || score(n) > score(prev)) bySlot.set(slot, n);
    slotEnd.set(slot, Math.max(slotEnd.get(slot) ?? 0, n.start + n.dur));
  }
  let melody = [...bySlot.entries()]
    .sort((a, b) => a[1].start - b[1].start)
    // a sung line is legato: the kept note of a slot covers the notes it replaced
    .map(([slot, n]) => ({ ...n, dur: n.role === 'melody' ? Math.max(n.dur, slotEnd.get(slot)! - n.start) : n.dur, hand: 'R' as const }));
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

  // 4) left hand: a sustained bass line following the lowest sounding note
  const lhNotes = easyBassLine(accomp.filter((n) => n.hand === 'L'), tempo, duration);
  // keep the left hand below the melody
  for (const l of lhNotes) {
    const over = melody.find((m) => m.start <= l.start + 0.05 && m.start + m.dur > l.start && m.midi - l.midi < 4);
    if (over && l.midi - 12 >= 36) l.midi -= 12;
  }
  const rh = melody.map((n) => ({ ...n, id: newNoteId(), vel: Math.min(1, 0.45 + n.vel * 0.45) }));
  const qOpts = { subdivision: 2, strength: quantStrength(tempo), quantizeDurations: false, window: 0.5 };
  // A sung line keeps its syncopation: starts snap to 16ths and note ends stay where they were
  // (the 8th-slot thinning above already keeps it to one note per 8th).
  const q16 = quantizeNotes(rh, tempo, { ...qOpts, subdivision: 4 });
  const q8 = quantizeNotes(rh, tempo, qOpts);
  const qr = rh.map((n, i) => (n.role === 'melody' ? { ...q16[i], dur: Math.max(0.06, n.start + n.dur - q16[i].start) } : q8[i]));
  const q = [...qr, ...quantizeNotes(lhNotes, tempo, qOpts)];
  // quantising can pull melody notes together again: re-enforce a single line
  const qrh = q.filter((n) => n.hand === 'R').sort((a, b) => a.start - b.start || b.midi - a.midi);
  const line: Note[] = [];
  for (const n of qrh) {
    const prev = line[line.length - 1];
    if (prev && n.start - prev.start < 0.02) continue; // same slot after snapping: keep the first (highest)
    if (prev) prev.dur = Math.max(0.06, Math.min(prev.dur, n.start - prev.start - 0.01));
    line.push(n);
  }
  return fixSamePitchOverlaps([...line, ...q.filter((n) => n.hand === 'L')]);
}

/** Easy left-hand register (pitch classes are kept, octaves folded into it). */
const EASY_BASS_LOW = 43; // G2
const EASY_BASS_HIGH = 57; // A3

export interface EasyBassOptions {
  /** Analysis slot length in beats (default: 1, or ½ at slow tempos where a beat lasts ≥ 0.75 s). */
  slotBeats: number;
}

/**
 * Easy left hand: follows the lowest sounding left-hand note slot by slot (a beat, or half a
 * beat at slow tempos). Each slot is sampled at several points; the pitch that is the lowest
 * sounding note for most of the slot (weighted by velocity) wins. Consecutive slots with the
 * same pitch become one sustained note (pumping 8ths on one bass note → one held note);
 * octaves are folded into G2–A3, pitch classes are kept. Silent slots stay silent.
 *
 * (The previous version took the lowest note STARTING in each 2-beat window and held it for
 * the whole window: held bass notes and every change inside the window were lost, and a short
 * low passing/drum note could win — Easy LH matched the bass pitch class on 0.47 of voiced
 * frames vs 0.70 for the transcription's own lowest line; now 0.63.)
 */
export function easyBassLine(left: Note[], tempo: TempoInfo, duration: number, opts?: Partial<EasyBassOptions>): Note[] {
  if (!left.length) return [];
  const o: EasyBassOptions = { slotBeats: 60 / tempo.bpm >= 0.75 ? 0.5 : 1, ...opts };
  const sb = o.slotBeats;
  const notes = sortNotes(left);
  let maxDur = 0;
  for (const n of notes) maxDur = Math.max(maxDur, n.dur);
  const firstBeat = Math.floor(timeToBeat(tempo.beats, notes[0].start, tempo.bpm));
  const lastBeat = Math.ceil(timeToBeat(tempo.beats, Math.min(duration, songDuration(notes)), tempo.bpm));
  const K = Math.max(4, Math.round(8 * sb));
  type Slot = { b: number; t0: number; t1: number; midi: number; vel: number; onset: number } | null;
  const slots: Slot[] = [];
  let j = 0;
  for (let b = firstBeat; b < lastBeat; b += sb) {
    const t0 = beatToTime(tempo.beats, b, tempo.bpm);
    const t1 = beatToTime(tempo.beats, b + sb, tempo.bpm);
    while (j < notes.length && notes[j].start < t0 - maxDur) j++;
    const active: Note[] = [];
    for (let k = j; k < notes.length && notes[k].start < t1; k++) if (notes[k].start + notes[k].dur > t0) active.push(notes[k]);
    if (!active.length) {
      slots.push(null);
      continue;
    }
    const weight = new Map<number, number>();
    const first = new Map<number, Note>();
    for (let s = 0; s < K; s++) {
      const t = t0 + ((s + 0.5) / K) * (t1 - t0);
      let low: Note | null = null;
      for (const n of active) if (n.start <= t && n.start + n.dur > t && (!low || n.midi < low.midi)) low = n;
      if (!low) continue;
      weight.set(low.midi, (weight.get(low.midi) ?? 0) + 0.5 + low.vel);
      const f = first.get(low.midi);
      if (!f || low.start < f.start) first.set(low.midi, low);
    }
    let bestMidi = -1;
    let bestW = 0;
    for (const [m, w] of weight) if (w > bestW + 1e-9 || (Math.abs(w - bestW) <= 1e-9 && m < bestMidi)) [bestMidi, bestW] = [m, w];
    if (bestMidi < 0) {
      slots.push(null);
      continue;
    }
    const src = first.get(bestMidi)!;
    slots.push({ b, t0, t1, midi: bestMidi, vel: src.vel, onset: src.start });
  }
  const fold = (m: number) => {
    let p = m;
    while (p < EASY_BASS_LOW) p += 12;
    while (p > EASY_BASS_HIGH) p -= 12;
    return p;
  };
  const out: Note[] = [];
  let prevSlot: Slot = null;
  for (const sl of slots) {
    if (!sl) {
      prevSlot = null;
      continue;
    }
    const p = fold(sl.midi);
    const last = out[out.length - 1];
    if (last && prevSlot && last.midi === p) {
      last.dur = sl.t1 - last.start - 0.02;
      prevSlot = sl;
      continue;
    }
    // start on the beat unless the bass note clearly begins later in it
    const start = sl.onset > sl.t0 + (sl.t1 - sl.t0) * 0.4 ? sl.onset : sl.t0;
    if (last && last.start + last.dur > start - 0.01) last.dur = Math.max(0.1, start - last.start - 0.02);
    out.push({ id: newNoteId(), midi: p, start, dur: Math.max(0.15, sl.t1 - start - 0.02), vel: Math.min(1, 0.35 + sl.vel * 0.45), hand: 'L' });
    prevSlot = sl;
  }
  return out;
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
