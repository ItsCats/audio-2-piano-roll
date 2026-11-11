/** Model posteriors are stored 8-bit quantised (4x smaller; ±0.002 error is irrelevant to thresholds). */
export interface StoredPosteriors {
  nFrames: number;
  frames: Uint8Array;
  onsets: Uint8Array;
  rms: Float32Array;
  /**
   * Separated songs (in-browser SCNet): onset strength of the drums stem, 8-bit at
   * DRUM_ENV_FPS (separation/dsp.ts drumOnsetEnvelope). Re-detection uses it to drop the false
   * low notes that drum hits leaking into the accompaniment produce. ~6 KB per minute.
   */
  drums?: Uint8Array;
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
