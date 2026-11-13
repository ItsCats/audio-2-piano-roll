/**
 * Frame pacing for the mini-games: they draw at most `fps` times a second so they leave the
 * processor to the import running alongside.
 */

/**
 * Frames per second: 30 on phones and tablets, and on computers while the import still runs (drawing
 * and putting frames on screen take processor time the import could use); 60 on a computer once the
 * import is done.
 */
export function gameFps(touch: boolean, importing = false): number {
  return touch || importing ? 30 : 60;
}

/**
 * Whether a frame is due at `now` (ms) when the last one was drawn at `last`. A little slack (2 ms)
 * so a 60 Hz display still gets every 2nd frame at 30 fps instead of every 3rd.
 */
export function frameDue(now: number, last: number, fps: number): boolean {
  return now - last >= 1000 / fps - 2;
}

/**
 * How long to sleep (ms) before asking for the next animation frame: until 8 ms before the next game
 * frame is due, so the frame the browser then gives is the due one (no wake-ups on the refreshes in
 * between, at 60 or 120 Hz); 0 = ask now.
 */
export function frameWait(now: number, last: number, fps: number): number {
  const wait = last + 1000 / fps - now - 8;
  return wait > 2 ? Math.round(wait) : 0;
}

/** most canvas pixels a game draws each frame (the whole board is redrawn, so this bounds the work per frame) */
export const MAX_CANVAS_PIXELS = { touch: 450_000, desktop: 750_000 };

/**
 * Device pixels per CSS pixel for a game canvas of `width`×`height` CSS pixels: sharp, but at most 2
 * (1.5 on phones), and never more than MAX_CANVAS_PIXELS in all (a big board on a high-density
 * screen is drawn a little softer instead of costing more time and memory per frame).
 */
export function canvasScale(devicePixelRatio: number, touch: boolean, width = 0, height = 0): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  let s = Math.min(dpr, touch ? 1.5 : 2);
  const area = width * height;
  const max = touch ? MAX_CANVAS_PIXELS.touch : MAX_CANVAS_PIXELS.desktop;
  if (area > 0 && area * s * s > max) s = Math.max(0.5, Math.sqrt(max / area));
  return Math.round(s * 100) / 100;
}
