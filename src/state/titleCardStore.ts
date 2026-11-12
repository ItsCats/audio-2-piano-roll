/**
 * Title page / end card settings for video export, saved in their own localStorage key so the
 * existing 'pianovision-settings' (and saved export presets) load exactly as before.
 */
import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import { DEFAULT_LOOK, DEFAULT_TITLE_CARD, type EndCardSettings, type TitleCardSettings, type TitleLook, type TitlePresetId, type TitleText } from '../lib/render/titleCard/types';
import { clampDuration, sanitizeTitleCard, trimSongs } from '../lib/render/titleCard/settings';

export const TITLE_CARD_STORAGE_KEY = 'piano2vision-title-card';

interface TitleCardState extends TitleCardSettings {
  setEnabled: (on: boolean) => void;
  setDuration: (seconds: number) => void;
  setLook: (patch: Partial<TitleLook>) => void;
  /** a new style clears every tweak */
  applyPreset: (id: TitlePresetId) => void;
  /** changes the text for one song; the credit and small line are also remembered for new songs */
  setSongText: (songId: string, patch: Partial<TitleText>) => void;
  resetSongText: (songId: string) => void;
  setEnd: (patch: Partial<EndCardSettings>) => void;
  /** an uploaded image was deleted: stop using it */
  forgetMedia: (mediaId: string) => void;
}

/**
 * localStorage, written at most every 400 ms (typing a title doesn't rewrite it on every key);
 * a pending write is flushed when the page is hidden.
 */
const pending = new Map<string, string>();
let timer: ReturnType<typeof setTimeout> | null = null;
const flush = () => {
  if (timer) clearTimeout(timer);
  timer = null;
  for (const [k, v] of pending) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* storage full or blocked: settings stay in memory */
    }
  }
  pending.clear();
};
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('pagehide', flush);
/** Writes pending title page settings now (tests; the page also flushes when it is hidden). */
export const flushTitleCardStorage = flush;
const debouncedStorage: StateStorage = {
  getItem: (k) => {
    try {
      return pending.get(k) ?? localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem: (k, v) => {
    pending.set(k, v);
    timer ??= setTimeout(flush, 400);
  },
  removeItem: (k) => {
    pending.delete(k);
    try {
      localStorage.removeItem(k);
    } catch {
      /* blocked */
    }
  },
};

export const useTitleCard = create<TitleCardState>()(
  persist(
    (set) => ({
      ...DEFAULT_TITLE_CARD,
      setEnabled: (enabled) => set({ enabled }),
      setDuration: (d) => set({ duration: clampDuration(d) }),
      setLook: (patch) => set((s) => ({ look: { ...s.look, ...patch } })),
      applyPreset: (preset) => set({ look: { ...DEFAULT_LOOK, preset } }),
      setSongText: (songId, patch) =>
        set((s) => {
          const prev = s.songs[songId]?.text ?? {};
          const remembered = { ...s.remembered };
          if (patch.credit !== undefined) remembered.credit = patch.credit;
          if (patch.small !== undefined) remembered.small = patch.small;
          return { remembered, songs: trimSongs({ ...s.songs, [songId]: { text: { ...prev, ...patch }, at: Date.now() } }) };
        }),
      resetSongText: (songId) =>
        set((s) => {
          const songs = { ...s.songs };
          delete songs[songId];
          return { songs };
        }),
      setEnd: (patch) => set((s) => ({ end: { ...s.end, ...patch, ...(patch.duration !== undefined ? { duration: clampDuration(patch.duration) } : {}) } })),
      forgetMedia: (id) =>
        set((s) => ({
          look: {
            ...s.look,
            fillImageId: s.look.fillImageId === id ? null : s.look.fillImageId,
            bgImageId: s.look.bgImageId === id ? null : s.look.bgImageId,
          },
        })),
    }),
    {
      name: TITLE_CARD_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => debouncedStorage),
      partialize: (s) => ({ enabled: s.enabled, duration: s.duration, look: s.look, remembered: s.remembered, songs: s.songs, end: s.end }),
      merge: (persisted, current) => ({ ...current, ...sanitizeTitleCard(persisted) }),
    },
  ),
);

/** The plain settings (no actions), e.g. for an export job. */
export function titleCardSettings(): TitleCardSettings {
  const s = useTitleCard.getState();
  return { enabled: s.enabled, duration: s.duration, look: s.look, remembered: s.remembered, songs: s.songs, end: s.end };
}
