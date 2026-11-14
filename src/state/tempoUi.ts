/**
 * "Set the tempo" from anywhere in the Studio (the sheet-music notice, the sheet's tempo mark, the
 * speed menu, the tips): opens the side panel on the Notes tab and puts the cursor in the tempo
 * field (components/studio/panels/TempoControl.tsx). The Studio page listens for the request.
 */
import { isStageFullscreen, toggleStageFullscreen } from './fullscreenStore';

export const TEMPO_INPUT_ID = 'song-tempo-input';
export const OPEN_TEMPO_EVENT = 'pv:open-tempo';

let pending = false;

/** Puts the cursor in the tempo field when it is on the page (true: it was). */
export function focusTempoInput(): boolean {
  const el = document.getElementById(TEMPO_INPUT_ID) as HTMLInputElement | null;
  if (!el) return false;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.focus({ preventScroll: true });
  el.select();
  return true;
}

/** Opens the tempo setting (the Notes tab of the side panel) and focuses its field. */
export function openTempoSetting(): void {
  if (isStageFullscreen()) toggleStageFullscreen();
  pending = true;
  window.dispatchEvent(new Event(OPEN_TEMPO_EVENT));
  // the panel renders the field on the next frames
  let tries = 0;
  const step = () => {
    if (!pending) return;
    if (focusTempoInput()) pending = false;
    else if (++tries < 30) requestAnimationFrame(step);
    else pending = false;
  };
  requestAnimationFrame(step);
}
