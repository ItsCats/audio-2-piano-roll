/** Studio keyboard rules: one ← / → press seeks once, by the documented step. */
import { describe, expect, it } from 'vitest';
import { arrowSeekDelta, seekStepSeconds, shouldHandleGlobalKey, sliderSeekTarget } from '../../src/state/studioKeys';

const el = (matches: boolean) => ({ closest: () => (matches ? {} : null) }) as unknown as EventTarget;

describe('studio keys', () => {
  it('seeks 5 s, or 1 s with Shift', () => {
    expect(seekStepSeconds(false)).toBe(5);
    expect(seekStepSeconds(true)).toBe(1);
  });

  it('the page-wide handler skips keys another control already handled', () => {
    expect(shouldHandleGlobalKey({ defaultPrevented: true, target: el(false) })).toBe(false);
    expect(shouldHandleGlobalKey({ defaultPrevented: false, target: el(false) })).toBe(true);
  });

  it('the page-wide handler skips typing in text fields', () => {
    expect(shouldHandleGlobalKey({ defaultPrevented: false, target: el(true) })).toBe(false);
    expect(shouldHandleGlobalKey({ defaultPrevented: false, target: null })).toBe(true);
  });

  it('← / → seek by the step; Alt, Cmd and Ctrl combinations are left to the browser', () => {
    const k = (key: string, mods: Partial<{ shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }> = {}) =>
      arrowSeekDelta({ key, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...mods });
    expect(k('ArrowRight')).toBe(5);
    expect(k('ArrowLeft')).toBe(-5);
    expect(k('ArrowRight', { shiftKey: true })).toBe(1);
    expect(k('ArrowLeft', { shiftKey: true })).toBe(-1);
    expect(k('ArrowLeft', { altKey: true })).toBeNull(); // Back
    expect(k('ArrowRight', { altKey: true })).toBeNull(); // Forward
    expect(k('ArrowLeft', { metaKey: true })).toBeNull(); // Back on Mac
    expect(k('ArrowRight', { ctrlKey: true })).toBeNull();
    expect(k('ArrowUp')).toBeNull();
  });

  it('the full-screen position bar: arrows, Home / End, clamped; Alt, Cmd and Ctrl left to the browser', () => {
    const k = (key: string, mods: Partial<{ shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean }> = {}, time = 30) =>
      sliderSeekTarget({ key, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...mods }, time, 100);
    expect(k('ArrowRight')).toBe(35);
    expect(k('ArrowUp')).toBe(35);
    expect(k('ArrowLeft')).toBe(25);
    expect(k('ArrowDown', { shiftKey: true })).toBe(29);
    expect(k('Home')).toBe(0);
    expect(k('End')).toBe(100);
    expect(k('ArrowLeft', {}, 2)).toBe(0);
    expect(k('ArrowRight', {}, 98)).toBe(100);
    expect(k('ArrowLeft', { altKey: true })).toBeNull(); // Back
    expect(k('ArrowLeft', { metaKey: true })).toBeNull(); // Back on Mac
    expect(k('ArrowRight', { ctrlKey: true })).toBeNull();
    expect(k('Home', { metaKey: true })).toBeNull();
    expect(k('KeyF')).toBeNull();
  });
});
