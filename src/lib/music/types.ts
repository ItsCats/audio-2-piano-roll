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
   */
  role?: 'melody';
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
}

export type SourceKind = 'audio' | 'midi' | 'youtube' | 'capture' | 'demo';

export interface SongSource {
  kind: SourceKind;
  fileName?: string;
  mimeType?: string;
  fileSize?: number;
  youtubeId?: string;
  url?: string;
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
}

export interface TranscriptionInfo {
  method: 'basic-pitch' | 'midi-file' | 'demo';
  /** True whenever the notes were inferred from audio (always an estimate). */
  estimated: boolean;
  params?: ExtractionParams;
  backend?: string;
  processingMs?: number;
  separated?: boolean;
  /** Source separation that ran before transcription (SCNet, in the browser or on the server). */
  separation?: { engine: 'scnet-browser' | 'scnet-server'; vocals: boolean; ms: number };
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
