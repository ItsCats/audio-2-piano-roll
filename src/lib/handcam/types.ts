/**
 * Hands video ("hand cam"): a video of the player's hands on a real keyboard, shown under (or next
 * to) the falling notes in an exported video. Saved on the song (Song.handVideo), the file itself
 * in IndexedDB (lib/storage/db.ts).
 */

/** Where the camera's keyboard is in the video, and which keys it shows. */
export interface KeyboardCalibration {
  v: 1;
  /** video time (s) of the frame the corners were set on */
  frameTime: number;
  /** the camera faces the player (the keyboard is upside down in the picture) */
  turn: 0 | 180;
  /** selfie camera: the picture is mirrored */
  mirror: boolean;
  /**
   * The keyboard's corners as fractions (0..1) of the video frame as shown (after the file's
   * rotation and `turn` / `mirror`): back-left (lowest key, where the keys meet the fallboard),
   * back-right, front-right, front-left.
   */
  corners: [number, number][];
  /** MIDI notes of the leftmost and rightmost white keys between the corners */
  lo: number;
  hi: number;
  /** fine match, in white keys: where the left and right edges really are (0 = at the corners) */
  edgeL: number;
  edgeR: number;
  /** key length compared with a standard piano key (150 mm long, 23.5 mm wide) */
  keyLength: number;
  /** where the notes land, in key lengths from the back edge of the keys (0 = the back edge) */
  hitV: number;
  /** how much of the hands area below the front edge of the keys is shown, in key lengths */
  hands: number;
  /** which keys the video shows: all of them, or only around the ones this song uses */
  view: 'all' | 'song';
}

export type SyncLevel = 'high' | 'medium' | 'low';

export interface HandVideoSync {
  /** what the video was lined up with */
  method: 'import' | 'original' | 'notes' | 'manual';
  /** the offset the automatic sync found (s) */
  found: number;
  /** peak ratio (higher is clearer) */
  confidence: number;
  level: SyncLevel;
  /** the start and end of the song suggested different offsets (another performance) */
  drift?: boolean;
}

export interface HandVideo {
  v: 1;
  /**
   * 'audio': the song was imported from this video, which is its original recording (stored once,
   * in the 'audio' store). 'handcam': added later (its own 'handcam' store entry).
   */
  store: 'audio' | 'handcam';
  fileName: string;
  mimeType: string;
  size: number;
  /** seconds */
  duration: number;
  /** frame size as shown (after the file's rotation metadata) */
  displayW: number;
  displayH: number;
  rotation: number;
  fps?: number;
  codec?: string;
  /** video time = song time + offset (s) */
  offset: number;
  sync?: HandVideoSync;
  calibration?: KeyboardCalibration;
  addedAt: number;
}

export type HandsLayout = 'off' | 'bottom' | 'pip';
export type Corner = 'tl' | 'tr' | 'bl' | 'br';
