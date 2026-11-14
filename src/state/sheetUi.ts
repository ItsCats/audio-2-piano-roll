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
  /** Context menu at host-independent client coordinates (touch: a long press, shown as an action sheet). */
  menu: { x: number; y: number; touch?: boolean; chordIds?: number[]; barIds?: number[] } | null;
  /** A note just placed by a tap ("Added G4 · Undo"); `past` is the undo depth right after it. */
  added: { label: string; past: number; at: number } | null;
  /** Touch: taps add notes to the selection or take them out ("Select more"). */
  selectMore: boolean;
  /** The shortcuts and tips sheet is open. */
  help: boolean;
  /** The "bigger notes are easier to tap" hint was closed (for this visit). */
  zoomHintClosed: boolean;
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
  /** The phone dock / side rail is folded away (status line and Undo / Redo stay). */
  collapsed: boolean;
  /** Tab of the phone dock. */
  tab: 'notes' | 'marks' | 'bar';
  set: (p: Partial<Omit<SheetUiState, 'set'>>) => void;
}

export const useSheetUi = create<SheetUiState>((set) => ({
  addMode: false,
  addLen: 12,
  triplet: false,
  menu: null,
  added: null,
  selectMore: false,
  help: false,
  zoomHintClosed: false,
  chips: [],
  panel: null,
  picker: null,
  viaKey: false,
  bake: true,
  tab: 'notes',
  collapsed: false,
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

export type SheetDockLayout = 'row' | 'dock' | 'rail';

/**
 * Where the sheet's edit tools go: a toolbar row on a computer, a bottom dock on phones and tablets,
 * a side rail on a phone held sideways (short and wide: a bottom dock would cover most of the music).
 */
export function useSheetDockLayout(): SheetDockLayout {
  const compact = useCompactSheetUi();
  const q = '(orientation: landscape) and (max-height: 520px)';
  const [side, setSide] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(q).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(q);
    if (!mq) return;
    const on = () => setSide(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return !compact ? 'row' : side ? 'rail' : 'dock';
}
