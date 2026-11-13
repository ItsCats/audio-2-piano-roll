/** UI state of editing on the sheet: Add mode and its note length, the context menu, close-note chips. */
import { useEffect, useState } from 'react';
import { create } from 'zustand';

export type SheetPicker = 'dyn' | 'text' | 'key' | 'time' | 'tempo';

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
  /** Open popover of the desktop edit bar (Marks, Bar). */
  panel: 'marks' | 'bar' | null;
  /** Open picker (in the popover, or above the phone dock). */
  picker: SheetPicker | null;
  /** The popover was opened by a shortcut (D, W, K, M, Shift+T): applying closes it again. */
  viaKey: boolean;
  /** Dynamics and hairpins change the loudness of the notes ("Change loudness"). */
  bake: boolean;
  /** Tab of the phone dock. */
  tab: 'notes' | 'marks' | 'bar';
  set: (p: Partial<Omit<SheetUiState, 'set'>>) => void;
}

export const useSheetUi = create<SheetUiState>((set) => ({
  addMode: false,
  addLen: 12,
  triplet: false,
  menu: null,
  chips: [],
  panel: null,
  picker: null,
  viaKey: false,
  bake: true,
  tab: 'notes',
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
