/**
 * A tab opened before a deploy still runs the old version. When it then loads a part of the app
 * it has not loaded yet (a page, the sheet-music reader, a worker), that file is gone from the
 * server (netlify.toml answers 404 for missing /assets files). We then check that a new version
 * really is online and reload once, with a short note. Without a new version (offline, a flaky
 * connection, a real bug) nothing reloads and the normal error handling shows the problem.
 */

const GUARD_KEY = 'pv-update-reload';
/** after an automatic reload, don't reload again for this long (no reload loops) */
const GUARD_MS = 10 * 60 * 1000;

/** The entry script of a built page ("/assets/index-<hash>.js"); null in development. */
export function entryScript(html: string): string | null {
  const m = /<script[^>]+type="module"[^>]+src="([^"]*\/assets\/[^"]+\.js)"/.exec(html) ?? /<script[^>]+src="([^"]*\/assets\/[^"]+\.js)"[^>]+type="module"/.exec(html);
  return m ? m[1] : null;
}

function currentEntry(): string | null {
  const el = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]');
  return el ? new URL(el.src, location.href).pathname : null;
}

/** Is a different version of the app online than the one running in this tab? */
export async function newVersionOnline(): Promise<boolean> {
  const mine = currentEntry();
  if (!mine) return false; // development server
  try {
    const res = await fetch('/', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) return false;
    const online = entryScript(await res.text());
    return !!online && new URL(online, location.href).pathname !== mine;
  } catch {
    return false; // offline: not a new version
  }
}

function guardActive(now: number): boolean {
  try {
    const at = Number(sessionStorage.getItem(GUARD_KEY));
    return Number.isFinite(at) && at > 0 && now - at < GUARD_MS;
  } catch {
    return false;
  }
}

function setGuard(now: number): boolean {
  try {
    sessionStorage.setItem(GUARD_KEY, String(now));
    return true;
  } catch {
    return false; // storage blocked: reloading could loop, so don't
  }
}

function showNote(text: string) {
  const el = document.createElement('div');
  el.setAttribute('role', 'status');
  el.textContent = text;
  el.style.cssText =
    'position:fixed;left:50%;top:max(16px,env(safe-area-inset-top));transform:translateX(-50%);z-index:2147483647;' +
    'max-width:calc(100vw - 32px);padding:10px 16px;border-radius:12px;background:#1d1d27;color:#f4f4f6;' +
    'font:500 14px/1.4 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5);border:1px solid #33333f;text-align:center';
  document.body.appendChild(el);
}

let checking: Promise<boolean> | null = null;

/**
 * After a failed load of a part of the app: if a new version is online, say so and reload once.
 * Resolves true when the page is about to reload.
 */
export function reloadIfNewVersion(): Promise<boolean> {
  checking ??= (async () => {
    if (guardActive(Date.now())) return false;
    if (!(await newVersionOnline())) return false;
    if (!setGuard(Date.now())) return false;
    showNote('A new version is available — reloading');
    window.setTimeout(() => location.reload(), 900);
    return true;
  })().finally(() => {
    window.setTimeout(() => (checking = null), 5000);
  });
  return checking;
}

/** Messages browsers give when a script module / chunk could not be fetched. */
export function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err ?? '');
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|ChunkLoadError|Loading chunk \S+ failed/i.test(msg);
}

/** Watch a worker: a worker script that fails to load (gone after a deploy) checks for a new version. */
export function watchWorker<W extends Worker>(worker: W): W {
  if (typeof worker.addEventListener !== 'function') return worker; // test doubles
  worker.addEventListener('error', (e) => {
    // a load failure carries no message; errors thrown inside the worker do
    if (!(e as ErrorEvent).message) void reloadIfNewVersion();
  });
  return worker;
}

/** Install once at startup (main.tsx). */
export function installNewVersionReload(): void {
  // Vite: a lazily loaded part of the app (or its CSS) failed to load
  window.addEventListener('vite:preloadError', () => void reloadIfNewVersion());
  // the same failure from an import() Vite does not wrap
  window.addEventListener('unhandledrejection', (e) => {
    if (isChunkLoadError(e.reason)) void reloadIfNewVersion();
  });
}
