/**
 * Site looks being tried out (mockups): `?skin=notebook|hardware|editorial` picks one and remembers it
 * in this browser, `?skin=off` goes back to the current look. The Piano Studio never takes a skin: on
 * /studio the attribute is removed, so the Studio (and its dialogs and toasts) look exactly as before.
 */
export const SKINS = ['notebook', 'hardware', 'editorial'] as const;
export type Skin = (typeof SKINS)[number];

const KEY = 'piano2vision-skin';

function chosenSkin(): Skin | null {
  try {
    const p = new URLSearchParams(window.location.search).get('skin');
    if (p === 'off') localStorage.removeItem(KEY);
    else if (p && (SKINS as readonly string[]).includes(p)) localStorage.setItem(KEY, p);
    const v = localStorage.getItem(KEY);
    return v && (SKINS as readonly string[]).includes(v) ? (v as Skin) : null;
  } catch {
    return null;
  }
}

/** Sets or clears `data-skin` on <html> (cleared in the Studio). */
export function applySkin(inStudio: boolean) {
  const skin = inStudio ? null : chosenSkin();
  const root = document.documentElement;
  if (skin) root.dataset.skin = skin;
  else delete root.dataset.skin;
}
