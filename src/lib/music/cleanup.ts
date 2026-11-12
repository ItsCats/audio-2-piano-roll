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

/**
 * Ghost notes in near-silence. Basic Pitch level-normalises each 2 s model window internally, so
 * a window that holds only a reverb tail, a fade or a separated stem's noise floor is scaled up to
 * full range and the model "hears" notes in it: at the end of a song they start on window
 * boundaries (k x 1.640 s) while the audio only keeps decaying (band-instrumental-1: C3+C6 at
 * -35 dB just after the final cut, then notes at -65..-75 dB; with separation a low F held
 * through digital silence). Velocity cannot catch them: it has a level-independent floor.
 *
 * Levels are a note's onset loudness (the RMS envelope around its start, as for its velocity) in
 * dB re the song's loudness reference (95th percentile of the envelope); `rise` is the level rise
 * at the onset (max over the next `riseAfter` envelope frames / min over the `riseBefore` frames
 * before: a played note raises the level a little, a re-normalised tail does not). A note is
 * dropped when
 *   - it starts more than `floorDb` below the reference anywhere (inaudible next to the song), or
 *   - it starts in the song's tail (after the last envelope frame within `loudDb` of the reference,
 *     when that stretch is at most `maxTailSec` long) and is more than `quietDb` below the
 *     reference, or more than `flatDb` below it with a rise under `minRise`.
 * The tail limit keeps the gate away from soft sections and quiet endings: on the exact MIDI
 * onsets of 6 MAESTRO pieces with the first or the second half made 10-20 dB quieter (a soft
 * section / a soft ending; tests: band/r4/gate_ref4.py, offline), it removes at most 1 real note
 * per piece (the earlier single -35 dB / -30 dB-flat rule everywhere removed up to 430). Real
 * songs, offline on stored posteriors: it still removes every note after the final cut of
 * band-instrumental-1 (4 full mix, 6 separated) and the end-of-file ghosts of vocal-2 / vocal-5;
 * in vocal-1's fade-out (the last ~6 s) it removes 6 of the 20 notes (the earlier rule 11), the
 * flat or below -40 dB ones; nothing before the tails, and no MAESTRO reference note.
 */
export interface TailGateRule {
  enabled: boolean;
  floorDb: number;
  loudDb: number;
  maxTailSec: number;
  quietDb: number;
  flatDb: number;
  minRise: number;
  /** envelope frames (100 fps) after / before the onset for the rise test */
  riseAfter: number;
  riseBefore: number;
}

export const TAIL_GATE: TailGateRule = { enabled: true, floorDb: -50, loudDb: -25, maxTailSec: 10, quietDb: -40, flatDb: -30, minRise: 1.25, riseAfter: 6, riseBefore: 8 };

/** Envelope frames per second of the RMS envelope the gate reads (transcription/decode.ts rmsEnvelope). */
const ENV_FPS = 100;

/**
 * Where the song's tail starts (s): after the last envelope frame within `loudDb` of `ref`, when
 * the stretch from there to the end is at most `maxTailSec` long; Infinity otherwise (no tail).
 */
export function tailStart(rms: ArrayLike<number>, ref: number, rule: TailGateRule = TAIL_GATE): number {
  const n = rms.length;
  if (!n || !(ref > 0)) return Infinity;
  const loud = ref * 10 ** (rule.loudDb / 20);
  let last = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (rms[i] >= loud) {
      last = i;
      break;
    }
  }
  if (last < 0) return Infinity;
  const t = last / ENV_FPS;
  return n / ENV_FPS - t <= rule.maxTailSec ? t : Infinity;
}

/** Onset loudness (dB re `ref`) and level rise of a note starting at `start` s, from a 100 fps RMS envelope. */
export function onsetLevel(rms: ArrayLike<number>, ref: number, start: number, rule: TailGateRule = TAIL_GATE): { db: number; rise: number } {
  const n = rms.length;
  if (!n || !(ref > 0)) return { db: 0, rise: Infinity };
  const ri = Math.min(n - 1, Math.round(start * ENV_FPS) + 3);
  let loud = 0;
  for (let i = Math.max(0, ri - 3); i <= Math.min(n - 1, ri + 3); i++) loud = Math.max(loud, rms[i]);
  const a = Math.min(n - 1, Math.max(0, Math.round(start * ENV_FPS)));
  let pre = Infinity;
  for (let i = Math.max(0, a - rule.riseBefore); i <= a - 2; i++) pre = Math.min(pre, rms[i]);
  if (!Number.isFinite(pre)) pre = 0;
  let post = 0;
  for (let i = a; i < Math.min(n, a + rule.riseAfter); i++) post = Math.max(post, rms[i]);
  return { db: 20 * Math.log10(Math.max(loud, 1e-12) / ref), rise: post / Math.max(pre, 1e-12) };
}

/** Whether a note at this onset level is a ghost in near-silence (TailGateRule); `inTail`: it starts in the song's tail (tailStart). */
export function isTailGhost(level: { db: number; rise: number }, inTail: boolean, rule: TailGateRule = TAIL_GATE): boolean {
  if (level.db < rule.floorDb) return true;
  return inTail && (level.db < rule.quietDb || (level.db < rule.flatDb && level.rise < rule.minRise));
}

/** Notes minus the ghosts in near-silence (TailGateRule), given the song's RMS envelope and loudness reference. */
export function removeTailGhosts<T extends { start: number }>(notes: T[], rms: ArrayLike<number>, ref: number, rule: TailGateRule = TAIL_GATE): T[] {
  if (!rule.enabled || !rms.length || !(ref > 0)) return notes;
  const t0 = tailStart(rms, ref, rule);
  return notes.filter((n) => !isTailGhost(onsetLevel(rms, ref, n.start, rule), n.start >= t0, rule));
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
