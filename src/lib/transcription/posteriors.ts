/** Model posteriors are stored 8-bit quantised (4x smaller; ±0.002 error is irrelevant to thresholds). */
export interface StoredPosteriors {
  nFrames: number;
  frames: Uint8Array;
  onsets: Uint8Array;
  rms: Float32Array;
  /**
   * Posteriors of the separated vocal stem, stored alongside the accompaniment's so the melody
   * line survives re-detection (pass to reextractNotes as melodyPosteriors).
   */
  melody?: StoredPosteriors;
}

export function dequantize(a: Uint8Array): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] / 255;
  return out;
}
