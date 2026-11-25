import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** a theme-color <meta>, with or without a media="(prefers-color-scheme: …)" */
const fakeMeta = (media?: string) => ({ content: '#0b0b0f', getAttribute: (n: string) => (n === 'media' ? (media ?? null) : null) });

/** a tiny stand-in for <html>, the theme-color <meta>(s), localStorage and the dark-mode query */
function fakePage(dark: boolean, metas = [fakeMeta()]) {
  const root = { dataset: {} as Record<string, string> };
  const meta = metas[0];
  const store = new Map<string, string>([
    ['piano2vision-skin', 'editorial'],
    ['pianovision-settings', '{"keep":true}'],
    ['piano2vision-import-prefs', '{"keep":true}'],
  ]);
  const listeners: (() => void)[] = [];
  const query = { matches: dark, addEventListener: (_: string, f: () => void) => listeners.push(f) };
  vi.stubGlobal('document', { documentElement: root, querySelectorAll: () => metas });
  vi.stubGlobal('window', { matchMedia: () => query });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  return { root, meta, store, query, listeners };
}

describe('the site look (Studio keeps its own)', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it('is on outside the Studio and off in the Studio, with a matching browser bar color', async () => {
    const page = fakePage(false);
    const { applySiteLook } = await import('../../src/lib/siteLook');
    applySiteLook(false);
    expect('site' in page.root.dataset).toBe(true);
    expect(page.meta.content).toBe('#faf9f6');
    applySiteLook(true);
    expect('site' in page.root.dataset).toBe(false);
    expect(page.meta.content).toBe('#0b0b0f');
    applySiteLook(false);
    expect('site' in page.root.dataset).toBe(true);
  });

  it('follows dark mode, also when it changes while the page is open', async () => {
    const page = fakePage(true);
    const { applySiteLook } = await import('../../src/lib/siteLook');
    applySiteLook(false);
    expect(page.meta.content).toBe('#111110');
    page.query.matches = false;
    page.listeners.forEach((f) => f());
    expect(page.meta.content).toBe('#faf9f6');
  });

  it('sets the light and the dark-mode bar color of index.html, and the Studio dark on both', async () => {
    const light = fakeMeta('(prefers-color-scheme: light)');
    const dark = fakeMeta('(prefers-color-scheme: dark)');
    fakePage(false, [light, dark]);
    const { applySiteLook } = await import('../../src/lib/siteLook');
    applySiteLook(false);
    expect([light.content, dark.content]).toEqual(['#faf9f6', '#111110']);
    applySiteLook(true);
    expect([light.content, dark.content]).toEqual(['#0b0b0f', '#0b0b0f']);
    applySiteLook(false);
    expect([light.content, dark.content]).toEqual(['#faf9f6', '#111110']);
  });

  it('forgets the try-out choice and nothing else', async () => {
    const page = fakePage(false);
    const { forgetOldSkin } = await import('../../src/lib/siteLook');
    forgetOldSkin();
    expect(page.store.has('piano2vision-skin')).toBe(false);
    expect(page.store.get('pianovision-settings')).toBe('{"keep":true}');
    expect(page.store.get('piano2vision-import-prefs')).toBe('{"keep":true}');
    // blocked storage: no error
    vi.stubGlobal('localStorage', {
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => forgetOldSkin()).not.toThrow();
  });
});
