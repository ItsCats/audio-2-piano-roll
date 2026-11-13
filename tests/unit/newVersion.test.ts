import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { entryScript, holdReload, isChunkLoadError, reloadHeldBy, reloadIfNewVersion } from '../../src/lib/newVersion';

describe('new version after a deploy', () => {
  it('finds the entry script of a built page', () => {
    const html = '<head><script type="module" crossorigin src="/assets/index-AbC123.js"></script><link rel="modulepreload" href="/assets/x.js"></head>';
    expect(entryScript(html)).toBe('/assets/index-AbC123.js');
    expect(entryScript('<script src="/assets/index-Z.js" type="module"></script>')).toBe('/assets/index-Z.js');
    // the development page has no built entry
    expect(entryScript('<script type="module" src="/src/main.tsx"></script>')).toBeNull();
  });

  it('recognises chunk-load failures of Chrome, Firefox and Safari', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/Studio-1.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module: https://x/assets/Studio-1.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/Studio-1.css'))).toBe(true);
    expect(isChunkLoadError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe('automatic reload after a deploy', () => {
  interface FakeEl {
    id: string;
    textContent: string;
    children: FakeEl[];
    style: { cssText: string };
    clicks: (() => void)[];
    setAttribute: () => void;
    appendChild: (c: FakeEl) => void;
    addEventListener: (type: string, fn: () => void) => void;
    remove: () => void;
  }
  const body: FakeEl[] = [];
  const el = (): FakeEl => {
    const e: FakeEl = {
      id: '',
      textContent: '',
      children: [],
      style: { cssText: '' },
      clicks: [],
      setAttribute: () => undefined,
      appendChild: (c) => void e.children.push(c),
      addEventListener: (_t, fn) => void e.clicks.push(fn),
      remove: () => {
        const i = body.indexOf(e);
        if (i >= 0) body.splice(i, 1);
      },
    };
    return e;
  };
  const text = (e: FakeEl): string => e.textContent + e.children.map(text).join(' ');
  const reload = vi.fn();
  const storage = new Map<string, string>();

  beforeEach(() => {
    vi.useFakeTimers();
    body.length = 0;
    storage.clear();
    reload.mockReset();
    vi.stubGlobal('document', {
      querySelector: () => ({ src: 'https://p2v.test/assets/index-OLD.js' }),
      createElement: el,
      getElementById: (id: string) => body.find((e) => e.id === id) ?? null,
      body: { appendChild: (e: FakeEl) => void body.push(e) },
    });
    vi.stubGlobal('location', { href: 'https://p2v.test/import', reload });
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v) });
    vi.stubGlobal('window', { setTimeout, clearTimeout });
    vi.stubGlobal('fetch', async () => new Response('<script type="module" crossorigin src="/assets/index-NEW.js"></script>'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('does not reload while an import or an unsaved recording holds it; offers "Reload" instead', async () => {
    let failedRecording = true;
    const release = holdReload(() => (failedRecording ? 'Download your recording first, then reload.' : null));
    expect(reloadHeldBy()).toBe('Download your recording first, then reload.');
    expect(await reloadIfNewVersion()).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(reload).not.toHaveBeenCalled();
    expect(storage.size).toBe(0); // no reload guard: the reload can still happen later
    expect(body).toHaveLength(1);
    expect(text(body[0])).toContain('A new version is available. Download your recording first, then reload.');
    expect(text(body[0])).toContain('Reload');
    // a second failure shows the same note, not a second one
    expect(await reloadIfNewVersion()).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(body).toHaveLength(1);
    // the user presses "Reload" when ready
    const reloadBtn = body[0].children[1].children[0];
    expect(reloadBtn.textContent).toBe('Reload');
    reloadBtn.clicks[0]();
    expect(reload).toHaveBeenCalledTimes(1);
    reload.mockReset();

    // recording saved (the error card dismissed): the next failure reloads by itself
    failedRecording = false;
    expect(reloadHeldBy()).toBeNull();
    expect(await reloadIfNewVersion()).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(reload).toHaveBeenCalledTimes(1);
    release();
  });

  it('a hold that throws does not block updates; released holds are gone', async () => {
    const r1 = holdReload(() => {
      throw new Error('broken');
    });
    const r2 = holdReload(() => 'Stop recording first, then reload.');
    expect(reloadHeldBy()).toBe('Stop recording first, then reload.');
    r2();
    expect(reloadHeldBy()).toBeNull();
    r1();
    expect(await reloadIfNewVersion()).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
