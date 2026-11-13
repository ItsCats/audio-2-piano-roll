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
 * The loop's times are performance.now() when a frame callback runs, not the frame's timestamp: some
 * browsers hand a frame asked for mid-refresh the timestamp of the refresh already under way, so
 * timestamps would make the loop wake on every refresh and skip half of them.
 *
 * A frame is due when it is at most FRAME_SLACK_MS early. The loop only asks for a frame after
 * sleeping (frameWait) until FRAME_LEAD_MS before the next one is due, so the first frame the browser
 * then gives is always drawn: one wake-up per drawn frame. The slack is under half a 60 Hz refresh,
 * so a 60 Hz display still gets every 2nd refresh at 30 fps, never two in a row.
 */
export const FRAME_SLACK_MS = 9;
export const FRAME_LEAD_MS = 7;

/** Whether a frame is due at `now` (ms) when the last one was drawn at `last`. */
export function frameDue(now: number, last: number, fps: number): boolean {
  return now - last >= 1000 / fps - FRAME_SLACK_MS;
}

/**
 * How long to sleep (ms) before asking for the next animation frame: until FRAME_LEAD_MS before the
 * next game frame is due, so the refresh the browser then gives is the due one (no wake-ups on the
 * refreshes in between, at 60, 90 or 120 Hz); 0 = ask now.
 */
export function frameWait(now: number, last: number, fps: number): number {
  const wait = last + 1000 / fps - now - FRAME_LEAD_MS;
  return wait > 2 ? Math.round(wait) : 0;
}

/** after a run ends, taps, keys and "Play again" wait this long before starting another (a late tap is not a restart) */
export const RESTART_DELAY_MS = 600;

export function restartAllowed(now: number, overAt: number): boolean {
  return now - overAt >= RESTART_DELAY_MS;
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
