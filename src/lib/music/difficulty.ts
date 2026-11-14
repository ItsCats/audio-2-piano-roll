/**
 * Generates Easy / Medium / Hard arrangements from the full (cleaned) transcription.
 *
 *  HARD   — the full transcription with both hands, untouched timing (hands only reassigned
 *           where a chord is out of one hand's reach: playability pass).
 *  MEDIUM — the tune on top with up to two supporting chord tones below it in the right hand,
 *           bass plus one consonant chord tone in the left hand, fast passages thinned to a
 *           16th-note grid, light quantisation, then the playability pass.
 *  EASY   — a single-line tune on 8th notes over a sustained left-hand bass line that follows the
 *           lowest sounding note beat by beat.
 *
 * The tune without a singer is the instruments' tune (music/melody.ts instrumentLine): ONE smooth
 * lead line through the right-hand notes, found like the sung line (best path, jumps cost), so
 * the right hand no longer hops between a band's piano chord tops and the lead instrument. Easy
 * plays it on the 8th grid (easySungLine) with isolated octave leaps folded back; Medium strikes
 * each tune note with chord tones below it, keeps chords struck under a held tune note only up
 * to a sixth above it (MEDIUM_TUNE) and drops the chord tops further up.
 *
 * When the transcription carries a sung melody line (notes with role 'melody', from the
 * separated vocal stem), the arrangements are built around it instead:
 *  EASY   right hand = the melody line itself, simplified to 8th notes (one note per 8th: the most
 *         salient / longest; long notes held across 8ths, not re-struck);
 *  MEDIUM right hand = the melody (16th-note grid) plus up to two consonant chord tones BELOW it
 *         taken from the accompaniment; left hand as usual from the accompaniment;
 *  HARD   everything, at the sung pitch.
 * Easy and Medium move the sung line by whole phrases into the right-hand register (median E4–E5,
 * clear of the left hand: music/melody.ts rightHandShifts). Where nobody sings for two bars or more
 * (rap / spoken sections are not in the line, see melody.ts speechSections) the right hand plays
 * the instruments' tune there, as in a song without a singer.
 *
 * Measured (tests/accuracy/inst_eval.py, Easy RH vs the reference tune; old per-onset skyline →
 * tune line; app-run base transcriptions). Raw chroma accuracy (RCA) only credits frames where
 * Easy sounds, so it rises with voicing recall: the tune line's notes are held legato on the 8th
 * grid (easySungLine), and that, not a better choice of notes, is most of its RCA gain (6 MAESTRO
 * pieces 0.395 → 0.451 with voicing recall 0.637 → 0.721). Which notes are chosen, independent of
 * their length: onsetPC (RH onset pitch class vs the reference) / legatoRCA (RCA with both
 * versions' notes held to the next onset):
 *   MAESTRO top voice (6 pieces)          0.600 / 0.546 → 0.636 / 0.563
 *   4 solo piano recordings (PTI top)     0.353 / 0.382 → 0.380 / 0.408 (jazz piece 0.206 / 0.188
 *                                         → 0.198 / 0.172: still slightly worse; Medium 0.124 → 0.108)
 *   band track (band-instrumental-1, lead)   0.584 / 0.479 → 0.580 / 0.477 (flat; confident lead
 *                                         frames legatoRCA 0.553 → 0.551)
 *   instrumental gaps of 4 sung songs     0.470 / 0.314 → 0.426 / 0.273 (114 → 104 scored onsets:
 *                                         flat to slightly worse, not shown better)
 * Smoothness is the clear gain: Easy leaps over an octave 3.3 → 1.4 % (MAESTRO), 6.0 → 0.8 %
 * (band-instrumental-1). Sung sections of vocal songs and Easy LH are unchanged.
 */
import type { Arrangement, Difficulty, Note, PedalRange, TempoInfo } from './types';
import { autoPedal } from './autoPedal';
import { asHeard } from './noteLength';
import { clusterOnsets } from './hands';
import { beatPeriodAt, beatToTime, timeToBeat } from './beats';
import { quantizeNotes } from './quantize';
import { newNoteId, songDuration, sortNotes } from './cleanup';
import { fixOctaveOutliers, instrumentLine, rightHandShifts, tuneCandidates, type TuneOptions } from './melody';
import { enforcePlayability } from './playability';

/**
 * Hand-span pass (music/playability.ts enforcePlayability): no hand holds or strikes notes further
 * apart than it can reach. On Medium, out-of-reach notes move to the other hand when it is free
 * and in range, else the least important ones (inner / doubled) go; on Hard notes are only
 * reassigned to the other hand (every note is kept).
 */
function playable(notes: Note[], level: 'medium' | 'hard'): Note[] {
  return sortNotes(enforcePlayability(notes, level));
}

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

/**
 * Grid refinement for a slow, unreliable tempo estimate: below 84 BPM with confidence < 0.5 the
 * tracker has almost always locked onto every other beat of a faster song (vocal-5:
 * 65 BPM at 0.12 for a ~130 BPM song, vocal-4 73 vs ~145), so Easy's "8ths" would really be
 * quarter notes. Then the grids are taken twice as fine (Easy 16ths of the estimate = 8ths of the
 * song). Confident slow tempos are left alone. Only used for songs with a sung line (piano and
 * instrumental arrangements keep their grids).
 */
export function gridFactor(tempo: TempoInfo): 1 | 2 {
  return tempo.bpm < 84 && tempo.confidence < 0.5 ? 2 : 1;
}

/** Two bars of 4/4 without singing count as an instrumental stretch. */
const MELODY_GAP_BEATS = 8;

/**
 * Stretches of at least `minBeats` beats in which no melody note sounds, shrunk by one beat at
 * each end (so instrumental fills never butt against the sung line). `factor` (gridFactor) is how
 * many real beats one tracked beat spans: on a half-time estimate (factor 2) the threshold and the
 * trim are still counted in real beats, so two real bars without singing are a gap.
 */
export function melodyGaps(melody: Note[], tempo: TempoInfo, duration: number, minBeats = MELODY_GAP_BEATS, factor = 1): [number, number][] {
  const gaps: [number, number][] = [];
  const mel = sortNotes(melody);
  let cursor = 0;
  const push = (a: number, b: number, last: boolean) => {
    const beat = beatPeriodAt(tempo.beats, a, tempo.bpm) / Math.max(1, factor);
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

export interface ArrangementOptions {
  /**
   * The base's hands come from the score (TranscriptionInfo.handsFromScore): Hard is then the
   * part exactly as written, without the hand-span pass (that pass is for transcriptions, whose
   * hands are guessed).
   */
  handsFromScore?: boolean;
  /**
   * Song made from audio with the automatic pedal on (Song.autoPedal): Medium and Hard get
   * sustain pedal derived from their notes (music/autoPedal.ts) instead of `basePedal`.
   */
  autoPedal?: boolean;
  /**
   * The base is "as played", with `basePedal` carrying the sound (Song.noteLength 'played', the
   * high-accuracy piano model): Easy has no pedal, so it is built from the notes as they ring under
   * that pedal (music/noteLength.ts asHeard), the way it is for every other song. Its tune line and
   * bass then hold their notes instead of re-striking them.
   */
  easyAsHeard?: boolean;
}

export function generateHard(base: Note[], opts: ArrangementOptions = {}): Note[] {
  const notes = sortNotes(base.map((n) => ({ ...n })));
  return opts.handsFromScore ? notes : playable(notes, 'hard');
}

/**
 * The instruments' tune (melody.ts instrumentLine) through the accompaniment notes that start in
 * `ranges` (the instrumental stretches; everywhere for a song without a sung line).
 */
export function tuneLine(accomp: Note[], ranges: [number, number][], opts?: Partial<TuneOptions>): Note[] {
  return instrumentLine(
    tuneCandidates(accomp, opts?.leftMin).filter((n) => inRanges(ranges, n.start)),
    opts,
  );
}

/** The line note sounding at time t (or the nearest one within `reach` s), from a time-sorted monophonic line. */
function lineNoteNear(line: Note[], starts: number[], t: number, reach: number): Note | null {
  let lo = 0;
  let hi = starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  const prev = line[lo - 1];
  if (prev && prev.start + prev.dur > t + 0.03) return prev;
  const next = line[lo];
  const dPrev = prev ? t - (prev.start + prev.dur) : Infinity;
  const dNext = next ? next.start - t : Infinity;
  if (Math.min(dPrev, dNext) > reach) return null;
  return dPrev <= dNext ? prev : next;
}

function chordTones(top: Note, below: Note[], count: number): Note[] {
  return below
    .filter((n) => n.midi < top.midi && top.midi - n.midi <= 12)
    .map((n) => ({ n, s: (CONSONANCE[top.midi - n.midi] ?? 0.2) + n.vel * 0.5 - (n.src === 'piano' ? BLEND_LEVELS.fillChordPenalty : 0) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, count)
    .map((x) => x.n);
}

/**
 * The piano-model blend's fills (Note.src 'piano') in the tune line Easy and Medium follow: 'holes'
 * lets them into it only where the line without them has no note (a run of fills under the tune took
 * the line over: band-instrumental-1 Medium lost two bridge lead notes that way, while keeping them out
 * altogether lost the notes they add between the tune's phrases); 'all' / 'none' for measurements.
 * `fillChordPenalty`: Medium's chord tones under the tune prefer the app's own notes to fills by this
 * much of the chord-tone score (a fill had replaced a bridge lead note). `mediumRestrikes` false: Medium,
 * like Easy, joins re-strike pieces back into one note (withoutRestrikes); with them Medium had 17.9 %
 * more notes per second than without the blend on band-instrumental-1 (limit 15 %), and the Slakh set's
 * Medium lead coverage fell 58.2 -> 57.9 % instead of rising to 59.4 %.
 */
export const BLEND_LEVELS = { fillsInTune: 'holes' as 'all' | 'holes' | 'none', fillChordPenalty: 0.3, mediumRestrikes: false };
const withoutFills = (notes: Note[]) => notes.filter((n) => n.src !== 'piano');

/** tuneLine with the blend's fills as BLEND_LEVELS.fillsInTune says. */
export function blendTuneLine(accomp: Note[], ranges: [number, number][]): Note[] {
  const mode = BLEND_LEVELS.fillsInTune;
  if (mode === 'all' || !accomp.some((n) => n.src === 'piano')) return tuneLine(accomp, ranges);
  const own = tuneLine(withoutFills(accomp), ranges);
  if (mode === 'none') return own;
  const ownIdx = sortNotes(own);
  const free = (n: Note) => !ownIdx.some((m) => m.start < n.start + n.dur - 0.03 && n.start < m.start + m.dur - 0.03);
  const added = tuneLine(accomp, ranges).filter((n) => n.src === 'piano' && free(n));
  return added.length ? sortNotes([...own, ...added]) : own;
}

/**
 * Medium right hand in instrumental stretches: a chord struck under a held tune note keeps its
 * tones below the tune and those at most `keepAbove` semitones above it (a melody note the line
 * reduction skipped, an ornament); chord tops further above (another instrument's register, the
 * hopping skyline) are dropped. `reach` (s): how far from a tune note a chord still counts as
 * under it. `blendFills`: the piano-model blend's fills (Note.src 'piano') Medium keeps: 'tune' only
 * those its tune line picks (BLEND_LEVELS), 'withApp' also those struck with an app note of their hand
 * (chord tones), 'all' every one. 'withApp' (re-strikes joined back): band-instrumental-1 Medium lead
 * recall 52.3 % with 'tune' -> 54.5 %, notes per second +14 % over the song without the blend (limit 15 %).
 */
export const MEDIUM_TUNE = { keepAbove: 9, reach: 0.5, blendFills: 'withApp' as 'all' | 'tune' | 'withApp' };

/**
 * Re-strike pieces (Note.src 'restrike', music/pianoBlend.ts blendRestrikes) joined back into the note
 * they were split from (Easy, and Medium unless BLEND_LEVELS.mediumRestrikes): Easy's 8th-grid tune
 * dropped the short second piece, which left a hole where the held note sounded.
 */
export function withoutRestrikes(notes: Note[]): Note[] {
  if (!notes.some((n) => n.src === 'restrike')) return notes;
  const out: Note[] = [];
  const lastOf = new Map<number, Note>();
  for (const n of [...notes].sort((a, b) => a.start - b.start)) {
    const prev = lastOf.get(n.midi);
    if (n.src === 'restrike' && prev && n.start - (prev.start + prev.dur) <= 0.02) {
      prev.dur = n.start + n.dur - prev.start;
      continue;
    }
    const c = { ...n };
    out.push(c);
    lastOf.set(n.midi, c);
  }
  return out;
}

/** Easy and Medium are built without Hard-only notes (role 'lead', see Note.role). */
export function withoutHardOnly(notes: Note[]): Note[] {
  return notes.some((n) => n.role === 'lead') ? notes.filter((n) => n.role !== 'lead') : notes;
}

export function generateMedium(allNotes: Note[], tempo: TempoInfo): Note[] {
  const base = BLEND_LEVELS.mediumRestrikes ? withoutHardOnly(allNotes) : withoutRestrikes(withoutHardOnly(allNotes));
  const melody = base.filter((n) => n.role === 'melody');
  const fine = melody.length ? gridFactor(tempo) : 1;
  const accomp = melody.length ? base.filter((n) => n.role !== 'melody') : base;
  const clusters = clusterOnsets(accomp, 0.04);
  // with a sung line the right hand follows it; the accompaniment's right hand only fills long
  // instrumental stretches, where its top voice follows the instruments' tune
  const gaps = melody.length ? melodyGaps(melody, tempo, songDuration(base), MELODY_GAP_BEATS, fine) : [[-Infinity, Infinity] as [number, number]];
  const tune = blendTuneLine(accomp, gaps);
  const tuneIds = new Set(tune.map((n) => n.id));
  const tuneStarts = tune.map((n) => n.start);
  // the piano-model blend's fills (Note.src): 'tune' keeps only those the tune line picks; 'withApp'
  // also those struck with an app note of the same hand (chord tones), not fills on their own
  const fillMode = MEDIUM_TUNE.blendFills;
  const isFill = (n: Note) => n.src === 'piano' && !tuneIds.has(n.id);
  const rh: Note[][] = [];
  const lh: Note[][] = [];
  // groups whose first note is a line note (the tune or the sung melody): kept when thinning
  const lineGroups = new Set<Note[]>();
  for (const c0 of clusters) {
    const c =
      fillMode === 'all' || !c0.some(isFill)
        ? c0
        : c0.filter((n) => !isFill(n) || (fillMode === 'withApp' && c0.some((m) => m.hand === n.hand && m.src !== 'piano')));
    if (!c.length) continue;
    const r = c.filter((n) => n.hand === 'R' && !tuneIds.has(n.id)).sort((a, b) => b.midi - a.midi);
    const l = c.filter((n) => n.hand === 'L' && !tuneIds.has(n.id)).sort((a, b) => a.midi - b.midi);
    if (inRanges(gaps, c[0].start)) {
      const own = c.find((n) => tuneIds.has(n.id));
      const count = r.length + (own ? 1 : 0) >= 4 ? 2 : 1;
      if (own) {
        // the tune note on top, chord tones below it
        const top = { ...own, hand: 'R' as const };
        const g = [top, ...chordTones(top, r, count)];
        lineGroups.add(g);
        rh.push(g);
      } else if (r.length) {
        // chord under a held tune note: only the tones below it (the tops above it were the
        // hopping skyline); far from any tune note: as before, top + support
        const ref = lineNoteNear(tune, tuneStarts, c[0].start, MEDIUM_TUNE.reach);
        const top = ref ? r.find((n) => n.midi - ref.midi <= MEDIUM_TUNE.keepAbove) : r[0];
        if (top) {
          const g = !ref || top.midi > ref.midi ? [top, ...chordTones(top, r.filter((n) => n !== top), count)] : chordTones(ref, r, count);
          if (g.length) rh.push(g);
        }
      }
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
  const sungGroups = new Set<Note[]>(melody.length ? placeSungGroups(melodyWithChordTones(melody, accomp, 2), accomp.filter((n) => n.hand === 'L')) : []);
  for (const g of sungGroups) lineGroups.add(g);
  rh.push(...sungGroups);
  rh.sort((a, b) => a[0].start - b[0].start);
  const thin = (groups: Note[][], divisions: number): Note[] => {
    const kept: Note[][] = [];
    for (const g of groups) {
      const prev = kept[kept.length - 1];
      const minGap = (beatPeriodAt(tempo.beats, g[0].start, tempo.bpm) / divisions) * 0.85;
      if (prev && g[0].start - prev[0].start < minGap) {
        const strength = (x: Note[]) => Math.max(...x.map((n) => n.vel)) + x[0].midi / 400;
        const gLine = lineGroups.has(g);
        const pLine = lineGroups.has(prev);
        // a line note is never dropped for a chord without one
        if ((gLine && !pLine) || (gLine === pLine && strength(g) > strength(prev) + 0.15)) kept[kept.length - 1] = g;
        continue;
      }
      kept.push(g);
    }
    return kept.flat();
  };
  const sungNotes = new Set<Note>([...sungGroups].flat());
  const rhKept = thin(rh, 4 * fine);
  const keepEnd = rhKept.map((n) => sungNotes.has(n));
  const notes = [...rhKept, ...thin(lh, 2 * fine)].map((n) => ({ ...n, id: newNoteId() }));
  const q = quantizeNotes(notes, tempo, {
    subdivision: 4 * fine,
    strength: quantStrength(tempo),
    quantizeDurations: false,
    window: 0.45,
    // triplet passages (shuffle, 12/8 ballads) stay triplets instead of becoming 16th rhythms
    triplets: true,
  });
  // a sung line (and the chord tones struck with it) keeps its note ends
  for (let i = 0; i < keepEnd.length; i++) if (keepEnd[i]) q[i] = { ...q[i], dur: Math.max(0.06, notes[i].start + notes[i].dur - q[i].start) };
  return playable(fixSamePitchOverlaps(q), 'medium');
}

/**
 * Medium: moves each melody group (melody note first, then its chord tones) by its phrase's
 * right-hand shift (rightHandShifts against the accompaniment's left hand); chord tones that would
 * then reach down to within 2 semitones of the left hand's top note at that moment are dropped.
 */
export function placeSungGroups(groups: Note[][], left: Note[]): Note[][] {
  const shifts = rightHandShifts(groups.map((g) => g[0]), left);
  const lh = sortNotes(left);
  const lhTopAt = (t: number) => {
    let top = -Infinity;
    for (const l of lh) {
      if (l.start > t + 0.03) break;
      if (l.start + l.dur > t) top = Math.max(top, l.midi);
    }
    return top;
  };
  return groups.map((g) => {
    const s = shifts.get(g[0]) ?? 0;
    const m = { ...g[0], midi: Math.min(108, g[0].midi + s) };
    if (!s) return [m, ...g.slice(1)];
    const floor = lhTopAt(m.start) + 2;
    return [m, ...g.slice(1).map((c) => ({ ...c, midi: c.midi + s })).filter((c) => c.midi > floor && c.midi <= 108)];
  });
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

/**
 * Easy right hand from a sung line: one note per 8th-note slot (the most salient / longest; it
 * covers the notes it replaced, legato), starts and ends on the 8th grid, so long notes are held
 * across 8ths instead of re-struck. `div` = grid divisions per beat (2, or 4 for a half-time tempo
 * estimate, see gridFactor). Very short quiet notes (ornaments, scoops) are dropped first.
 */
export function easySungLine(sung: Note[], tempo: TempoInfo, div = 2): Note[] {
  if (!sung.length) return [];
  const medVel = median(sung.map((n) => n.vel));
  const cands = sortNotes(sung).filter((n) => {
    const slotLen = beatPeriodAt(tempo.beats, n.start, tempo.bpm) / div;
    return !(n.dur < slotLen * 0.4 && n.vel < medVel * 0.85);
  });
  const bySlot = new Map<number, Note>();
  const slotEnd = new Map<number, number>();
  const score = (x: Note) => x.vel + Math.min(x.dur, 1) * 0.4;
  for (const n of cands) {
    const slot = Math.round(timeToBeat(tempo.beats, n.start, tempo.bpm) * div);
    const prev = bySlot.get(slot);
    if (!prev || score(n) > score(prev)) bySlot.set(slot, n);
    slotEnd.set(slot, Math.max(slotEnd.get(slot) ?? 0, n.start + n.dur));
  }
  const kept = [...bySlot.entries()]
    .sort((x, y) => x[1].start - y[1].start)
    .map(([slot, n]) => ({ ...n, dur: Math.max(n.dur, slotEnd.get(slot)! - n.start), hand: 'R' as const }));
  const q = quantizeNotes(kept, tempo, { subdivision: div, strength: quantStrength(tempo), quantizeDurations: true, window: 0.5 });
  // monophonic: a note ends where the next one starts
  const out: Note[] = [];
  for (const n of q.sort((x, y) => x.start - y.start)) {
    const prev = out[out.length - 1];
    if (prev && n.start - prev.start < 0.02) continue;
    if (prev) prev.dur = Math.max(0.06, Math.min(prev.dur, n.start - prev.start - 0.01));
    out.push({ ...n });
  }
  return out;
}

/** Easy tune notes this many semitones or more from the local median move by an octave (fixOctaveOutliers). */
export const EASY_TUNE = { octaveFix: 9 };

export function generateEasy(allNotes: Note[], tempo: TempoInfo, duration: number): Note[] {
  const base = withoutRestrikes(withoutHardOnly(allNotes));
  if (!base.length) return [];
  const sung = base.filter((n) => n.role === 'melody');
  const div = 2 * (sung.length ? gridFactor(tempo) : 1);
  const accomp = sung.length ? base.filter((n) => n.role !== 'melody') : base;
  // left hand first: the sung line is placed clear above it
  const lhNotes = easyBassLine(accomp.filter((n) => n.hand === 'L'), tempo, duration);

  // 1) instruments' tune (one smooth lead line, melody.ts instrumentLine) in long instrumental
  //    stretches of a song with singing (intro, interludes, solos, rap), else everywhere; on the
  //    8th grid like the sung line
  const gaps = sung.length ? melodyGaps(sung, tempo, duration, MELODY_GAP_BEATS, gridFactor(tempo)) : [[-Infinity, Infinity] as [number, number]];
  // isolated octave leaps are moved back into the line (a beginner's hand stays in one place)
  let tune = fixOctaveOutliers(easySungLine(blendTuneLine(accomp, gaps), tempo, div), 3, EASY_TUNE.octaveFix);
  // comfortable register: only an implausibly high / low line moves (by octaves, as a whole)
  const med = median(tune.map((n) => n.midi));
  const globalShift = med > 84 ? -12 * Math.ceil((med - 79) / 12) : med < 60 ? 12 * Math.ceil((60 - med) / 12) : 0;
  tune = tune.map((n) => ({ ...n, midi: Math.max(21, Math.min(108, n.midi + globalShift)) }));
  const qOpts = { subdivision: div, strength: quantStrength(tempo), quantizeDurations: false, window: 0.5 };
  const tuneQ = tune.map((n) => ({ ...n, id: newNoteId(), vel: Math.min(1, 0.45 + n.vel * 0.45) }));

  // 2) the sung line on the 8th grid, moved by whole phrases into the right-hand register
  const sungLine = easySungLine(sung, tempo, div);
  const shifts = rightHandShifts(sungLine, lhNotes);
  const sungRh = sungLine.map((n) => ({
    ...n,
    id: newNoteId(),
    midi: Math.min(108, n.midi + (shifts.get(n) ?? 0)),
    vel: Math.min(1, 0.45 + n.vel * 0.45),
  }));

  // 3) one right-hand line (quantising can pull notes together: keep the first per slot)
  const line: Note[] = [];
  for (const n of [...sungRh, ...tuneQ].sort((a, b) => a.start - b.start || b.midi - a.midi)) {
    const prev = line[line.length - 1];
    if (prev && n.start - prev.start < 0.02) continue;
    if (prev) prev.dur = Math.max(0.06, Math.min(prev.dur, n.start - prev.start - 0.01));
    line.push(n);
  }
  // keep the left hand below the melody
  const melodyAt = [...tune, ...sungRh];
  for (const l of lhNotes) {
    const over = melodyAt.find((m) => m.start <= l.start + 0.05 && m.start + m.dur > l.start && m.midi - l.midi < 4);
    if (over && l.midi - 12 >= 36) l.midi -= 12;
  }
  return fixSamePitchOverlaps([...line, ...quantizeNotes(lhNotes, tempo, qOpts)]);
}

/** Easy left-hand register (pitch classes are kept, octaves folded into it). */
const EASY_BASS_LOW = 43; // G2
const EASY_BASS_HIGH = 57; // A3

/** Easy left hand follows the bass line (role 'bass') where it sounds (see easyBassLine). */
export const EASY_BASS = { followBassLine: true };

export interface EasyBassOptions {
  /** Analysis slot length in beats (default: 1, or ½ at slow tempos where a beat lasts ≥ 0.75 s). */
  slotBeats: number;
}

/**
 * Easy left hand: follows the lowest sounding left-hand note slot by slot (a beat, or half a
 * beat at slow tempos). Each slot is sampled at several points; the pitch that is the lowest
 * sounding note for most of the slot (weighted by velocity) wins. Consecutive slots with the
 * same pitch become one sustained note (pumping 8ths on one bass note → one held note);
 * octaves are folded into G2–A3, pitch classes are kept. Silent slots stay silent. Where the
 * separated bass stem's line (role 'bass') sounds, it is the sampled note: the lowest left-hand
 * note there is often another instrument's (on the first 10 Slakh band tracks, 136 of the 204
 * Easy bass notes at a wrong pitch class were picked while the bass line sounded).
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
      // the bass line (role 'bass', separated band songs) where it sounds, else the lowest note
      let low: Note | null = null;
      let bass: Note | null = null;
      for (const n of active) {
        if (!(n.start <= t && n.start + n.dur > t)) continue;
        if (!low || n.midi < low.midi) low = n;
        if (n.role === 'bass' && (!bass || n.midi < bass.midi)) bass = n;
      }
      if (bass && EASY_BASS.followBassLine) low = bass;
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

/** Notes cut at `duration` (s); notes starting at or after it are dropped. */
export function clampToDuration(notes: Note[], duration: number): Note[] {
  return notes
    .filter((n) => n.start < duration)
    .map((n) => (n.start + n.dur > duration ? { ...n, dur: Math.max(0.03, duration - n.start) } : n));
}

export function generateArrangement(
  difficulty: Difficulty,
  base: Note[],
  basePedal: PedalRange[],
  tempo: TempoInfo,
  duration: number,
  opts: ArrangementOptions = {},
): Arrangement {
  const generated =
    difficulty === 'hard'
      ? generateHard(base, opts)
      : difficulty === 'medium'
        ? generateMedium(base, tempo)
        : generateEasy(opts.easyAsHeard ? asHeard(base, basePedal) : base, tempo, duration);
  // no note sounds past the end of the audio (Easy's bass slots and minimum lengths could reach past it)
  const notes = duration > 0 ? clampToDuration(generated, duration) : generated;
  return {
    notes,
    pedal: difficulty === 'easy' ? [] : opts.autoPedal ? autoPedal(notes, tempo, duration > 0 ? duration : Infinity) : basePedal.map((p) => ({ ...p })),
    edited: false,
    generatedAt: Date.now(),
  };
}

export function generateAllArrangements(
  base: Note[],
  basePedal: PedalRange[],
  tempo: TempoInfo,
  duration: number,
  opts: ArrangementOptions = {},
): Record<Difficulty, Arrangement> {
  return {
    easy: generateArrangement('easy', base, basePedal, tempo, duration, opts),
    medium: generateArrangement('medium', base, basePedal, tempo, duration, opts),
    hard: generateArrangement('hard', base, basePedal, tempo, duration, opts),
  };
}
