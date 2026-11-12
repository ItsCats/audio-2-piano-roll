/** Saved export settings from before the sound option still load, with the piano sound. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_EXPORT, type ExportSettings } from '../../src/lib/export/types';

// in-memory localStorage holding settings saved by an older version (no `sound`/`originalVolume`)
const store = new Map<string, string>();
const old: Partial<ExportSettings> = { ...DEFAULT_EXPORT, fps: 30, rate: 0.75 };
delete old.sound;
store.set('pianovision-settings', JSON.stringify({ state: { exportSettings: old, exportPresets: [{ id: 'p1', name: 'mine', settings: old }] }, version: 1 }));
const localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
Object.assign(globalThis, { window: { localStorage }, localStorage }); // zustand's persist reads window.localStorage
const { useSettings } = await import('../../src/state/settingsStore');

describe('persisted export settings', () => {
  it('old saved settings load with sound "piano" and keep their values', () => {
    const s = useSettings.getState().exportSettings;
    expect(s.sound).toBe('piano');
    expect(s.originalVolume).toBeUndefined();
    expect(s.fps).toBe(30);
    expect(s.rate).toBe(0.75);
  });

  it('an old saved preset applied as a patch keeps the current sound', () => {
    useSettings.getState().setExport({ sound: 'both' });
    useSettings.getState().setExport(useSettings.getState().exportPresets[0].settings);
    expect(useSettings.getState().exportSettings.sound).toBe('both');
  });

  it('a new choice is saved under the same key', () => {
    useSettings.getState().setExport({ sound: 'original', originalVolume: 0.5 });
    const saved = JSON.parse(store.get('pianovision-settings')!);
    expect(saved.state.exportSettings.sound).toBe('original');
    expect(saved.state.exportSettings.originalVolume).toBe(0.5);
  });
});
