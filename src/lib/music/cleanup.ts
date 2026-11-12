/** Post-processing of raw transcribed notes into a cleaner, playable note list. */
import type { Note } from './types';

let nextId = 1;
export const newNoteId = (): number => nextId++;
/** Ensure freshly generated ids never collide with ids loaded from storage. */
export function bumpNoteIds(notes: Note[]): void {
  for (const n of notes) if (n.id >= nextId) nextId = n.id + 1;
}

/**
 * Re-strike detection for the same-pitch merges below. The merges fold a note into the previous
 * note of the same pitch when its model onset is weak, which is right for a ringing string that the
 * model re-detects, but Basic Pitch's onset posterior for a genuinely re-struck note is often just
 * as weak, above all in the bass (a re-struck bass string is still ringing, and its attack is
 * spread over a long low-frequency waveform): the merges folded away 10-20 % of the real repeated
 * notes in C2-B2. What does separate the two is the FRAME posterior: a re-strike makes the
 * pitch's frame activation rise again (dip just before the new start, peak just after), a
 * re-detection of a ringing string does not (MAESTRO, C2-B2: rise median 0.17-0.19 for real
 * repeated notes vs 0.02-0.06 for the events correctly folded away).
 *
 * `rise` maps a note id to that frame-activation rise at its start (see frameRise() in
 * transcription/pipeline.ts); a note whose rise reaches `minRise(midi)`, and whose predecessor
 * began at least `minPrevDur` earlier, is never merged. The threshold ramps from `lowRise` at
 * and below `bottomMidi` to `highRise` at and above `lowMidi`.
 *
 * The test is applied only for presets with a strict continuation fold (continuationOnset >=
 * `minContinuation`: "piano", "mix"); with a permissive one ("sensitive", 0.5) the fold rarely
 * swallows a real re-strike and the test only added false splits.
 *
 * Tuned on MAESTRO exact MIDI (tests/accuracy/sweep_extraction.mjs, onset F1 @50 ms, 5 pieces +
 * Liszt held out), "piano": mean F1 +0.0023 (Liszt +0.003), no piece worse, C2-B2 recall
 * .668 -> .698 at precision .926 -> .929; synthetic e2e Bach .936 -> .937. A lower threshold above
 * C3 (0.2) gained +0.004 on MAESTRO but cost the e2e Bach gate 0.003; "sensitive" never gained.
 */
export interface RestrikeRule {
  lowMidi: number;
  bottomMidi: number;
  lowRise: number;
  highRise: number;
  /** the note before must have lasted this long (s): a short fragment followed by a rise is the model's early, unstable start of one note */
  minPrevDur: number;
  /** apply only when the preset's continuationOnset is at least this */
  minContinuation: number;
}

export const RESTRIKE: RestrikeRule = { lowMidi: 48, bottomMidi: 36, lowRise: 0.15, highRise: 0.25, minPrevDur: 0.2, minContinuation: 0.6 };

/** Frame-posterior rise at which a note of this pitch counts as re-struck. */
export function minRise(midi: number, rule: RestrikeRule = RESTRIKE): number {
  if (midi >= rule.lowMidi) return rule.highRise;
  if (midi <= rule.bottomMidi) return rule.lowRise;
  if (!Number.isFinite(rule.lowRise) || !Number.isFinite(rule.highRise)) return rule.lowRise;
  const f = (rule.lowMidi - midi) / Math.max(1, rule.lowMidi - rule.bottomMidi);
  return rule.highRise + (rule.lowRise - rule.highRise) * f;
}

export interface MergeOptions {
  /** frame-posterior rise at each note's start (by note id); without it no rise test is made */
  rise?: Map<number, number>;
  rule?: RestrikeRule;
}

function restruck(n: Note, prev: Note | undefined, opts: MergeOptions | undefined): boolean {
  const r = opts?.rise?.get(n.id);
  if (r === undefined) return false;
  const rule = opts?.rule ?? RESTRIKE;
  return r >= minRise(n.midi, rule) && (!prev || n.start - prev.start >= rule.minPrevDur);
}

/**
 * Merge same-pitch fragments separated by tiny gaps (model activation dips). A fragment with a
 * strong model onset (> 0.6) or a re-strike rise (MergeOptions) is a new note and is kept apart.
 */
export function mergeFragments(notes: Note[], maxGap = 0.03, onsetStrength?: Map<number, number>, opts?: MergeOptions): Note[] {
  const byPitch = new Map<number, Note[]>();
  for (const n of notes) {
    const arr = byPitch.get(n.midi);
    if (arr) arr.push({ ...n });
    else byPitch.set(n.midi, [{ ...n }]);
  }
  const out: Note[] = [];
  for (const arr of byPitch.values()) {
    arr.sort((a, b) => a.start - b.start);
    let cur = arr[0];
    for (let i = 1; i < arr.length; i++) {
      const n = arr[i];
      const gap = n.start - (cur.start + cur.dur);
      const strongOnset = (onsetStrength ? (onsetStrength.get(n.id) ?? 1) > 0.6 : false) || restruck(n, cur, opts);
      if (gap < maxGap && !strongOnset) {
        cur.dur = Math.max(cur.dur, n.start + n.dur - cur.start);
        cur.vel = Math.max(cur.vel, n.vel * 0.9);
      } else if (gap < 0) {
        // overlapping re-strike: end the previous note where the new one begins
        cur.dur = Math.max(0.02, n.start - cur.start);
        out.push(cur);
        cur = n;
      } else {
        out.push(cur);
        cur = n;
      }
    }
    out.push(cur);
  }
  return out.sort((a, b) => a.start - b.start || a.midi - b.midi);
}

/**
 * A same-pitch note with a weak model onset that begins while (or just after) an earlier
 * note of that pitch is still ringing is not a new hammer strike — it is the same string
 * resonating (sustain pedal, reverb, beating). Fold it into the earlier note — unless its frame
 * activation rises again like a re-strike (MergeOptions).
 */
export function mergeContinuations(notes: Note[], onsetStrength: Map<number, number>, maxOnset: number, maxGap = 0.3, opts?: MergeOptions): Note[] {
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const lastByPitch = new Map<number, Note>();
  const out: Note[] = [];
  for (const n of sorted) {
    const prev = lastByPitch.get(n.midi);
    const weak = (onsetStrength.get(n.id) ?? 1) < maxOnset && !restruck(n, prev, opts);
    if (prev && weak && n.start - (prev.start + prev.dur) < maxGap) {
      prev.dur = Math.max(prev.dur, n.start + n.dur - prev.start);
      continue;
    }
    const copy = { ...n };
    lastByPitch.set(n.midi, copy);
    out.push(copy);
  }
  return out;
}

/**
 * False low notes from drum hits. SCNet's drum-less accompaniment still carries some of each kick
 * and tom (separation leakage), and Basic Pitch hears a short low "note" in it. A low note is
 * dropped when ALL of these hold:
 *  - it lies below `maxMidi` and starts on a strong drum hit: the drums stem's onset strength
 *    within ±`window` s of its start reaches `minHit` (8-bit scale of separation/dsp.ts
 *    drumOnsetEnvelope; a typical kick/snare peaks at 40-60);
 *  - it is short (< `maxDur` s) and its model onset is weak (< `maxOnset`): a plucked or struck
 *    bass note on the beat has a confident onset and usually rings on;
 *  - it is not clearly a sustained pitched note: its mean frame activation stays below `maxMean`,
 *    or the neighbouring semitones are lit almost as much as its own pitch at the start
 *    (spread >= `minSpread`: a broadband thump rather than a pitch);
 *  - it does not continue the bass line: the lowest other note sounding just before it and just
 *    after it (below `contextMaxMidi`, `contextGap` s away) are of another pitch class.
 * Without frame evidence (no posteriors) only the first two tests are made.
 *
 * OFF by default (`enabled`): measured on the 6 band songs separated in the browser (SCNet stems
 * + this envelope, tests/accuracy evaluate.py metrics), these thresholds cut
 * suspectDrumLowNotesPerMin only 15.1 -> 14.0 ("mix") / 13.4 -> 12.8 ("piano") while bass raw
 * chroma accuracy fell 0.0006 / 0.0013; stricter thresholds that keep the bass line intact
 * (minHit 50, maxOnset 0.55, maxMean 0.4) remove ~1 % of the suspects. The low notes left in
 * SCNet's drum-less accompaniment on drum hits are mostly pitched (a rising frame activation at
 * one pitch; the drums stem holds < 5 % of the energy at that pitch) and are not separable from
 * real on-beat bass notes by these features: leave-one-song-out, the best rule removed more
 * bass-line notes than suspects for "piano".
 */
export interface DrumHitRule {
  enabled: boolean;
  maxMidi: number;
  window: number;
  minHit: number;
  maxDur: number;
  maxOnset: number;
  maxMean: number;
  minSpread: number;
  contextMaxMidi: number;
  contextGap: number;
}

export const DRUM_HIT_RULE: DrumHitRule = {
  enabled: false,
  maxMidi: 48,
  window: 0.02,
  minHit: 40,
  maxDur: 0.3,
  maxOnset: 0.6,
  maxMean: 0.45,
  minSpread: 0.3,
  contextMaxMidi: 55,
  contextGap: 0.06,
};

/** What the model and the drums stem say about one note (see DrumHitRule). */
export interface DrumHitEvidence {
  /** strongest drum onset (8-bit) within ±window of the note's start */
  hit: number;
  /** the note's model onset */
  onset: number;
  /** mean frame activation of the note's pitch over the note */
  mean?: number;
  /** strongest neighbouring-semitone (±1, ±2) activation over the first frames / the note's own */
  spread?: number;
}

export function isDrumHit(n: Note, e: DrumHitEvidence, rule: DrumHitRule = DRUM_HIT_RULE): boolean {
  if (!rule.enabled) return false;
  if (n.midi >= rule.maxMidi || n.dur >= rule.maxDur || e.onset >= rule.maxOnset || e.hit < rule.minHit) return false;
  if (e.mean === undefined || e.spread === undefined) return true;
  return e.mean < rule.maxMean || e.spread >= rule.minSpread;
}

/** Whether the lowest other note sounding at time `t` (below `maxMidi`) has the pitch class of `n`. */
function bottomSharesPitchClass(sorted: Note[], n: Note, t: number, maxMidi: number): boolean {
  let bottom: Note | null = null;
  for (const m of sorted) {
    if (m.start > t) break;
    if (m === n || m.midi >= maxMidi || m.start + m.dur < t) continue;
    if (!bottom || m.midi < bottom.midi) bottom = m;
  }
  return !!bottom && (((bottom.midi - n.midi) % 12) + 12) % 12 === 0;
}

/** Drop probable drum-hit notes (DrumHitRule); `evidence` is asked only for candidate low, short notes. */
export function suppressDrumHits(
  notes: Note[],
  evidence: (n: Note) => DrumHitEvidence,
  rule: DrumHitRule = DRUM_HIT_RULE,
): Note[] {
  if (!rule.enabled) return notes;
  const context = notes.filter((n) => n.midi < rule.contextMaxMidi).sort((a, b) => a.start - b.start);
  return notes.filter((n) => {
    if (n.midi >= rule.maxMidi || n.dur >= rule.maxDur || !isDrumHit(n, evidence(n), rule)) return true;
    // a note that continues the bass line's pitch class (repeated or octave-jumping bass) stays
    return (
      bottomSharesPitchClass(context, n, n.start - rule.contextGap, rule.contextMaxMidi) ||
      bottomSharesPitchClass(context, n, n.start + n.dur + rule.contextGap, rule.contextMaxMidi)
    );
  });
}

/**
 * Remove probable overtone "ghost" notes: a quieter note starting together with a louder
 * note an octave, twelfth or two octaves below, and not outlasting it. Real doubled
 * octaves on a piano are usually played at similar loudness, so they survive.
 */
export function suppressHarmonics(notes: Note[], amplitude: Map<number, number>): Note[] {
  const intervals = [12, 19, 24, 28];
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const removed = new Set<number>();
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i];
    const ampN = amplitude.get(n.id) ?? n.vel;
    for (let j = i - 1; j >= 0 && n.start - sorted[j].start < 0.06; j--) check(sorted[j]);
    for (let j = i + 1; j < sorted.length && sorted[j].start - n.start < 0.06; j++) check(sorted[j]);
    function check(m: Note) {
      if (removed.has(m.id) || removed.has(n.id)) return;
      const iv = n.midi - m.midi;
      if (!intervals.includes(iv)) return;
      const ampM = amplitude.get(m.id) ?? m.vel;
      const ratio = iv === 12 ? 0.55 : 0.75;
      if (ampN < ampM * ratio && n.dur <= m.dur * 1.25) removed.add(n.id);
    }
  }
  return notes.filter((n) => !removed.has(n.id));
}

export function removeShortQuiet(notes: Note[], minDur = 0.045, minVel = 0.12): Note[] {
  return notes.filter((n) => n.dur >= minDur && n.vel >= minVel);
}

export function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => a.start - b.start || a.midi - b.midi);
}

export function songDuration(notes: Note[]): number {
  let end = 0;
  for (const n of notes) end = Math.max(end, n.start + n.dur);
  return end;
}
