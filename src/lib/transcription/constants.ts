/**
 * Constants of the Basic Pitch model (spotify/basic-pitch, Apache-2.0).
 * See basic_pitch/constants.py in the reference implementation.
 */
export const BP_SAMPLE_RATE = 22050;
export const BP_FFT_HOP = 256;
export const BP_WINDOW_SAMPLES = BP_SAMPLE_RATE * 2 - BP_FFT_HOP; // 43844 samples per model window
export const BP_FRAMES_PER_WINDOW = 172; // model output frames per window
export const BP_OVERLAP_FRAMES = 30;
export const BP_OVERLAP_HALF = BP_OVERLAP_FRAMES / 2; // 15
export const BP_OVERLAP_SAMPLES = BP_OVERLAP_FRAMES * BP_FFT_HOP; // 7680
export const BP_HOP_SAMPLES = BP_WINDOW_SAMPLES - BP_OVERLAP_SAMPLES; // 36164
export const BP_KEPT_FRAMES = BP_FRAMES_PER_WINDOW - 2 * BP_OVERLAP_HALF; // 142 frames kept per window
export const BP_N_PITCHES = 88;
export const BP_MIDI_OFFSET = 21;
export const BP_FPS = BP_SAMPLE_RATE / BP_FFT_HOP; // ~86.13

/**
 * Exact time (seconds) of output frame `f` after unwrapping overlapping windows.
 *
 * Window k starts at original sample k*HOP - OVERLAP/2 (the signal is front-padded by
 * OVERLAP/2 samples). We keep frames 15..156 of each window, so kept frame i of window k
 * sits at sample k*HOP + i*FFT_HOP. Consecutive windows are therefore 188 samples
 * "short" relative to a uniform frame grid; the reference JS implementation corrects this
 * with a per-172-frame constant, which drifts by ~70 ms/minute. This mapping is exact.
 */
export function frameToTime(f: number): number {
  const k = Math.floor(f / BP_KEPT_FRAMES);
  const i = f - k * BP_KEPT_FRAMES;
  return (k * BP_HOP_SAMPLES + i * BP_FFT_HOP) / BP_SAMPLE_RATE;
}

/** Inverse of frameToTime (nearest frame at or before t). */
export function timeToFrame(t: number): number {
  const sample = t * BP_SAMPLE_RATE;
  const k = Math.floor(sample / BP_HOP_SAMPLES);
  const i = Math.min(BP_KEPT_FRAMES - 1, Math.floor((sample - k * BP_HOP_SAMPLES) / BP_FFT_HOP));
  return k * BP_KEPT_FRAMES + Math.max(0, i);
}
