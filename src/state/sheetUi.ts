/** UI state of editing on the sheet: Add mode and its note length, the context menu, close-note chips. */
import { useEffect, useState } from 'react';
import { create } from 'zustand';

export interface SheetUiState {
  /** Clicks / taps on the staff place notes. */
  addMode: boolean;
  /** Length (divisions) of notes placed in Add mode. */
  addLen: number;
  /** Triplet lengths offered on beats (Length chips). */
  triplet: boolean;
  /** Context menu at host-independent client coordinates. */
  menu: { x: number; y: number } | null;
  /** Notes under the last click that were close together (pitches to switch between). */
  chips: { ids: number[]; label: string }[];
  set: (p: Partial<Omit<SheetUiState, 'set'>>) => void;
}

export const useSheetUi = create<SheetUiState>((set) => ({
  addMode: false,
  addLen: 12,
  triplet: false,
  menu: null,
  chips: [],
  set: (p) => set(p),
}));

/** Phones and tablets (coarse pointer) or a narrow window: the sheet's edit tools are a bottom dock. */
export function useCompactSheetUi(): boolean {
  const q = '(pointer: coarse), (max-width: 639px)';
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(q).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(q);
    if (!mq) return;
    const on = () => setCompact(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return compact;
}
