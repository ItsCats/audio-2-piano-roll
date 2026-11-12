/** Fade curves shared by the offline piano render and the video export (pure). */

/** Fade gain of a render that is the whole file (its own output time `o`, length `d`). */
export function ownFadeGain(o: number, d: number, fadeIn: number, fadeOut: number): number {
  let g = 1;
  if (fadeIn > 0 && o < fadeIn) g *= o / fadeIn;
  if (fadeOut > 0 && o > d - fadeOut) g *= Math.max(0, (d - o) / fadeOut);
  return g;
}

/** Fade gain at time `o` of a file `d` seconds long: the same curve the video picture uses. */
export function timelineFadeGain(o: number, d: number, fadeIn: number, fadeOut: number): number {
  return Math.max(0, Math.min(1, fadeIn > 0 ? o / fadeIn : 1, fadeOut > 0 ? (d - o) / fadeOut : 1));
}
