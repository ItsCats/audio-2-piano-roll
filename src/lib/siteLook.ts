/**
 * The site's look (src/styles/site.css): light, or dark when the phone or computer is in dark mode.
 * It is switched on with `data-site` on <html> everywhere except the Piano Studio: on /studio the
 * attribute is removed, so the Studio (and its dialogs, toasts and full screen) keeps its own dark look.
 */

/** the key the site looks being tried out used to remember a choice in; no longer read */
const OLD_SKIN_KEY = 'piano2vision-skin';

/** the browser bar color: the Studio's dark, or the site's page color (light or dark mode) */
const STUDIO_BAR = '#0b0b0f';
const SITE_BAR = { light: '#faf9f6', dark: '#111110' };

let darkMode: MediaQueryList | null = null;

function setBarColor() {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) return;
  const inStudio = !('site' in document.documentElement.dataset);
  meta.content = inStudio ? STUDIO_BAR : darkMode?.matches ? SITE_BAR.dark : SITE_BAR.light;
}

/** Sets `data-site` on <html> outside the Studio and removes it in the Studio. */
export function applySiteLook(inStudio: boolean) {
  const root = document.documentElement;
  if (inStudio) delete root.dataset.site;
  else root.dataset.site = '';
  if (!darkMode && typeof window.matchMedia === 'function') {
    darkMode = window.matchMedia('(prefers-color-scheme: dark)');
    darkMode.addEventListener?.('change', setBarColor);
  }
  setBarColor();
}

/** Removes the remembered site look from the try-out (harmless when it isn't there). */
export function forgetOldSkin() {
  try {
    localStorage.removeItem(OLD_SKIN_KEY);
  } catch {
    // storage blocked: nothing to clean up
  }
}
