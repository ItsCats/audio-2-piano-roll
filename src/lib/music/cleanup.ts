/** Post-processing of raw transcribed notes into a cleaner, playable note list. */
import type { Note } from './types';

let nextId = 1;
export const newNoteId = (): number => nextId++;
/** Ensure freshly generated ids never collide with ids loaded from storage. */
export function bumpNoteIds(notes: Note[]): void {
  for (const n of notes) if (n.id >= nextId) nextId = n.id + 1;
}

/** Merge same-pitch fragments separated by tiny gaps (model activation dips). */
export function mergeFragments(notes: Note[], maxGap = 0.03, onsetStrength?: Map<number, number>): Note[] {
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
      const strongOnset = onsetStrength ? (onsetStrength.get(n.id) ?? 1) > 0.6 : false;
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
 * resonating (sustain pedal, reverb, beating). Fold it into the earlier note.
 */
export function mergeContinuations(notes: Note[], onsetStrength: Map<number, number>, maxOnset: number, maxGap = 0.3): Note[] {
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const lastByPitch = new Map<number, Note>();
  const out: Note[] = [];
  for (const n of sorted) {
    const prev = lastByPitch.get(n.midi);
    const weak = (onsetStrength.get(n.id) ?? 1) < maxOnset;
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
