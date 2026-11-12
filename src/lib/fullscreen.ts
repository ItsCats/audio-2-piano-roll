/**
 * Full-screen helpers for the Studio's piano roll (src/components/studio/FullscreenStage.tsx).
 *
 * The real Fullscreen API works on desktop browsers, Android and iPad (webkit-prefixed on older
 * Safari), but iPhone Safari only allows it on <video>. There the stage falls back to a fixed layer
 * that covers the whole viewport ("pseudo" full screen). Everything here is feature-detected and
 * never throws.
 */

export type FullscreenSupport = 'standard' | 'webkit' | 'none';
/** off, the real Fullscreen API, or the fixed full-viewport layer used where that API is missing */
export type FullscreenMode = 'off' | 'native' | 'pseudo';

/* The parts of Document / Element used here, so tests can pass plain objects. */
export interface FullscreenDocumentLike {
  fullscreenEnabled?: boolean;
  webkitFullscreenEnabled?: boolean;
  fullscreenElement?: Element | null;
  webkitFullscreenElement?: Element | null;
  exitFullscreen?: () => Promise<void>;
  webkitExitFullscreen?: () => void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
export interface FullscreenElementLike {
  requestFullscreen?: (options?: FullscreenOptions) => Promise<void>;
  webkitRequestFullscreen?: () => void;
}

/** Which Fullscreen API this browser offers for `el` (iPhone Safari: none). */
export function fullscreenSupport(doc: FullscreenDocumentLike | undefined, el: FullscreenElementLike | undefined): FullscreenSupport {
  try {
    if (!doc || !el) return 'none';
    if (doc.fullscreenEnabled === true && typeof el.requestFullscreen === 'function') return 'standard';
    if (doc.webkitFullscreenEnabled === true && typeof el.webkitRequestFullscreen === 'function') return 'webkit';
  } catch {
    /* fall through */
  }
  return 'none';
}

export function currentFullscreenElement(doc: FullscreenDocumentLike): Element | null {
  try {
    return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
  } catch {
    return null;
  }
}

/**
 * Asks for real full screen on `el`. Must be called straight from a user gesture (tap, click, key).
 * Resolves true once `el` is full screen, false if the browser refused (then use the pseudo mode).
 */
export function requestNativeFullscreen(doc: FullscreenDocumentLike, el: FullscreenElementLike & Element): Promise<boolean> {
  const support = fullscreenSupport(doc, el);
  try {
    if (support === 'standard') {
      return el.requestFullscreen!({ navigationUI: 'hide' }).then(
        () => true,
        () => false,
      );
    }
    if (support === 'webkit') {
      // old Safari: no promise, wait for the change or error event
      return new Promise((resolve) => {
        const done = () => {
          doc.removeEventListener('webkitfullscreenchange', done);
          doc.removeEventListener('webkitfullscreenerror', done);
          clearTimeout(timer);
          resolve(currentFullscreenElement(doc) === el);
        };
        const timer = setTimeout(done, 1500);
        doc.addEventListener('webkitfullscreenchange', done);
        doc.addEventListener('webkitfullscreenerror', done);
        el.webkitRequestFullscreen!();
      });
    }
  } catch {
    /* refused synchronously */
  }
  return Promise.resolve(false);
}

export function exitNativeFullscreen(doc: FullscreenDocumentLike): void {
  try {
    if (!currentFullscreenElement(doc)) return;
    if (typeof doc.exitFullscreen === 'function') void doc.exitFullscreen().catch(() => {});
    else doc.webkitExitFullscreen?.();
  } catch {
    /* already left */
  }
}

/** Calls `cb` whenever the document enters or leaves real full screen (also via Esc or a system gesture). */
export function onFullscreenChange(doc: FullscreenDocumentLike, cb: () => void): () => void {
  doc.addEventListener('fullscreenchange', cb);
  doc.addEventListener('webkitfullscreenchange', cb);
  return () => {
    doc.removeEventListener('fullscreenchange', cb);
    doc.removeEventListener('webkitfullscreenchange', cb);
  };
}

interface StyleLike {
  overflow: string;
  overscrollBehavior: string;
}
/**
 * Stops the page from scrolling or rubber-banding (iPhone) while the full-viewport layer is up.
 * Returns a function that puts the previous inline styles back.
 */
export function lockPageScroll(doc: { documentElement: { style: StyleLike }; body: { style: StyleLike } | null }): () => void {
  const targets = [doc.documentElement.style, doc.body?.style].filter((s): s is StyleLike => !!s);
  const saved = targets.map((s) => ({ overflow: s.overflow, overscrollBehavior: s.overscrollBehavior }));
  for (const s of targets) {
    s.overflow = 'hidden';
    s.overscrollBehavior = 'none';
  }
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    targets.forEach((s, i) => {
      s.overflow = saved[i].overflow;
      s.overscrollBehavior = saved[i].overscrollBehavior;
    });
  };
}

/* ---------------- auto-hiding controls ---------------- */

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}
const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface AutoHide {
  readonly visible: boolean;
  /** the user touched or moved something: show the controls and restart the countdown */
  poke(): void;
  /** controls hide only while playing; pausing shows them and keeps them up */
  setPlaying(playing: boolean): void;
  /** while held (dragging the seek bar, a menu open) they never hide */
  setHeld(held: boolean): void;
  /** hide now (a tap on the notes while playing); ignored while paused or held */
  hide(): void;
  /** cancel the countdown (unmount); the object stays usable */
  stop(): void;
}

/** Controls that fade out after `delay` ms without a touch while the song plays. */
export function createAutoHide(onChange: (visible: boolean) => void, delay = 3000, timers: Timers = realTimers): AutoHide {
  let visible = true;
  let playing = false;
  let held = false;
  let timer: unknown = null;
  const set = (v: boolean) => {
    if (v === visible) return;
    visible = v;
    onChange(v);
  };
  const clear = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
  };
  const schedule = () => {
    clear();
    if (!playing || held) return;
    timer = timers.set(() => {
      timer = null;
      set(false);
    }, delay);
  };
  return {
    get visible() {
      return visible;
    },
    poke() {
      set(true);
      schedule();
    },
    setPlaying(p) {
      playing = p;
      if (!p) set(true);
      schedule();
    },
    setHeld(h) {
      held = h;
      if (h) set(true);
      schedule();
    },
    hide() {
      if (!playing || held) return;
      clear();
      set(false);
    },
    stop() {
      clear();
    },
  };
}

/* ---------------- "turn your phone sideways" hint ---------------- */

/** localStorage key: the portrait hint was dismissed (new key; the app's other keys are unchanged) */
export const ROTATE_HINT_KEY = 'piano2vision-fullscreen-hint';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // blocked storage throws on access
  }
}

export function rotateHintDismissed(storage: StorageLike | null = defaultStorage()): boolean {
  try {
    return storage?.getItem(ROTATE_HINT_KEY) === 'dismissed';
  } catch {
    return false;
  }
}

export function dismissRotateHint(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(ROTATE_HINT_KEY, 'dismissed');
  } catch {
    /* private mode / full storage: the hint just shows again next time */
  }
}

/** Show the hint in full screen on a phone held upright (not a tablet), until it was dismissed once. */
export function shouldShowRotateHint(o: { active: boolean; portrait: boolean; phone: boolean; dismissed: boolean }): boolean {
  return o.active && o.portrait && o.phone && !o.dismissed;
}

/** A phone-sized touch screen (either orientation): fit the keyboard to the song there. */
export function isSmallTouchScreen(): boolean {
  try {
    if (!window.matchMedia?.('(pointer: coarse)').matches) return false;
    return Math.min(window.screen.width, window.screen.height) < 600;
  } catch {
    return false;
  }
}

/* ---------------- taps that reveal the controls ---------------- */

/**
 * A tap that only brings the hidden controls back must not also press the control that appears
 * under the finger: browsers pick the click's target after the controls are back, and cancelling
 * pointerdown does not cancel that click. Call `pointerDown` on every pointerdown (true when that
 * tap was swallowed) and ask `swallowClick` on the click that follows.
 */
export function createTapGuard(windowMs = 1000, now: () => number = () => Date.now()) {
  let until = 0;
  return {
    pointerDown(swallowed: boolean) {
      until = swallowed ? now() + windowMs : 0;
    },
    /** `detail` is the click's count: 0 for clicks from the keyboard (Enter / Space), never swallowed */
    swallowClick(detail: number): boolean {
      if (!until || detail === 0) return false;
      const hit = now() <= until;
      until = 0;
      return hit;
    },
  };
}

/* ---------------- the rest of the page while full screen ---------------- */

/**
 * Makes everything outside `el` inert (no focus, no taps, hidden from screen readers) while `el`
 * covers the page, so Tab does not move focus behind it. Live regions (toasts) stay as they are.
 * Returns a function that undoes exactly what it changed.
 */
export function inertOutside(el: Element): () => void {
  const changed: Element[] = [];
  try {
    for (let node: Element | null = el; node && node.parentElement; node = node.parentElement) {
      for (const sib of Array.from(node.parentElement.children)) {
        if (sib === node || sib.hasAttribute('inert') || sib.hasAttribute('aria-live')) continue;
        if (sib.tagName === 'SCRIPT' || sib.tagName === 'STYLE') continue;
        sib.setAttribute('inert', '');
        changed.push(sib);
      }
      if (node.parentElement === document.body) break;
    }
  } catch {
    /* not in a document */
  }
  return () => changed.forEach((s) => s.removeAttribute('inert'));
}

/**
 * iPhone: while the fixed layer is up, let it reach under the notch and home indicator
 * (viewport-fit=cover); the stage pads its content with env(safe-area-inset-*). Only for the
 * full-screen layer, so the rest of the app keeps its normal safe area. Returns the undo.
 */
export function coverViewport(doc: Pick<Document, 'querySelector'>): () => void {
  try {
    const meta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!meta) return () => {};
    const before = meta.getAttribute('content') ?? '';
    if (/viewport-fit\s*=\s*cover/.test(before)) return () => {};
    const parts = before.split(',').map((p) => p.trim()).filter((p) => p && !/^viewport-fit\s*=/.test(p));
    meta.setAttribute('content', [...parts, 'viewport-fit=cover'].join(', '));
    return () => meta.setAttribute('content', before);
  } catch {
    return () => {};
  }
}

/* ---------------- the back gesture ---------------- */

const HISTORY_MARK = 'p2vFullscreen';
type HistoryWindow = Pick<Window, 'addEventListener' | 'removeEventListener'> & { history: Pick<History, 'state' | 'pushState' | 'back'> };
const marked = (state: unknown) => !!state && typeof state === 'object' && (state as Record<string, unknown>)[HISTORY_MARK] === true;

/**
 * iPhone (fixed layer): "back" (the edge swipe) should leave full screen, not the page. Adds a
 * history entry for the same URL; going back from it calls `onBack`. `release` removes the
 * listener and, if that entry is still current (left by the button), steps back over it.
 */
export function createBackToExit(win: HistoryWindow, onBack: () => void): { release(): void } {
  try {
    const prev = win.history.state;
    win.history.pushState({ ...(prev && typeof prev === 'object' ? prev : {}), [HISTORY_MARK]: true }, '');
  } catch {
    return { release() {} };
  }
  const onPop = () => {
    if (!marked(win.history.state)) onBack();
  };
  win.addEventListener('popstate', onPop);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      win.removeEventListener('popstate', onPop);
      try {
        if (marked(win.history.state)) win.history.back();
      } catch {
        /* ignore */
      }
    },
  };
}

/* ---------------- the F key ---------------- */

/** Should this key press toggle full screen? Not while held down, with a modifier, or over a dialog. */
export function isFullscreenKey(
  e: Pick<KeyboardEvent, 'code' | 'repeat' | 'ctrlKey' | 'metaKey' | 'altKey'>,
  doc: Pick<Document, 'querySelector'> | null = typeof document !== 'undefined' ? document : null,
): boolean {
  if (e.code !== 'KeyF' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return false;
  try {
    return !doc?.querySelector('[aria-modal="true"]');
  } catch {
    return true;
  }
}
