/**
 * Studio state: the open song, the selected difficulty, and an undoable edit history for
 * the current arrangement. Playback time is intentionally NOT stored here (it is read from
 * the audio clock every frame) so playback never triggers React re-renders.
 */
import { create } from 'zustand';
import type { Arrangement, Difficulty, Hand, Note, Song } from '../lib/music/types';
import { getSong, saveSong } from '../lib/storage/db';
import { useSettings } from './settingsStore';
import { regenerate } from '../lib/songs';
import { newNoteId, sortNotes } from '../lib/music/cleanup';
import { quantizeNotes } from '../lib/music/quantize';

const HISTORY_LIMIT = 200;

/**
 * The song fields an edit can touch; undo entries are references to them (edits make new
 * objects), so one stack covers piano-roll edits, sheet edits and song-level changes together.
 */
export type HistorySnap = Pick<Song, 'arrangements' | 'base' | 'basePedal' | 'tempo' | 'duration' | 'key' | 'sheet'>;

const snapOf = (s: Song): HistorySnap => ({
  arrangements: s.arrangements,
  base: s.base,
  basePedal: s.basePedal,
  tempo: s.tempo,
  duration: s.duration,
  key: s.key,
  sheet: s.sheet,
});

/** A song with a history entry put back (an absent sheet is removed, not set to undefined). */
function withSnap(song: Song, snap: HistorySnap): Song {
  const out: Song = { ...song, ...snap, updatedAt: Date.now() };
  if (!snap.sheet) delete out.sheet;
  return out;
}

interface StudioState {
  song: Song | null;
  loading: boolean;
  error: string | null;
  difficulty: Difficulty;
  editMode: boolean;
  selection: Set<number>;
  /** A selected marking on the sheet (lib/sheet/marks.ts MarkRef id); selecting notes clears it. */
  markSel: string | null;
  past: HistorySnap[];
  future: HistorySnap[];
  saving: boolean;
  lastSavedAt: number | null;
  open: (id: string) => Promise<void>;
  openSong: (song: Song) => void;
  close: () => void;
  setDifficulty: (d: Difficulty) => void;
  setEditMode: (on: boolean) => void;
  select: (ids: number[], additive?: boolean) => void;
  clearSelection: () => void;
  selectMark: (id: string | null) => void;
  /** apply an edit to the current arrangement's notes (undoable) */
  edit: (fn: (notes: Note[]) => Note[], opts?: { coalesceKey?: string }) => void;
  /** apply an edit to the current arrangement as a whole: notes, pedal (undoable) */
  editArr: (fn: (a: Arrangement) => Arrangement, opts?: { coalesceKey?: string }) => void;
  /** apply a song-level edit: any of the history fields (undoable, one step) */
  editSong: (fn: (s: Song) => Partial<HistorySnap>, opts?: { coalesceKey?: string }) => void;
  undo: () => void;
  redo: () => void;
  deleteSelected: () => void;
  setHandSelected: (hand: Hand | 'toggle') => void;
  quantizeSelected: (subdivision: number) => void;
  transposeSelected: (semitones: number) => void;
  addNote: (n: Omit<Note, 'id'>) => number;
  regenerateLevels: (levels: Difficulty[]) => void;
  updateSong: (patch: Partial<Song>) => void;
  replaceSong: (song: Song) => void;
}

let saveTimer: number | null = null;
/** The song waiting to be saved (captured when the save was scheduled: a song switch can't drop it). */
let pendingSave: Song | null = null;
let lastCoalesce: { key: string; at: number } | null = null;
let saveNow: () => void = () => {};

/** Saves a scheduled edit right away (the page is being hidden or closed, or another song opens). */
export function flushSave(): void {
  saveNow();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', () => flushSave());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSave();
  });
}

function arrangement(s: StudioState): Arrangement | null {
  return s.song ? s.song.arrangements[s.difficulty] : null;
}

export const useStudio = create<StudioState>((set, get) => {
  const write = async (song: Song) => {
    set({ saving: true });
    try {
      await saveSong(song);
      set({ lastSavedAt: Date.now() });
    } catch (err) {
      set({ error: `Could not save: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      set({ saving: false });
    }
  };
  saveNow = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    const song = pendingSave;
    pendingSave = null;
    if (song) void write(song);
  };
  const scheduleSave = () => {
    const song = get().song;
    if (!song) return;
    // an edit of another song still waiting: save it now
    if (pendingSave && pendingSave.id !== song.id) saveNow();
    pendingSave = song;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveNow, 600);
  };

  /** Puts the song with `patch` applied on screen, pushing the previous fields as an undo entry. */
  const commitSong = (patch: Partial<HistorySnap>, coalesceKey?: string) => {
    const s = get();
    if (!s.song) return;
    const now = Date.now();
    const coalesce = coalesceKey && lastCoalesce?.key === coalesceKey && now - lastCoalesce.at < 800;
    lastCoalesce = coalesceKey ? { key: coalesceKey, at: now } : null;
    set({
      song: { ...s.song, ...patch, updatedAt: now },
      past: coalesce ? s.past : [...s.past, snapOf(s.song)].slice(-HISTORY_LIMIT),
      future: [],
    });
    scheduleSave();
  };
  const commit = (next: Arrangement, coalesceKey?: string) => {
    const s = get();
    if (!s.song) return;
    commitSong({ arrangements: { ...s.song.arrangements, [s.difficulty]: next } }, coalesceKey);
  };

  return {
    song: null,
    loading: false,
    error: null,
    difficulty: useSettings.getState().defaultDifficulty,
    editMode: false,
    selection: new Set(),
    markSel: null,
    past: [],
    future: [],
    saving: false,
    lastSavedAt: null,
    open: async (id) => {
      if (get().song?.id === id) return;
      flushSave();
      set({ loading: true, error: null });
      try {
        const song = await getSong(id);
        if (!song) throw new Error('Song not found. It may have been deleted.');
        song.lastPlayedAt = Date.now();
        void saveSong(song);
        set({ song, loading: false, past: [], future: [], selection: new Set(), markSel: null, editMode: false });
      } catch (err) {
        set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
    openSong: (song) => set({ song, past: [], future: [], selection: new Set(), markSel: null, editMode: false, error: null }),
    close: () => set({ song: null, past: [], future: [], selection: new Set(), markSel: null }),
    setDifficulty: (d) => set({ difficulty: d, past: [], future: [], selection: new Set(), markSel: null }),
    setEditMode: (on) => set({ editMode: on, selection: on ? get().selection : new Set(), markSel: on ? get().markSel : null }),
    select: (ids, additive) => {
      const sel = additive ? new Set(get().selection) : new Set<number>();
      for (const id of ids) {
        if (additive && sel.has(id)) sel.delete(id);
        else sel.add(id);
      }
      set({ selection: sel, markSel: null });
    },
    clearSelection: () => set({ selection: new Set(), markSel: null }),
    selectMark: (id) => set({ markSel: id, ...(id ? { selection: new Set<number>() } : {}) }),
    edit: (fn, opts) => {
      const s = get();
      const arr = arrangement(s);
      if (!arr) return;
      const notes = sortNotes(fn(arr.notes.map((n) => ({ ...n }))));
      commit({ ...arr, notes, edited: true }, opts?.coalesceKey);
    },
    editArr: (fn, opts) => {
      const arr = arrangement(get());
      if (!arr) return;
      const next = fn(arr);
      if (next === arr) return;
      commit({ ...next, notes: sortNotes(next.notes), edited: true }, opts?.coalesceKey);
    },
    editSong: (fn, opts) => {
      const s = get();
      if (!s.song) return;
      commitSong(fn(s.song), opts?.coalesceKey);
    },
    undo: () => {
      const s = get();
      if (!s.past.length || !s.song) return;
      const prev = s.past[s.past.length - 1];
      lastCoalesce = null;
      set({ song: withSnap(s.song, prev), past: s.past.slice(0, -1), future: [snapOf(s.song), ...s.future] });
      scheduleSave();
    },
    redo: () => {
      const s = get();
      if (!s.future.length || !s.song) return;
      const next = s.future[0];
      lastCoalesce = null;
      set({ song: withSnap(s.song, next), past: [...s.past, snapOf(s.song)], future: s.future.slice(1) });
      scheduleSave();
    },
    deleteSelected: () => {
      const sel = get().selection;
      if (!sel.size) return;
      get().edit((notes) => notes.filter((n) => !sel.has(n.id)));
      set({ selection: new Set() });
    },
    setHandSelected: (hand) => {
      const sel = get().selection;
      if (!sel.size) return;
      get().edit((notes) =>
        notes.map((n) => (sel.has(n.id) ? { ...n, hand: hand === 'toggle' ? (n.hand === 'L' ? 'R' : 'L') : hand } : n)),
      );
    },
    quantizeSelected: (subdivision) => {
      const s = get();
      if (!s.song) return;
      const sel = s.selection;
      const tempo = s.song.tempo;
      get().edit((notes) => {
        const target = sel.size ? notes.filter((n) => sel.has(n.id)) : notes;
        const q = new Map(quantizeNotes(target, tempo, { subdivision, strength: 1, quantizeDurations: true }).map((n) => [n.id, n]));
        return notes.map((n) => q.get(n.id) ?? n);
      });
    },
    transposeSelected: (semi) => {
      const sel = get().selection;
      if (!sel.size) return;
      get().edit(
        (notes) => notes.map((n) => (sel.has(n.id) ? { ...n, midi: Math.max(21, Math.min(108, n.midi + semi)) } : n)),
        { coalesceKey: 'transpose' },
      );
    },
    addNote: (n) => {
      const id = newNoteId();
      get().edit((notes) => [...notes, { ...n, id }]);
      set({ selection: new Set([id]) });
      return id;
    },
    regenerateLevels: (levels) => {
      const s = get();
      if (!s.song) return;
      const song = regenerate(s.song, levels);
      set({ song, past: [], future: [], selection: new Set() });
      scheduleSave();
    },
    updateSong: (patch) => {
      const s = get();
      if (!s.song) return;
      set({ song: { ...s.song, ...patch, updatedAt: Date.now() } });
      scheduleSave();
    },
    replaceSong: (song) => {
      set({ song, past: [], future: [], selection: new Set() });
      scheduleSave();
    },
  };
});

export const currentArrangement = (s: StudioState): Arrangement | null => arrangement(s);
