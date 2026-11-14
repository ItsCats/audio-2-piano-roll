import type { StoredPitch } from './stemPitch';

/** Model posteriors are stored 8-bit quantised (4x smaller; ±0.002 error is irrelevant to thresholds). */
export interface StoredPosteriors {
  nFrames: number;
  frames: Uint8Array;
  onsets: Uint8Array;
  rms: Float32Array;
  /**
   * Separated songs (in-browser SCNet): onset strength of the drums stem, 8-bit at
   * DRUM_ENV_FPS (separation/dsp.ts drumOnsetEnvelope), for the drum-hit false-note filter
   * (music/cleanup.ts DRUM_HIT_RULE, currently off). ~6 KB per minute.
   */
  drums?: Uint8Array;
  /**
   * Separated in the browser with an audible bass stem ("Full song" preset): the bass stem's own
   * posteriors (same frame grid), MIDI 21..55 only (`pitches` values per frame; bassLine.ts
   * BASS_BAND_PITCHES, ~0.35 MB per minute), read as one bass line on import and re-detection.
   */
  bass?: { nFrames: number; pitches?: number; frames: Uint8Array; onsets: Uint8Array };
  /** Separated in the browser, no sung line: pitch track of the lead-bearing stem, the tune cue (transcription/stemPitch.ts). ~6 bytes per 10 ms. */
  leadPitch?: StoredPitch;
  /**
   * The song was separated (any engine): without a sung line, Easy and Medium get the recovered
   * lead notes too (pipeline.ts LEAD_EVERY_LEVEL). Absent on records from before this was stored:
   * they re-detect as they were imported (Hard-only lead).
   */
  separated?: true;
  /**
   * "Full song + piano model" (music/pianoBlend.ts): the piano model's notes on the other stem, 6
   * numbers each (start, dur, midi, velocity, onset peak, frame mean; pianoBlend.ts packSpecNotes),
   * about 0.4 KB per second. Re-detection blends them in again. The model's own output maps are not
   * stored, so its own thresholds cannot be re-tuned. Absent on every other song.
   */
  specialist?: Float32Array;
  /**
   * @deprecated Older records (before the melody line was kept as notes) also stored the vocal
   * stem's posteriors here. Nothing reads them any more; re-detection keeps the song's
   * melody notes instead.
   */
  melody?: StoredPosteriors;
}

export function dequantize(a: Uint8Array): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] / 255;
  return out;
}
