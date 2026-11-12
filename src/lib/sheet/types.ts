/**
 * Data model of the sheet-music pipeline (no DOM): song notes in seconds → quantized notes in
 * divisions → voiced chords per staff → MusicXML. Positions and durations are integers in
 * DIVISIONS per quarter note (12: a 16th is 3, a triplet 8th 4, a triplet 16th 2).
 */
import type { Difficulty } from '../music/types';

export const DIV = 12;

export type Staff = 1 | 2;
export type ClefSign = 'G' | 'F';

/** Notation rules that depend on the arrangement level. */
export interface SheetLevelRules {
  level: Difficulty;
  /** Candidate grids per quarter note (subdivisions). 3 = triplet 8ths. */
  grids: number[];
  /** Smallest written note in divisions. */
  minDur: number;
  /** Close gaps up to this length between notes of the same voice (divisions). */
  fillGap: number;
  /** A note followed by a longer rest is lengthened to the next multiple of this (divisions). */
  restGrid: number;
  /** Whether a staff may use a second voice. 'limited' = only for held notes under/over moving ones. */
  secondVoice: 'never' | 'limited' | 'always';
  /** Whether clef changes are allowed. */
  clefChanges: boolean;
}

export const LEVEL_RULES: Record<Difficulty, SheetLevelRules> = {
  easy: { level: 'easy', grids: [1, 2], minDur: 6, fillGap: 12, restGrid: 12, secondVoice: 'never', clefChanges: false },
  medium: { level: 'medium', grids: [1, 2, 4, 3], minDur: 3, fillGap: 6, restGrid: 6, secondVoice: 'limited', clefChanges: true },
  hard: { level: 'hard', grids: [1, 2, 4, 3], minDur: 3, fillGap: 3, restGrid: 3, secondVoice: 'always', clefChanges: true },
};

/** A quantized note. `on`/`off` are absolute positions in divisions from the start of measure 0. */
export interface QNote {
  midi: number;
  on: number;
  off: number;
  staff: Staff;
}

/** Notes that start together and end together in one voice. */
export interface Chord {
  on: number;
  off: number;
  /** Ascending. */
  midis: number[];
  /** An octave mark starts right before this chord (8 = 8va, -8 = 8vb). */
  ottavaStart?: 8 | -8;
  /** The octave mark ends right after this chord. */
  ottavaStop?: boolean;
}

export interface StaffVoices {
  staff: Staff;
  /** [voice 1 (upper, stems up), voice 2 (lower, stems down)]; each sorted, non-overlapping. */
  voices: [Chord[], Chord[]];
}

/** One octave-mark run on a staff, in divisions. */
export interface Ottava {
  staff: Staff;
  shift: 8 | -8;
  start: number;
  /** End of the last note of the run. */
  stop: number;
}

/** Beat grid and measures of a song. */
export interface TimeMap {
  beatsPerBar: number;
  beatUnit: 2 | 4 | 8;
  /** 6/8, 9/8, 12/8: beats are grouped in dotted quarters. */
  compound: boolean;
  /** Length of a beat group (for splitting and beaming) in divisions. */
  beatLen: number;
  measureLen: number;
  /** Length of an implicit pickup measure 0 (0 = none). */
  pickup: number;
  /** Continuous position (divisions, not rounded) of a song time in seconds. */
  toPos(t: number): number;
  /** Song time in seconds of a position in divisions. */
  posToTime(pos: number): number;
  measureStart(m: number): number;
  measureOf(pos: number): number;
  /** Start bpm in beat units, for the tempo mark. */
  bpm: number;
  /** Where the beats came from. */
  source: 'midi' | 'estimated' | 'manual';
}

export interface TempoMark {
  measure: number;
  /** Beats per minute of the written beat unit. */
  bpm: number;
  /** Quarter notes per minute, for <sound tempo>. */
  qpm: number;
}

export interface Score {
  level: Difficulty;
  time: TimeMap;
  fifths: number;
  mode: 'major' | 'minor';
  /** Pitch class of the tonic when the key is minor (for the leading-tone spelling). */
  minorTonic?: number;
  measureCount: number;
  /** measureStartTimes[m] = song time (s) of measure m; length measureCount + 1. */
  measureStartTimes: number[];
  notes: QNote[];
  staves: [StaffVoices, StaffVoices];
  /** Quarters (absolute index) written as triplets. */
  tripletQuarters: Set<number>;
  /** clefs[staff-1][measure] */
  clefs: [ClefSign[], ClefSign[]];
  ottavas: Ottava[];
  tempoMarks: TempoMark[];
}
