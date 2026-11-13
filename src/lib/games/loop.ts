/**
 * Frame pacing for the mini-games: they draw at most `fps` times a second (30 on phones, 60 on
 * computers) so they leave the processor to the import running alongside.
 */

/** frames per second for a device: phones and tablets 30, computers 60 */
export function gameFps(touch: boolean): number {
  return touch ? 30 : 60;
}

/**
 * Whether a frame is due at `now` (ms) when the last one was drawn at `last`. A little slack (2 ms)
 * so a 60 Hz display still gets every 2nd frame at 30 fps instead of every 3rd.
 */
export function frameDue(now: number, last: number, fps: number): boolean {
  return now - last >= 1000 / fps - 2;
}

/** Device pixels per CSS pixel for the game canvas: sharp, but never more than 2 (1.5 on phones, to keep memory low). */
export function canvasScale(devicePixelRatio: number, touch: boolean): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(dpr, touch ? 1.5 : 2);
}
