/**
 * Keep the screen on while something long runs (an import's analysis): a locked phone suspends the
 * page, and iOS may then discard the tab. Screen Wake Lock API (Chrome 84+, Safari / iOS 16.4+).
 * The browser drops the lock whenever the page is hidden; it is taken again when the page is visible
 * and still wants it. Feature-detected; never throws.
 */

export interface WakeLockSentinelLike {
  readonly released?: boolean;
  release(): Promise<void>;
  addEventListener?(type: 'release', listener: () => void): void;
}

export interface WakeLockNavigatorLike {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> };
}

export interface VisibilityDocumentLike {
  readonly visibilityState: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface ScreenWakeLock {
  /** the API exists here */
  readonly supported: boolean;
  /** a lock is held right now */
  readonly active: boolean;
  /** want the screen kept on (true) or not any more (false); resolves once the request settled */
  hold(on: boolean): Promise<void>;
}

export function createScreenWakeLock(
  nav: WakeLockNavigatorLike | undefined = typeof navigator !== 'undefined' ? (navigator as WakeLockNavigatorLike) : undefined,
  doc: VisibilityDocumentLike | undefined = typeof document !== 'undefined' ? document : undefined,
): ScreenWakeLock {
  let supported = false;
  try {
    supported = typeof nav?.wakeLock?.request === 'function';
  } catch {
    supported = false;
  }
  let wanted = false;
  let sentinel: WakeLockSentinelLike | null = null;
  let requesting: Promise<void> | null = null;

  const held = () => !!sentinel && !sentinel.released;

  const acquire = (): Promise<void> => {
    if (!supported || !wanted || held()) return Promise.resolve();
    if (requesting) return requesting;
    try {
      if (doc && doc.visibilityState !== 'visible') return Promise.resolve();
    } catch {
      /* no visibility info: just try */
    }
    requesting = (async () => {
      try {
        const s = await nav!.wakeLock!.request('screen');
        if (!wanted) {
          // released while the request was in flight
          await s.release().catch(() => undefined);
          return;
        }
        sentinel = s;
        try {
          s.addEventListener?.('release', () => {
            if (sentinel === s) sentinel = null;
          });
        } catch {
          /* ignore */
        }
      } catch {
        // denied (not visible, no user activation, battery saver, policy): nothing to do
      } finally {
        requesting = null;
      }
    })();
    return requesting;
  };

  const onVisibility = () => {
    try {
      if (doc?.visibilityState === 'visible') void acquire();
    } catch {
      /* ignore */
    }
  };

  return {
    supported,
    get active() {
      return held();
    },
    async hold(on: boolean) {
      if (!supported || on === wanted) return;
      wanted = on;
      try {
        if (on) {
          doc?.addEventListener('visibilitychange', onVisibility);
          await acquire();
        } else {
          doc?.removeEventListener('visibilitychange', onVisibility);
          const s = sentinel;
          sentinel = null;
          if (s && !s.released) await s.release().catch(() => undefined);
        }
      } catch {
        /* never throw */
      }
    },
  };
}

/** Touch-first device (phone, tablet): where the "keep this page open" hint is shown. */
export function isTouchDevice(): boolean {
  try {
    if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) return true;
    return typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 1 && /Mobi|Android|iP(hone|ad|od)|Macintosh/.test(navigator.userAgent);
  } catch {
    return false;
  }
}
