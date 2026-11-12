/**
 * Shared rules for the Studio's keyboard shortcuts (Settings lists "← / →: Seek ±5 s (Shift: ±1 s)").
 * The song-position bar handles its own arrow keys and stops the event, so one press seeks once.
 */

/** Seconds one ← / → press moves the playhead. */
export function seekStepSeconds(shiftKey: boolean): number {
  return shiftKey ? 1 : 5;
}

interface ArrowKeyLike {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}

/**
 * Seconds a ← / → press seeks by (negative = back), or null when it isn't a seek key. Alt, Cmd and
 * Ctrl combinations are left to the browser (Alt+← / Cmd+← is Back, Cmd+→ is Forward).
 */
export function arrowSeekDelta(e: ArrowKeyLike): number | null {
  if (e.altKey || e.metaKey || e.ctrlKey) return null;
  if (e.key === 'ArrowRight') return seekStepSeconds(e.shiftKey);
  if (e.key === 'ArrowLeft') return -seekStepSeconds(e.shiftKey);
  return null;
}

/**
 * Where a song-position slider's key press moves the playhead (seconds, clamped to the song), or
 * null when the key isn't one it handles: ← / → (and ↓ / ↑) by the seek step, Home / End to the
 * ends. Alt, Cmd and Ctrl combinations are left to the browser, as with `arrowSeekDelta`.
 */
export function sliderSeekTarget(e: ArrowKeyLike, time: number, duration: number): number | null {
  if (e.altKey || e.metaKey || e.ctrlKey) return null;
  const key = e.key === 'ArrowDown' ? 'ArrowLeft' : e.key === 'ArrowUp' ? 'ArrowRight' : e.key;
  let to: number | null;
  if (key === 'Home') to = 0;
  else if (key === 'End') to = duration;
  else {
    const delta = arrowSeekDelta({ key, shiftKey: e.shiftKey, altKey: false, metaKey: false, ctrlKey: false });
    to = delta === null ? null : time + delta;
  }
  return to === null ? null : Math.max(0, Math.min(duration, to));
}

interface KeyLike {
  defaultPrevented: boolean;
  target: EventTarget | null;
}

/** Whether the page-wide shortcut handler should act on this keydown. */
export function shouldHandleGlobalKey(e: KeyLike): boolean {
  if (e.defaultPrevented) return false; // already handled (e.g. by the song-position bar)
  const target = e.target as { closest?: (sel: string) => unknown } | null;
  if (target && typeof target.closest === 'function' && target.closest('input, textarea, select, [contenteditable="true"]')) return false;
  return true;
}
