/** The one-time copyright reminder at the first export (src/lib/exportNotice.ts). */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXPORT_NOTICE_KEY, EXPORT_NOTICE_TEXT, exportNoticeSeen, showExportNoticeOnce } from '../../src/lib/exportNotice';
import { useToasts } from '../../src/state/toastStore';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

describe('export copyright notice', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    useToasts.setState({ toasts: [] });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows once, stays until closed, and is remembered', () => {
    expect(exportNoticeSeen()).toBe(false);
    expect(showExportNoticeOnce()).toBe(true);
    const [t] = useToasts.getState().toasts;
    expect(t.body).toBe(EXPORT_NOTICE_TEXT);
    expect(t.body).toContain('Practicing is fine.');
    expect(t.actions?.map((a) => a.label)).toContain('Got it');
    expect(localStorage.getItem(EXPORT_NOTICE_KEY)).toBe('1');
    expect(showExportNoticeOnce()).toBe(false);
    expect(useToasts.getState().toasts).toHaveLength(1);
  });

  it('keeps its storage key (changing it would show the notice again to everyone)', () => {
    expect(EXPORT_NOTICE_KEY).toBe('piano2vision-export-notice-seen');
  });

  it('still works when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(exportNoticeSeen()).toBe(false);
    expect(showExportNoticeOnce()).toBe(true);
  });
});
