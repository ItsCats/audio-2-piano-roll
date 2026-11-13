/**
 * Data model of the sheet-music pipeline (no DOM): song notes in seconds → quantized notes in
 * divisions → voiced chords per staff → MusicXML. Positions and durations are integers in
 * DIVISIONS per quarter note (12: a 16th is 3, a triplet 8th 4, a triplet 16th 2).
 */
import type { Articulation, Difficulty, SheetMark, TempoUnit } from '../music/types';

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
  /** Cap on the shortest length a note gets from its quarter's grid (compound meters: an 8th). */
  maxStep?: number;
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
  /** Ids of the Song notes written as this note (several when duplicates were merged). */
  src?: number[];
  /** Placed by a sheet edit (a valid Note.pin): written exactly at on/off. */
  pinned?: boolean;
}

/** Notes that start together and end together in one voice. */
export interface Chord {
  on: number;
  off: number;
  /** Ascending. */
  midis: number[];
  /** Song note ids of each of `midis` (same order). */
  srcByMidi?: number[][];
  /** Holds a pinned note: never cut, filled or lengthened. */
  pinned?: boolean;
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

export interface MeterInfo {
  beatsPerBar: number;
  beatUnit: 2 | 4 | 8;
  compound: boolean;
  beatLen: number;
  /** The full measure length of this meter (a cut-short measure is shorter: measureLenAt). */
  measureLen: number;
}

/** Beat grid and measures of a song. The meter fields are those of measure 0. */
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
  /** Length of measure m in divisions (the pickup, a measure cut short by a time-signature change). */
  measureLenAt(m: number): number;
  /** The meter of measure m (time-signature changes, Song.sheet.meters). */
  meterAt(m: number): MeterInfo;
  /** Whether the meter changes anywhere (false: every measure has the measure-0 meter). */
  changes: boolean;
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
  /** A tempo mark placed on the sheet (Song.sheet.tempos): its beat unit and words. */
  unit?: TempoUnit;
  text?: string;
}

/** A key signature in force from a measure on. */
export interface KeySig {
  measure: number;
  fifths: number;
  mode: 'major' | 'minor';
  /** Pitch class of the tonic in a minor key (leading-tone spelling). */
  minorTonic?: number;
}

/** What is written on a Song note besides its pitch and rhythm. */
export interface NoteMarks {
  finger?: number;
  art?: Articulation[];
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
  /** Key signatures (the first at measure 0: fifths / mode / minorTonic above). */
  keys: KeySig[];
  /** Markings of the level (dynamics, hairpins, words, slurs); absent: none. */
  marks?: SheetMark[];
  /** Fingering and articulations by Song note id; absent: none. */
  noteMarks?: Map<number, NoteMarks>;
  /** Pedal written on the sheet (Arrangement.showPedal), in divisions on the level grid; absent: not shown. */
  pedals?: { on: number; off: number }[];
}
