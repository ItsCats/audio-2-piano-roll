/** Settings saved before sheet music existed still load, and get the sheet defaults. */
import { describe, expect, it, vi } from 'vitest';

describe('settings', () => {
  it('loads old saved settings without `sheet`', async () => {
    const store = new Map<string, string>();
    store.set('pianovision-settings', JSON.stringify({ state: { defaultDifficulty: 'hard', practice: { countIn: true } }, version: 1 }));
    const localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    vi.stubGlobal('localStorage', localStorage);
    vi.stubGlobal('window', { localStorage }); // zustand's persist reads window.localStorage
    const { useSettings, DEFAULT_SHEET } = await import('../../src/state/settingsStore');
    const s = useSettings.getState();
    expect(s.defaultDifficulty).toBe('hard');
    expect(s.practice.countIn).toBe(true);
    expect(s.sheet).toEqual(DEFAULT_SHEET);
    s.setSheet({ view: 'sheet', zoom: 0.8 });
    expect(useSettings.getState().sheet).toEqual({ ...DEFAULT_SHEET, view: 'sheet', zoom: 0.8 });
    const saved = JSON.parse(store.get('pianovision-settings')!);
    expect(saved.version).toBe(1);
    expect(saved.state.sheet.view).toBe('sheet');
    // a partial `sheet` from a later version merges over the defaults
    const merged = useSettings.persist.getOptions().merge!({ sheet: { follow: false } }, useSettings.getState()) as ReturnType<typeof useSettings.getState>;
    expect(merged.sheet).toEqual({ ...DEFAULT_SHEET, view: 'sheet', zoom: 0.8, follow: false });
    vi.unstubAllGlobals();
  });
});
