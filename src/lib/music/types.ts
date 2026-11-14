import type { HandVideo } from '../handcam/types';
export type Hand = 'L' | 'R';
export type Difficulty = 'easy' | 'medium' | 'hard';
export const DIFFICULTIES: Difficulty[] = ['easy', 'medium', 'hard'];

/** A single note. Times are in seconds of song time; velocity is 0..1. */
export interface Note {
  id: number;
  midi: number;
  start: number;
  dur: number;
  vel: number;
  hand: Hand;
  /**
   * Musical role, when known. 'melody' marks notes of the sung melody line extracted from the
   * separated vocal stem: they always sit in the right hand and Easy/Medium are built around them.
   * 'lead' marks lead-line notes recovered by the "Full song" preset's sensitive pass
   * (music/leadRecovery.ts): they are shown on Hard only (Easy and Medium are built without them).
   * 'bass' marks the separated bass stem's one-note-at-a-time line (transcription/bassLine.ts):
   * Easy's left hand follows it where it sounds.
   */
  role?: 'melody' | 'lead' | 'bass';
  /**
   * Added by the "Full song + piano model" blend (music/pianoBlend.ts) from the piano model's notes:
   * 'piano' a fill (keyboard part, in-between note; no role, never part of Easy's or Medium's tune
   * line), 'piano-lead' a lead note in a hole of the tune line (the roles recovered lead notes get).
   * 'restrike': the second piece of an app note the blend split
   * where the piano model hears it struck again (pianoBlend.ts blendRestrikes; Easy joins the pieces
   * back). Absent on every other note.
   */
  src?: 'piano' | 'piano-lead' | 'restrike';
  /**
   * Where the note is written on the sheet, set by sheet edits (lib/sheet/edit.ts): positions on the
   * song's locked grid (Song.sheet). Valid only while `start === t && dur === d`: a piano-roll edit
   * that moves or resizes the note releases it back to the normal quantizing.
   */
  pin?: NotePin;
  /** Fingering written on the sheet (1 = thumb … 5 = little finger). */
  finger?: 1 | 2 | 3 | 4 | 5;
  /** Articulations written on the sheet (de-duplicated, known values only); their sound is baked into dur / vel. */
  art?: Articulation[];
  /** Sounding values before articulations changed them; restored when the last one is removed. */
  artBase?: { dur?: number; vel?: number };
}

export type Articulation = 'staccato' | 'accent' | 'tenuto' | 'marcato';
export const ARTICULATIONS: Articulation[] = ['staccato', 'accent', 'tenuto', 'marcato'];

export type DynamicValue = 'pp' | 'p' | 'mp' | 'mf' | 'f' | 'ff' | 'fff' | 'sf' | 'sfz' | 'fp';
export const DYNAMIC_VALUES: DynamicValue[] = ['pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'sf', 'sfz', 'fp'];

/**
 * A marking on the sheet of one level. `pos` / `end`: integer divisions (12 per quarter) on the
 * song's locked grid (Song.sheet.grid). Staff 0 = both hands (written once, between the staves).
 * Slurs join two notes of the same hand by note id.
 */
export type SheetMark =
  | { id: string; kind: 'dyn'; pos: number; staff: 0 | 1 | 2; value: DynamicValue }
  | { id: string; kind: 'wedge'; pos: number; end: number; staff: 0 | 1 | 2; dir: 'cresc' | 'dim' }
  | { id: string; kind: 'text'; pos: number; staff: 1 | 2; text: string; above: boolean; style?: 'italic' | 'bold' }
  | { id: string; kind: 'slur'; from: number; to: number; below?: boolean };

/** A written position on Song.sheet.grid (divisions, 12 per quarter) and the seconds it was set at. */
export interface NotePin {
  on: number;
  off: number;
  t: number;
  d: number;
}

/** Sustain pedal held from `start` to `end` (seconds). */
export interface PedalRange {
  start: number;
  end: number;
}

export interface Arrangement {
  notes: Note[];
  pedal: PedalRange[];
  /** True once the user has edited this arrangement by hand. */
  edited: boolean;
  generatedAt: number;
  /** Markings written on this level's sheet (sheet editing; absent in older songs). */
  marks?: SheetMark[];
  /** Write `pedal` as pedal marks on this level's sheet (off for older songs: their sheet is unchanged). */
  showPedal?: true;
  /** The pedal was edited on the sheet: automatic pedal and regenerating ask before replacing it. */
  pedalEdited?: true;
}

export interface TempoInfo {
  bpm: number;
  /** Beat times in seconds (tracked, may drift with the performance). */
  beats: number[];
  beatsPerBar: number;
  /**
   * Note value of one beat (the time signature's lower number). Missing in songs saved before
   * sheet music existed: means 4, except 6, 9 or 12 beats per bar from a MIDI file mean 8.
   */
  beatUnit?: 2 | 4 | 8;
  /** Index into `beats` of the first downbeat. */
  downbeatIndex: number;
  /** 0..1 how confident the tempo estimate is. */
  confidence: number;
  /** Where the tempo came from. */
  source: 'midi' | 'estimated' | 'manual';
}

export interface KeyInfo {
  tonic: number; // pitch class 0..11
  mode: 'major' | 'minor';
  name: string;
  confidence: number;
  /** Key signature as written in an imported score (sharps > 0, flats < 0); absent when estimated. */
  fifths?: number;
}

/** 'score': a sheet-music file (MusicXML, .mxl, MuseScore), or a PDF / photo read by the sheet-music reader (SongSource.reader). */
export type SourceKind = 'audio' | 'midi' | 'youtube' | 'capture' | 'demo' | 'score';

export interface SongSource {
  kind: SourceKind;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  youtubeId?: string;
  url?: string;
  /**
   * 'score' songs read from a PDF or a photo by the sheet-music reader (beta, src/lib/omr): the notes
   * are the reader's estimate and should be checked (absent: a sheet-music file, notes as written).
   */
  reader?: 'pdf' | 'photo';
  /**
   * which sheet-music reader read it (src/lib/omr/readers.ts): 'accurate' (homr) or 'quick' (the Sheet
   * Music Transformer, Beta). Absent on songs read before there was a choice: the quick reader.
   */
  sheetReader?: 'accurate' | 'quick';
  /** pages read (sheet-music reader) */
  pages?: number;
}

/** Parameters of the note-extraction stage (can be re-run without re-running the model). */
export interface ExtractionParams {
  onsetThreshold: number;
  frameThreshold: number;
  minNoteMs: number;
  minMidi: number;
  maxMidi: number;
  melodiaTrick: boolean;
  /** Remove probable overtone ghost notes (octave / twelfth above louder notes). */
  suppressHarmonics: boolean;
  /** Also infer onsets from rises in frame activation (helps soft attacks, adds fragments). */
  inferOnsets?: boolean;
  /**
   * Same-pitch notes whose model onset probability is below this value are treated as the
   * continuation of a still-ringing note rather than a re-strike (0 disables).
   */
  continuationOnset?: number;
  /**
   * Register-dependent detection: thresholds (and the minimum note length) are scaled towards the
   * keyboard ends, ramping linearly from lowMidi down to A0 and from highMidi up to C8 (factors are
   * multipliers; 1 or omitted = unchanged). Same shape as RegisterCurve in transcription/noteExtraction.ts.
   */
  register?: {
    lowMidi: number;
    highMidi: number;
    lowOnset?: number;
    lowFrame?: number;
    lowMinFrames?: number;
    highOnset?: number;
    highFrame?: number;
    highMinFrames?: number;
  };
  /**
   * Re-join held notes chopped into back-to-back same-pitch repeats by other notes' attacks
   * (transcription/noteExtraction.ts REPEAT_JOIN). false turns it off; omitted = on (default).
   */
  joinRepeats?: boolean;
  /** Drop ghost notes in near-silence (music/cleanup.ts TAIL_GATE). false turns it off; omitted = on. */
  tailGate?: boolean;
  /**
   * Lead-line recovery (music/leadRecovery.ts): a second, more sensitive extraction of the same
   * posteriors (transcription/pipeline.ts LEAD_PASS, read at run time) whose notes are kept only
   * where the instruments' tune line goes through them; Hard-only. Omitted / false = off.
   */
  leadPass?: boolean;
}

export interface TranscriptionInfo {
  /**
   * 'piano-specialist': the high-accuracy solo-piano model (Kong et al. 2021, lib/pianoSpecialist).
   * 'score-file': read from sheet music (lib/score), notes exactly as written.
   */
  method: 'basic-pitch' | 'piano-specialist' | 'midi-file' | 'score-file' | 'demo';
  /** True whenever the notes were inferred from audio (always an estimate). */
  estimated: boolean;
  /**
   * The hands come from the score (a MIDI file's named hand tracks or two-staff layout, a piano
   * part's staves in sheet music, the built-in demo): Hard keeps them as written (no hand-span
   * reassignment).
   */
  handsFromScore?: boolean;
  params?: ExtractionParams;
  backend?: string;
  processingMs?: number;
  separated?: boolean;
  /** Source separation that ran before transcription (SCNet, in the browser or on the server). */
  separation?: {
    engine: 'scnet-browser' | 'scnet-server';
    vocals: boolean;
    /** no singing, or no melody line from it: the vocal stem was transcribed together with the accompaniment (pipeline.ts vocalsIntoAccomp) */
    vocalsInAccomp?: boolean;
    ms: number;
    threads?: number;
  };
  /**
   * The "Full song + piano model" blend (pipeline.ts, music/pianoBlend.ts): absent when it was not
   * asked for (and on every song imported before it existed).
   */
  pianoBlend?: PianoBlendInfo;
  warnings: string[];
  /** Rough 0..1 indicator of how clean the model output was (mean peak note confidence). */
  confidence?: number;
}

/** What the piano-model blend did on import (TranscriptionInfo.pianoBlend). */
export interface PianoBlendInfo {
  v: 1;
  /** 'failed': the piano model did not run (the notes are the standard Full song result) */
  status: 'ok' | 'failed';
  /** the audio the piano model heard: the separated "other" stem (accompaniment minus bass) */
  input: 'other';
  /** lead notes added in holes of the tune line */
  leadAdded: number;
  /** fill notes added (keyboard parts, in-between notes) */
  fills: number;
  /** 2 s segments where fills may go above the tune ("riff on top", off unless enabled) */
  riffSegments: number;
  /** tune notes moved to the piano model's octave (off unless enabled) */
  octaveFixes: number;
  /** held app notes split where the piano model hears them re-struck (absent: none) */
  restrikes?: number;
}

export interface Song {
  id: string;
  title: string;
  artist?: string;
  createdAt: number;
  updatedAt: number;
  lastPlayedAt?: number;
  duration: number;
  source: SongSource;
  tempo: TempoInfo;
  key?: KeyInfo;
  transcription: TranscriptionInfo;
  /** Cleaned full-detail notes the difficulty levels are derived from. */
  base: Note[];
  basePedal: PedalRange[];
  arrangements: Record<Difficulty, Arrangement>;
  thumbnail?: string;
  /** Original audio is stored in IndexedDB under the song id. */
  hasAudio: boolean;
  /** Model posteriors are stored so note detection can be re-tuned without re-running the model. */
  hasPosteriors: boolean;
  favorite?: boolean;
  /**
   * Songs from audio: Medium and Hard carry sustain pedal derived from their notes
   * (music/autoPedal.ts). On for imports since 2026-11; songs saved before have no value (off)
   * until it is switched on in the Sound panel. Never set for MIDI files or sheet music.
   */
  autoPedal?: boolean;
  /**
   * A video of the player's hands for "hands video" exports (lib/handcam). Absent in older songs
   * and when none was added; the file is in IndexedDB (see HandVideo.store).
   */
  handVideo?: HandVideo;
  /** Sheet edits: the locked beat grid (absent in older songs and until the sheet is first edited). */
  sheet?: SongSheet;
}

/**
 * The beat grid the sheet is written on, frozen at the first sheet edit (lib/sheet/lock.ts), so later
 * edits never re-bar the piece: the effective sheet beats (after grid.ts sheetTempo and the halving
 * or doubling of an estimated tempo), the downbeat, the extrapolation tempo, the meter, the origin
 * and the pickup.
 */
export interface SheetGridLock {
  /** Seconds, strictly increasing, at least 2. */
  beats: number[];
  /** Downbeat index into `beats`. */
  db: number;
  bpm: number;
  beatsPerBar: number;
  beatUnit: 2 | 4 | 8;
  /** Quarters from the downbeat to the start of measure 0. */
  originQ: number;
  /** Divisions of an implicit pickup measure (0 = none). */
  pickup: number;
}

/** Sheet-music data of a song (absent until the sheet is first edited). */
export interface SongSheet {
  v: 1;
  grid: SheetGridLock;
  /** At least this many measures are written (the sheet's "Add bar"). */
  bars?: number;
  /** Key signatures from a measure start (pos, divisions); pos 0 overrides song.key for the sheet only. Sorted by pos. */
  keys?: SheetKey[];
  /** Time signatures from a measure start: a relabel (no note moves, the bars are regrouped). Sorted by pos. */
  meters?: SheetMeter[];
  /** Tempo marks from a measure start. `retimed`: the music was re-timed to it (songs without a recording). Sorted by pos. */
  tempos?: SheetTempo[];
}

export interface SheetKey {
  pos: number;
  fifths: number;
  mode: 'major' | 'minor';
}
export interface SheetMeter {
  pos: number;
  beatsPerBar: number;
  beatUnit: 2 | 4 | 8;
}
/** unit: the note value of one beat ('q.' = dotted quarter). */
export type TempoUnit = 'q' | 'h' | 'e' | 'q.';
export interface SheetTempo {
  pos: number;
  bpm: number;
  unit: TempoUnit;
  text?: string;
  retimed: boolean;
}

export type SongSummary = Pick<
  Song,
  'id' | 'title' | 'artist' | 'createdAt' | 'updatedAt' | 'lastPlayedAt' | 'duration' | 'source' | 'thumbnail' | 'favorite'
> & { noteCount: number; bpm: number; keyName?: string; estimated: boolean };
