/**
 * Automatic sustain pedal for songs made from audio (Medium and Hard).
 *
 * Note detection from recordings gives weak note ends, so played back as detected the right hand
 * sounds choppy. A pianist would join the notes with the sustain pedal, changing it with the
 * harmony. This does the same from the arrangement's notes:
 *  - the pedal goes down just after each harmony change (legato pedalling) and comes up ~40 ms
 *    before the next one;
 *  - a pedal is held at most ~4 s (then it is changed at the next chord);
 *  - it never carries across a rest (a stretch where no key is held);
 *  - where it would make two notes a semitone apart ring together (a clash the detected notes do
 *    not have), it is changed at the second note instead.
 * Only the sound (and MIDI / video exports) changes; the falling notes stay as they are.
 */
import type { Note, PedalRange, TempoInfo } from './types';

export const AUTO_PEDAL = {
  /** pedal down this long after the chord's attack */
  downDelay: 0.05,
  /** pedal up this long before the next change */
  upLead: 0.04,
  /** longest single pedal */
  maxHold: 4,
  /** onsets this close together are one chord */
  chordWindow: 0.05,
  /** shortest pedal worth keeping */
  minLength: 0.15,
} as const;

/** A gap with no key held at least this long is a rest (one beat, within 0.4-1 s). */
export function restThreshold(tempo?: Pick<TempoInfo, 'bpm'>): number {
  const beat = tempo && tempo.bpm > 0 ? 60 / tempo.bpm : 0.5;
  return Math.min(1, Math.max(0.4, beat));
}

interface Cluster {
  t: number;
  notes: Note[];
}

function clusters(sorted: Note[]): Cluster[] {
  const out: Cluster[] = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n.start - last.t < AUTO_PEDAL.chordWindow) last.notes.push(n);
    else out.push({ t: n.start, notes: [n] });
  }
  return out;
}

/** Times where no key is held for at least `minGap` s: [start of silence, next onset). */
function rests(sorted: Note[], minGap: number): Array<{ from: number; to: number }> {
  const out: Array<{ from: number; to: number }> = [];
  let held = -Infinity;
  for (const n of sorted) {
    if (n.start - held >= minGap && held > -Infinity) out.push({ from: held, to: n.start });
    held = Math.max(held, n.start + n.dur);
  }
  return out;
}

/**
 * Harmony change times: a chord whose low part (left hand, or below middle C when the song has
 * no left hand) brings a pitch class the current harmony does not have. Notes in the first half
 * beat after a change join that harmony (a broken chord in the bass is one harmony). Without any
 * low notes, every chord of two or more notes counts.
 */
function harmonyChanges(cl: Cluster[], tempo?: Pick<TempoInfo, 'bpm'>): number[] {
  const beat = tempo && tempo.bpm > 0 ? 60 / tempo.bpm : 0.5;
  const settle = Math.min(0.6, Math.max(0.25, beat / 2));
  const hasLeft = cl.some((c) => c.notes.some((n) => n.hand === 'L'));
  const low = (n: Note) => (hasLeft ? n.hand === 'L' : n.midi < 60);
  const anyLow = cl.some((c) => c.notes.some(low));
  const out: number[] = [];
  let harmony = new Set<number>();
  let since = -Infinity;
  let heldLow: Note[] = [];
  for (const c of cl) {
    const lows = c.notes.filter(low);
    if (!anyLow) {
      if (c.notes.length >= 2 || !out.length) out.push(c.t);
      continue;
    }
    if (!lows.length) {
      if (!out.length) out.push(c.t); // the song starts with the right hand alone
      continue;
    }
    const pcs = lows.map((n) => n.midi % 12);
    const isNew = pcs.some((p) => !harmony.has(p));
    if (!out.length || (isNew && c.t - since >= settle)) {
      out.push(c.t);
      // low keys still held from before belong to the new harmony too (a held bass note)
      harmony = new Set([...pcs, ...heldLow.filter((n) => n.start + n.dur > c.t + 0.01).map((n) => n.midi % 12)]);
      since = c.t;
    } else for (const p of pcs) harmony.add(p);
    heldLow = [...heldLow.filter((n) => n.start + n.dur > c.t), ...lows];
  }
  return out;
}

/**
 * Two notes a semitone apart that the pedal would make ring together: `a` ends (key up) before
 * `b` starts inside the same pedal. Returns the start of the first such `b`, or null.
 */
function firstClash(notes: Note[], from: number, to: number): number | null {
  const inside = notes.filter((n) => n.start < to && n.start + n.dur > from - 0.001);
  let first: number | null = null;
  for (const b of inside) {
    if (b.start <= from + 0.001 || (first !== null && b.start >= first)) continue;
    for (const a of inside) {
      if (Math.abs(a.midi - b.midi) !== 1) continue;
      const aEnd = a.start + a.dur;
      // a was released before b, but the pedal (down since `from`) still holds it
      if (aEnd <= b.start && aEnd > from - 0.001 && a.start < b.start) {
        first = b.start;
        break;
      }
    }
  }
  return first;
}

/** Sustain pedal ranges for an arrangement made from audio. */
export function autoPedal(notes: Note[], tempo?: Pick<TempoInfo, 'bpm'>, duration = Infinity): PedalRange[] {
  if (!notes.length) return [];
  const sorted = [...notes].sort((a, b) => a.start - b.start || a.midi - b.midi);
  const cl = clusters(sorted);
  const silence = rests(sorted, restThreshold(tempo));
  const changes = new Set(harmonyChanges(cl, tempo));
  // the first chord after a rest always starts a new pedal
  for (const r of silence) changes.add(r.to);
  const onsets = cl.map((c) => c.t);
  const out: PedalRange[] = [];
  let ri = 0;
  let i = 0;
  while (i < onsets.length) {
    const t = onsets[i];
    if (!changes.has(t)) {
      i++;
      continue;
    }
    const start = t + AUTO_PEDAL.downDelay;
    // the next harmony change, or the cap (then the pedal is changed at the next chord after it)
    let j = i + 1;
    while (j < onsets.length && !changes.has(onsets[j]) && onsets[j] - t < AUTO_PEDAL.maxHold) j++;
    const next = j < onsets.length ? onsets[j] : Infinity;
    let end = Math.min(next - AUTO_PEDAL.upLead, start + AUTO_PEDAL.maxHold, duration);
    // never across a rest: up when the last key before it is released
    while (ri < silence.length && silence[ri].to <= t) ri++;
    if (ri < silence.length && silence[ri].from < end) end = Math.min(end, Math.max(silence[ri].from, start));
    // a semitone clash the pedal would cause: change the pedal at the clashing note instead
    const clashNote = end > start ? firstClash(sorted, start, end) : null;
    // the chord the clashing note belongs to
    const clash = clashNote === null ? null : onsets[lastAtOrBefore(onsets, clashNote)];
    if (clash !== null) {
      end = Math.min(end, clash - AUTO_PEDAL.upLead);
      changes.add(clash);
    }
    if (end - start >= AUTO_PEDAL.minLength) out.push({ start: round(start), end: round(end) });
    // continue at the next pedal change: the next harmony change, the chord after the cap, or the clash
    i++;
    while (i < onsets.length && !changes.has(onsets[i])) {
      if (onsets[i] >= t + AUTO_PEDAL.maxHold) changes.add(onsets[i]);
      else i++;
    }
  }
  return out;
}

function lastAtOrBefore(sorted: number[], x: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (sorted[mid] <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/** Songs made from a recording (not MIDI files, sheet music or the demo) get the automatic pedal. */
export function isAudioSong(song: { transcription: { method: string } }): boolean {
  const m = song.transcription.method;
  return m === 'basic-pitch' || m === 'piano-specialist';
}
