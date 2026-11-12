/** Studio keyboard rules: one ← / → press seeks once, by the documented step. */
import { describe, expect, it } from 'vitest';
import { seekStepSeconds, shouldHandleGlobalKey } from '../../src/state/studioKeys';

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
});
