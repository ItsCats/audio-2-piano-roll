import { describe, expect, it } from 'vitest';
import { DEFAULT_VISUAL, VISUAL_THEMES, applyTheme, type VisualSettings } from '../../src/lib/render/settings';

const apply = (v: VisualSettings, ...ids: string[]) => ids.reduce((acc, id) => applyTheme(acc, id), v);

describe('themes', () => {
  it('give the same result regardless of the previous theme', () => {
    const keys = ['fallingGlow', 'noteBrightness', 'keyboardStyle', 'colorMode', 'rightColor', 'leftColor', 'glow'] as const;
    for (const t of VISUAL_THEMES) {
      const fresh = apply(DEFAULT_VISUAL, t.id);
      for (const prev of VISUAL_THEMES) {
        const after = apply(DEFAULT_VISUAL, prev.id, t.id);
        for (const k of keys) expect([t.id, prev.id, k, after[k]]).toEqual([t.id, prev.id, k, fresh[k]]);
        expect(after.decal.source).toBe(fresh.decal.source);
        expect(after.effects).toEqual(fresh.effects);
        expect(after.labels.style).toBe(fresh.labels.style);
      }
    }
  });
  it('do not leak Blossom / Mono glow into classic themes', () => {
    expect(apply(DEFAULT_VISUAL, 'blossom', 'studio').fallingGlow).toBe(DEFAULT_VISUAL.fallingGlow);
    expect(apply(DEFAULT_VISUAL, 'mono', 'aurora').noteBrightness).toBe(DEFAULT_VISUAL.noteBrightness);
  });
  it('keep the user’s own label style when switching between classic themes', () => {
    const v = { ...DEFAULT_VISUAL, labels: { ...DEFAULT_VISUAL.labels, style: 'solfege' as const, showOnKeys: false } };
    const after = apply(v, 'aurora', 'sunset');
    expect(after.labels.style).toBe('solfege');
    expect(after.labels.showOnKeys).toBe(false);
  });
  it('bring labels back after a theme that hid them', () => {
    const blossom = apply(DEFAULT_VISUAL, 'blossom');
    expect(blossom.labels.style).toBe('none');
    const back = applyTheme(blossom, 'studio');
    expect(back.labels.style).toBe('letter');
    expect(back.labels.showOnKeys).toBe(true);
  });
  it('respect labels the user turned off themselves', () => {
    const v = { ...DEFAULT_VISUAL, labels: { ...DEFAULT_VISUAL.labels, style: 'none' as const }, labelsHiddenByTheme: false };
    expect(applyTheme(v, 'aurora').labels.style).toBe('none');
  });
});
