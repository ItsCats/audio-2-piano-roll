/**
 * The user's watermark for exported videos (text and optional logo), saved as their default in its
 * own localStorage key; the logo image itself is in IndexedDB ('media' store, see lib/watermark/logo.ts).
 */
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { DEFAULT_WATERMARK, sanitizeWatermark, type WatermarkLogo, type WatermarkSettings } from '../lib/watermark/types';
import { debouncedStorage } from './titleCardStore';

export const WATERMARK_STORAGE_KEY = 'piano2vision-watermark';

interface WatermarkState extends WatermarkSettings {
  set: (patch: Partial<WatermarkSettings>) => void;
  setLogo: (patch: Partial<WatermarkLogo> | null) => void;
}

export const useWatermark = create<WatermarkState>()(
  persist(
    (set) => ({
      ...DEFAULT_WATERMARK,
      set: (patch) => set(patch),
      setLogo: (patch) => set((s) => ({ logo: patch === null ? null : s.logo ? { ...s.logo, ...patch } : patch.mediaId ? { mediaId: patch.mediaId, position: 'br', size: 0.07, opacity: 0.8, ...patch } : null })),
    }),
    {
      name: WATERMARK_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() => debouncedStorage),
      partialize: (s) => watermarkSettings(s),
      merge: (persisted, current) => ({ ...current, ...sanitizeWatermark(persisted) }),
    },
  ),
);

/** The plain settings (no actions). */
export function watermarkSettings(s: WatermarkSettings = useWatermark.getState()): WatermarkSettings {
  return { enabled: s.enabled, text: s.text, spaced: s.spaced, font: s.font, highlightName: s.highlightName, size: s.size, color: s.color, opacity: s.opacity, position: s.position, onCards: s.onCards, logo: s.logo };
}
