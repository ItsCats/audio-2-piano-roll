import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ROTATE_HINT_KEY,
  createAutoHide,
  dismissRotateHint,
  exitNativeFullscreen,
  fullscreenSupport,
  lockPageScroll,
  onFullscreenChange,
  requestNativeFullscreen,
  rotateHintDismissed,
  shouldShowRotateHint,
  coverViewport,
  createBackToExit,
  createTapGuard,
  isFullscreenKey,
} from '../../src/lib/fullscreen';

function fakeDoc(o: Record<string, unknown> = {}) {
  const listeners = new Map<string, Set<() => void>>();
  return {
    ...o,
    addEventListener: (t: string, l: () => void) => {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t)!.add(l);
    },
    removeEventListener: (t: string, l: () => void) => listeners.get(t)?.delete(l),
    fire: (t: string) => listeners.get(t)?.forEach((l) => l()),
    count: (t: string) => listeners.get(t)?.size ?? 0,
  };
}

describe('fullscreenSupport', () => {
  it('uses the standard API when it is enabled', () => {
    expect(fullscreenSupport(fakeDoc({ fullscreenEnabled: true }), { requestFullscreen: async () => {} })).toBe('standard');
  });
  it('falls back to the webkit-prefixed API (older Safari, iPad)', () => {
    expect(fullscreenSupport(fakeDoc({ webkitFullscreenEnabled: true }), { webkitRequestFullscreen: () => {} })).toBe('webkit');
  });
  it('reports none on iPhone Safari (no element full screen) and when disabled', () => {
    expect(fullscreenSupport(fakeDoc({}), {})).toBe('none');
    expect(fullscreenSupport(fakeDoc({ fullscreenEnabled: false }), { requestFullscreen: async () => {} })).toBe('none');
    expect(fullscreenSupport(fakeDoc({ fullscreenEnabled: true }), {})).toBe('none');
    expect(fullscreenSupport(undefined, undefined)).toBe('none');
  });
  it('never throws on odd objects', () => {
    const doc = fakeDoc();
    Object.defineProperty(doc, 'fullscreenEnabled', { get: () => { throw new Error('nope'); } });
    expect(fullscreenSupport(doc, {})).toBe('none');
  });
});

describe('requestNativeFullscreen / exit', () => {
  it('resolves true when the browser accepts, false when it refuses', async () => {
    const el = { requestFullscreen: async () => {} } as unknown as Element;
    expect(await requestNativeFullscreen(fakeDoc({ fullscreenEnabled: true }), el)).toBe(true);
    const bad = { requestFullscreen: () => Promise.reject(new TypeError('not allowed')) } as unknown as Element;
    expect(await requestNativeFullscreen(fakeDoc({ fullscreenEnabled: true }), bad)).toBe(false);
    expect(await requestNativeFullscreen(fakeDoc({}), {} as Element)).toBe(false);
  });
  it('waits for the webkit change event', async () => {
    const doc = fakeDoc({ webkitFullscreenEnabled: true, webkitFullscreenElement: null as unknown });
    const el = {
      webkitRequestFullscreen: () => {
        doc.webkitFullscreenElement = el;
        doc.fire('webkitfullscreenchange');
      },
    } as unknown as Element;
    expect(await requestNativeFullscreen(doc, el)).toBe(true);
    expect(doc.count('webkitfullscreenchange')).toBe(0);
  });
  it('exits only when something is full screen', () => {
    const exitFullscreen = vi.fn(async () => {});
    exitNativeFullscreen(fakeDoc({ fullscreenElement: null, exitFullscreen }));
    expect(exitFullscreen).not.toHaveBeenCalled();
    exitNativeFullscreen(fakeDoc({ fullscreenElement: {}, exitFullscreen }));
    expect(exitFullscreen).toHaveBeenCalledOnce();
    const webkitExitFullscreen = vi.fn();
    exitNativeFullscreen(fakeDoc({ webkitFullscreenElement: {}, webkitExitFullscreen }));
    expect(webkitExitFullscreen).toHaveBeenCalledOnce();
  });
  it('listens to both change events and unsubscribes', () => {
    const doc = fakeDoc();
    const cb = vi.fn();
    const off = onFullscreenChange(doc, cb);
    doc.fire('fullscreenchange');
    doc.fire('webkitfullscreenchange');
    expect(cb).toHaveBeenCalledTimes(2);
    off();
    doc.fire('fullscreenchange');
    expect(cb).toHaveBeenCalledTimes(2);
  });
});

describe('lockPageScroll', () => {
  it('stops scrolling and puts the old styles back exactly once', () => {
    const doc = {
      documentElement: { style: { overflow: '', overscrollBehavior: 'auto' } },
      body: { style: { overflow: 'hidden', overscrollBehavior: '' } },
    };
    const unlock = lockPageScroll(doc);
    expect(doc.documentElement.style).toEqual({ overflow: 'hidden', overscrollBehavior: 'none' });
    expect(doc.body.style).toEqual({ overflow: 'hidden', overscrollBehavior: 'none' });
    unlock();
    expect(doc.documentElement.style).toEqual({ overflow: '', overscrollBehavior: 'auto' });
    expect(doc.body.style).toEqual({ overflow: 'hidden', overscrollBehavior: '' });
    doc.documentElement.style.overflow = 'scroll';
    unlock();
    expect(doc.documentElement.style.overflow).toBe('scroll');
  });
});

describe('createAutoHide', () => {
  afterEach(() => vi.useRealTimers());
  const setup = () => {
    vi.useFakeTimers();
    const changes: boolean[] = [];
    const a = createAutoHide((v) => changes.push(v), 3000);
    return { a, changes };
  };

  it('stays visible while paused', () => {
    const { a, changes } = setup();
    a.poke();
    vi.advanceTimersByTime(10000);
    expect(a.visible).toBe(true);
    a.hide();
    expect(a.visible).toBe(true);
    expect(changes).toEqual([]);
  });
  it('hides 3 s after the last touch while playing; a touch restarts the countdown', () => {
    const { a, changes } = setup();
    a.setPlaying(true);
    vi.advanceTimersByTime(2900);
    expect(a.visible).toBe(true);
    a.poke();
    vi.advanceTimersByTime(2900);
    expect(a.visible).toBe(true);
    vi.advanceTimersByTime(200);
    expect(a.visible).toBe(false);
    a.poke();
    expect(a.visible).toBe(true);
    expect(changes).toEqual([false, true]);
  });
  it('pausing shows the controls and keeps them up', () => {
    const { a } = setup();
    a.setPlaying(true);
    vi.advanceTimersByTime(3100);
    expect(a.visible).toBe(false);
    a.setPlaying(false);
    expect(a.visible).toBe(true);
    vi.advanceTimersByTime(10000);
    expect(a.visible).toBe(true);
  });
  it('never hides while held (dragging the seek bar, a menu open)', () => {
    const { a } = setup();
    a.setPlaying(true);
    a.setHeld(true);
    vi.advanceTimersByTime(10000);
    a.hide();
    expect(a.visible).toBe(true);
    a.setHeld(false);
    vi.advanceTimersByTime(3100);
    expect(a.visible).toBe(false);
  });
  it('hide() works at once while playing; stop() cancels the countdown', () => {
    const { a } = setup();
    a.setPlaying(true);
    a.hide();
    expect(a.visible).toBe(false);
    a.poke();
    a.stop();
    vi.advanceTimersByTime(10000);
    expect(a.visible).toBe(true);
  });
});

describe('rotate hint', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };
  it('is remembered under its own key', () => {
    const s = memory();
    expect(rotateHintDismissed(s)).toBe(false);
    dismissRotateHint(s);
    expect(rotateHintDismissed(s)).toBe(true);
    expect([...s.m.keys()]).toEqual([ROTATE_HINT_KEY]);
    expect(ROTATE_HINT_KEY).not.toMatch(/^(pianovision-settings|piano2vision-import-prefs)$/);
  });
  it('survives storage that throws or is missing', () => {
    const broken = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceededError'); },
    };
    expect(rotateHintDismissed(broken)).toBe(false);
    expect(() => dismissRotateHint(broken)).not.toThrow();
    expect(rotateHintDismissed(null)).toBe(false);
    expect(() => dismissRotateHint(null)).not.toThrow();
  });
  it('shows only in full screen, upright, on a phone (not a tablet), with keys on screen, until dismissed', () => {
    const base = { active: true, portrait: true, phone: true, dismissed: false, keys: true };
    expect(shouldShowRotateHint(base)).toBe(true);
    expect(shouldShowRotateHint({ ...base, active: false })).toBe(false);
    expect(shouldShowRotateHint({ ...base, portrait: false })).toBe(false);
    expect(shouldShowRotateHint({ ...base, phone: false })).toBe(false);
    expect(shouldShowRotateHint({ ...base, dismissed: true })).toBe(false);
    expect(shouldShowRotateHint({ ...base, keys: false })).toBe(false); // sheet music: no keyboard
  });
});

describe('createTapGuard (a tap that reveals the controls presses nothing)', () => {
  it('swallows the click that follows a swallowed pointerdown, once', () => {
    let t = 0;
    const g = createTapGuard(1000, () => t);
    g.pointerDown(true);
    t = 120;
    expect(g.swallowClick(1)).toBe(true);
    expect(g.swallowClick(1)).toBe(false);
  });
  it('lets clicks through after a normal tap, from the keyboard, or long after', () => {
    let t = 0;
    const g = createTapGuard(1000, () => t);
    g.pointerDown(false);
    expect(g.swallowClick(1)).toBe(false);
    g.pointerDown(true);
    expect(g.swallowClick(0)).toBe(false); // Enter on a focused button
    g.pointerDown(true);
    t = 5000;
    expect(g.swallowClick(1)).toBe(false);
  });
  it('a later normal tap clears a pending swallow (no click came)', () => {
    const g = createTapGuard(1000, () => 0);
    g.pointerDown(true);
    g.pointerDown(false);
    expect(g.swallowClick(1)).toBe(false);
  });
});

describe('coverViewport', () => {
  const doc = (content: string | null) => {
    const attrs = new Map<string, string>();
    if (content !== null) attrs.set('content', content);
    const meta = { getAttribute: (k: string) => attrs.get(k) ?? null, setAttribute: (k: string, v: string) => void attrs.set(k, v) };
    return { querySelector: () => (content === null ? null : meta), meta } as unknown as Document & { meta: typeof meta };
  };
  it('adds viewport-fit=cover and puts the tag back', () => {
    const d = doc('width=device-width, initial-scale=1.0');
    const undo = coverViewport(d);
    expect((d as unknown as { meta: { getAttribute(k: string): string } }).meta.getAttribute('content')).toBe('width=device-width, initial-scale=1.0, viewport-fit=cover');
    undo();
    expect((d as unknown as { meta: { getAttribute(k: string): string } }).meta.getAttribute('content')).toBe('width=device-width, initial-scale=1.0');
  });
  it('does nothing without a viewport tag', () => {
    expect(() => coverViewport(doc(null))()).not.toThrow();
  });
});

describe('createBackToExit', () => {
  function fakeWin() {
    const stack: unknown[] = [{ idx: 3, key: 'k' }];
    let i = 0;
    const pop = new Set<() => void>();
    const win = {
      history: {
        get state() {
          return stack[i];
        },
        pushState(state: unknown) {
          stack.splice(i + 1);
          stack.push(state);
          i++;
        },
        back() {
          if (i > 0) i--;
          pop.forEach((l) => l());
        },
      },
      addEventListener: (_: string, l: () => void) => void pop.add(l),
      removeEventListener: (_: string, l: () => void) => void pop.delete(l),
    };
    return { win, stack, at: () => i, listeners: () => pop.size };
  }
  it('back leaves full screen and stays on the page', () => {
    const w = fakeWin();
    const onBack = vi.fn();
    const h = createBackToExit(w.win, onBack);
    expect(w.stack).toHaveLength(2);
    expect(w.win.history.state).toMatchObject({ idx: 3, key: 'k' }); // the router's own state is kept
    w.win.history.back();
    expect(onBack).toHaveBeenCalledTimes(1);
    h.release();
    expect(w.at()).toBe(0); // no second step back
    expect(w.listeners()).toBe(0);
  });
  it('leaving by the button removes the extra entry', () => {
    const w = fakeWin();
    const onBack = vi.fn();
    createBackToExit(w.win, onBack).release();
    expect(w.at()).toBe(0);
    expect(onBack).not.toHaveBeenCalled();
  });
});

describe('isFullscreenKey', () => {
  const key = (o: Partial<KeyboardEvent> = {}) => ({ code: 'KeyF', repeat: false, ctrlKey: false, metaKey: false, altKey: false, ...o });
  const noDialog = { querySelector: () => null } as unknown as Document;
  const dialog = { querySelector: () => ({}) } as unknown as Document;
  it('F alone toggles', () => expect(isFullscreenKey(key(), noDialog)).toBe(true));
  it('not when held, with a modifier, another key, or while a dialog is open', () => {
    expect(isFullscreenKey(key({ repeat: true }), noDialog)).toBe(false);
    expect(isFullscreenKey(key({ ctrlKey: true }), noDialog)).toBe(false);
    expect(isFullscreenKey(key({ metaKey: true }), noDialog)).toBe(false);
    expect(isFullscreenKey(key({ altKey: true }), noDialog)).toBe(false);
    expect(isFullscreenKey(key({ code: 'KeyG' }), noDialog)).toBe(false);
    expect(isFullscreenKey(key(), dialog)).toBe(false);
  });
});
