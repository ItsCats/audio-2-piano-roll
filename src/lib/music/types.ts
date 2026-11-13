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
   */
  role?: 'melody' | 'lead';
  /**
   * Separated band songs: share (0..1) of the note's opening in which the pitch track of the
   * lead-bearing stem (transcription/stemPitch.ts) is at this pitch. Absent where that stem had no
   * clear pitch, and for everything else. The instruments' tune line (melody.ts instrumentLine)
   * prefers notes that have it. Only set while the pipeline's STEM_PITCH.tag switch is on (off: it
   * did not help on the Slakh band set).
   */
  tune?: number;
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
  warnings: string[];
  /** Rough 0..1 indicator of how clean the model output was (mean peak note confidence). */
  confidence?: number;
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
}

export type SongSummary = Pick<
  Song,
  'id' | 'title' | 'artist' | 'createdAt' | 'updatedAt' | 'lastPlayedAt' | 'duration' | 'source' | 'thumbnail' | 'favorite'
> & { noteCount: number; bpm: number; keyName?: string; estimated: boolean };
