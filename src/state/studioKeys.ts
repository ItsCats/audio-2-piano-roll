/**
 * Shared rules for the Studio's keyboard shortcuts (Settings lists "← / →: Seek ±5 s (Shift: ±1 s)").
 * The song-position bar handles its own arrow keys and stops the event, so one press seeks once.
 */

/** Seconds one ← / → press moves the playhead. */
export function seekStepSeconds(shiftKey: boolean): number {
  return shiftKey ? 1 : 5;
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
