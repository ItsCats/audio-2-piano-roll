import { describe, expect, it } from 'vitest';
import { migrateSettings } from '../../src/state/settingsStore';

describe('settings migration (default level → Hard)', () => {
  it('moves the old default, Medium, to Hard', () => {
    expect(migrateSettings({ defaultDifficulty: 'medium', backendUrl: 'x' }, 1)).toEqual({ defaultDifficulty: 'hard', backendUrl: 'x' });
    expect(migrateSettings({ defaultDifficulty: 'medium' }, 0)).toEqual({ defaultDifficulty: 'hard' });
  });
  it('keeps Easy and Hard, and leaves current-version settings alone', () => {
    expect(migrateSettings({ defaultDifficulty: 'easy' }, 1)).toEqual({ defaultDifficulty: 'easy' });
    expect(migrateSettings({ defaultDifficulty: 'hard' }, 1)).toEqual({ defaultDifficulty: 'hard' });
    expect(migrateSettings({ defaultDifficulty: 'medium' }, 2)).toEqual({ defaultDifficulty: 'medium' });
  });
  it('copes with missing or broken saved data', () => {
    expect(migrateSettings(undefined, 1)).toEqual({ defaultDifficulty: 'hard' });
    expect(migrateSettings(null, 1)).toEqual({ defaultDifficulty: 'hard' });
  });
});
