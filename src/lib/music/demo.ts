/**
 * Built-in demo: J. S. Bach — Prelude in C major, BWV 846 (public domain), generated from
 * the piece's harmonic skeleton (each bar repeats one five-note broken-chord figure twice).
 * It is labelled as a demo arrangement, not as a transcription.
 */
import type { Note, PedalRange, TempoInfo } from './types';
import { parseNoteName } from './theory';
import { newNoteId } from './cleanup';

const BARS = [
  'C4 E4 G4 C5 E5', 'C4 D4 A4 D5 F5', 'B3 D4 G4 D5 F5', 'C4 E4 G4 C5 E5',
  'C4 E4 A4 E5 A5', 'C4 D4 F#4 A4 D5', 'B3 D4 G4 D5 G5', 'B3 C4 E4 G4 C5',
  'A3 C4 E4 G4 C5', 'D3 A3 D4 F#4 C5', 'G3 B3 D4 G4 B4', 'G3 Bb3 E4 G4 C#5',
  'F3 A3 D4 A4 D5', 'F3 Ab3 D4 F4 B4', 'E3 G3 C4 G4 C5', 'E3 F3 A3 C4 F4',
  'D3 F3 A3 C4 F4', 'G2 D3 G3 B3 F4', 'C3 E3 G3 C4 E4', 'C3 G3 Bb3 C4 E4',
  'F2 F3 A3 C4 E4', 'F#2 C3 A3 C4 Eb4', 'Ab2 F3 B3 C4 D4', 'G2 F3 G3 B3 D4',
  'G2 E3 G3 C4 E4', 'G2 D3 G3 C4 F4', 'G2 D3 G3 B3 F4', 'G2 Eb3 A3 C4 F#4',
  'G2 E3 G3 C4 G4', 'G2 D3 G3 C4 F4', 'G2 D3 G3 B3 F4', 'C2 C3 G3 Bb3 E4',
];

export function bachPreludeDemo(): { notes: Note[]; pedal: PedalRange[]; tempo: TempoInfo; duration: number } {
  const bpm = 66; // quarter notes per minute
  const beat = 60 / bpm;
  const six = beat / 4; // sixteenth
  const notes: Note[] = [];
  const pedal: PedalRange[] = [];
  BARS.forEach((bar, b) => {
    const p = bar.split(' ').map((n) => parseNoteName(n)!);
    const barStart = b * 4 * beat;
    for (let half = 0; half < 2; half++) {
      const t = barStart + half * 2 * beat;
      const accent = half === 0 ? 0.08 : 0;
      notes.push({ id: newNoteId(), midi: p[0], start: t, dur: 2 * beat - 0.02, vel: 0.55 + accent, hand: 'L' });
      notes.push({ id: newNoteId(), midi: p[1], start: t + six, dur: 7 * six - 0.02, vel: 0.5, hand: 'L' });
      const figure = [p[2], p[3], p[4], p[2], p[3], p[4]];
      figure.forEach((m, i) => {
        notes.push({
          id: newNoteId(),
          midi: m,
          start: t + (2 + i) * six,
          dur: six * 0.95,
          vel: 0.48 + (i === 0 || i === 3 ? 0.06 : 0) + accent / 2,
          hand: 'R',
        });
      });
    }
    pedal.push({ start: barStart + 0.03, end: barStart + 4 * beat - 0.05 });
  });
  // closing chord
  const end = BARS.length * 4 * beat;
  ['C2', 'C3', 'E4', 'G4', 'C5'].forEach((n, i) => {
    notes.push({ id: newNoteId(), midi: parseNoteName(n)!, start: end, dur: 4 * beat, vel: 0.55, hand: i < 2 ? 'L' : 'R' });
  });
  pedal.push({ start: end + 0.03, end: end + 4 * beat });
  const duration = end + 4 * beat + 1;
  const beats: number[] = [];
  for (let t = 0; t <= duration + beat; t += beat) beats.push(Math.round(t * 10000) / 10000);
  return {
    notes,
    pedal,
    duration,
    tempo: { bpm, beats, beatsPerBar: 4, downbeatIndex: 0, confidence: 1, source: 'midi' },
  };
}
