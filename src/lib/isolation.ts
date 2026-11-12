/**
 * Cross-origin isolation, route by route.
 *
 * Every app route is served with `Cross-Origin-Opener-Policy: same-origin` and
 * `Cross-Origin-Embedder-Policy: credentialless` (netlify.toml, and the dev/preview servers in
 * vite.config.ts). That makes the document `crossOriginIsolated`, which gives the separation
 * worker SharedArrayBuffer and therefore multi-threaded WASM.
 *
 * The one exception is the YouTube import route (YOUTUBE_IMPORT_PATH): the YouTube IFrame player
 * is a cross-origin document that sends no COEP header, so an isolated page can't embed it. That
 * route is served WITHOUT the two headers.
 *
 * Headers belong to the document, not to the URL the SPA router shows, so moving between the two
 * kinds of route needs a full page load (see needsDocumentSwitch). Browsers that ignore
 * `credentialless` (Safari as of 2026) never become isolated: they run one thread and embed the
 * player anywhere, so they never need the reload in the YouTube direction.
 */

export const YOUTUBE_IMPORT_PATH = '/import/youtube';

const normalize = (pathname: string) => (pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname);

/** the route that must not be isolated (it embeds the YouTube player) */
export function isYouTubeImportPath(pathname: string): boolean {
  return normalize(pathname) === YOUTUBE_IMPORT_PATH;
}

/**
 * Routes the server sends the isolation headers for. Keep in sync with the COOP/COEP rules in
 * netlify.toml (one rule per route; tests/e2e/isolation.mjs checks every route in a browser).
 * Unknown paths (the router's catch-all) get no isolation headers.
 */
const ISOLATED_ROUTES = [/^\/$/, /^\/index\.html$/, /^\/import$/, /^\/studio$/, /^\/studio\/[^/]+$/, /^\/library$/, /^\/settings$/, /^\/accuracy$/, /^\/credits$/];

/** whether the server sends the isolation headers for this route */
export function routeIsIsolated(pathname: string): boolean {
  const p = normalize(pathname);
  return ISOLATED_ROUTES.some((r) => r.test(p));
}

/** the document's own isolation, decided by the headers of the page load that created it */
export function documentIsolated(): boolean {
  return typeof globalThis !== 'undefined' && globalThis.crossOriginIsolated === true;
}

/** Route kind of the page load that created this document: its headers fixed the isolation state. */
const loadedAt = typeof location === 'undefined' ? '/' : location.pathname;
const loadedOnIsolatedRoute = routeIsIsolated(loadedAt);

// Remembered per browser: whether loading an isolated route actually produced an isolated document.
// Lets a browser without COEP credentialless skip the pointless reload when leaving the YouTube route.
const SUPPORT_KEY = 'piano2vision-isolation-support';
function rememberedSupport(): boolean | null {
  try {
    const v = localStorage.getItem(SUPPORT_KEY);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}
if (typeof window !== 'undefined' && loadedOnIsolatedRoute && window.isSecureContext) {
  try {
    localStorage.setItem(SUPPORT_KEY, documentIsolated() ? '1' : '0');
  } catch {
    /* storage blocked: we just reload a little more often */
  }
}

/**
 * Whether showing `pathname` in this document needs a full page load so the right headers apply.
 * - to the YouTube route: only when this document really is isolated (else the player embeds fine);
 * - from a non-isolated document (e.g. one loaded on the YouTube route) to an isolated route: to
 *   become isolated, unless this browser is known not to support it.
 */
export function needsDocumentSwitch(pathname: string): boolean {
  // (a document loaded on the YouTube route that is isolated anyway has a misconfigured server:
  // reloading would loop)
  if (isYouTubeImportPath(pathname)) return documentIsolated() && !isYouTubeImportPath(loadedAt);
  // a reload gains nothing on a route the server doesn't isolate, or in a document that already is
  if (!routeIsIsolated(pathname) || documentIsolated()) return false;
  // loaded on an isolated route and still not isolated: this browser doesn't support it
  if (loadedOnIsolatedRoute) return false;
  return rememberedSupport() !== false;
}

/**
 * Full page load of `href` in place of the current history entry (the SPA router has already
 * pushed the entry for the new route, so this keeps history at one entry per navigation).
 */
export function switchDocument(href: string): void {
  window.location.replace(href);
}

/** How many WASM threads a worker in this context can use (the rule the separation worker applies). */
export function wasmThreads(max = 4): number {
  if (!documentIsolated()) return 1;
  const cores = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
  return Math.max(1, Math.min(max, cores - 1));
}
