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

interface StudioState {
  song: Song | null;
  loading: boolean;
  error: string | null;
  difficulty: Difficulty;
  editMode: boolean;
  selection: Set<number>;
  past: Arrangement[];
  future: Arrangement[];
  saving: boolean;
  lastSavedAt: number | null;
  open: (id: string) => Promise<void>;
  openSong: (song: Song) => void;
  close: () => void;
  setDifficulty: (d: Difficulty) => void;
  setEditMode: (on: boolean) => void;
  select: (ids: number[], additive?: boolean) => void;
  clearSelection: () => void;
  /** apply an edit to the current arrangement (undoable) */
  edit: (fn: (notes: Note[]) => Note[], opts?: { coalesceKey?: string }) => void;
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
let lastCoalesce: { key: string; at: number } | null = null;

function arrangement(s: StudioState): Arrangement | null {
  return s.song ? s.song.arrangements[s.difficulty] : null;
}

export const useStudio = create<StudioState>((set, get) => {
  const scheduleSave = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(async () => {
      const song = get().song;
      if (!song) return;
      set({ saving: true });
      try {
        await saveSong(song);
        set({ lastSavedAt: Date.now() });
      } catch (err) {
        set({ error: `Could not save: ${err instanceof Error ? err.message : String(err)}` });
      } finally {
        set({ saving: false });
      }
    }, 600);
  };

  const commit = (next: Arrangement, prev: Arrangement, coalesceKey?: string) => {
    const s = get();
    if (!s.song) return;
    const now = Date.now();
    const coalesce = coalesceKey && lastCoalesce?.key === coalesceKey && now - lastCoalesce.at < 800;
    lastCoalesce = coalesceKey ? { key: coalesceKey, at: now } : null;
    set({
      song: { ...s.song, arrangements: { ...s.song.arrangements, [s.difficulty]: next }, updatedAt: now },
      past: coalesce ? s.past : [...s.past, prev].slice(-HISTORY_LIMIT),
      future: [],
    });
    scheduleSave();
  };

  return {
    song: null,
    loading: false,
    error: null,
    difficulty: useSettings.getState().defaultDifficulty,
    editMode: false,
    selection: new Set(),
    past: [],
    future: [],
    saving: false,
    lastSavedAt: null,
    open: async (id) => {
      if (get().song?.id === id) return;
      set({ loading: true, error: null });
      try {
        const song = await getSong(id);
        if (!song) throw new Error('Song not found. It may have been deleted.');
        song.lastPlayedAt = Date.now();
        void saveSong(song);
        set({ song, loading: false, past: [], future: [], selection: new Set(), editMode: false });
      } catch (err) {
        set({ loading: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
    openSong: (song) => set({ song, past: [], future: [], selection: new Set(), editMode: false, error: null }),
    close: () => set({ song: null, past: [], future: [], selection: new Set() }),
    setDifficulty: (d) => set({ difficulty: d, past: [], future: [], selection: new Set() }),
    setEditMode: (on) => set({ editMode: on, selection: on ? get().selection : new Set() }),
    select: (ids, additive) => {
      const sel = additive ? new Set(get().selection) : new Set<number>();
      for (const id of ids) {
        if (additive && sel.has(id)) sel.delete(id);
        else sel.add(id);
      }
      set({ selection: sel });
    },
    clearSelection: () => set({ selection: new Set() }),
    edit: (fn, opts) => {
      const s = get();
      const arr = arrangement(s);
      if (!arr) return;
      const notes = sortNotes(fn(arr.notes.map((n) => ({ ...n }))));
      commit({ ...arr, notes, edited: true }, arr, opts?.coalesceKey);
    },
    undo: () => {
      const s = get();
      const arr = arrangement(s);
      if (!arr || !s.past.length || !s.song) return;
      const prev = s.past[s.past.length - 1];
      set({
        song: { ...s.song, arrangements: { ...s.song.arrangements, [s.difficulty]: prev }, updatedAt: Date.now() },
        past: s.past.slice(0, -1),
        future: [arr, ...s.future],
      });
      scheduleSave();
    },
    redo: () => {
      const s = get();
      const arr = arrangement(s);
      if (!arr || !s.future.length || !s.song) return;
      const next = s.future[0];
      set({
        song: { ...s.song, arrangements: { ...s.song.arrangements, [s.difficulty]: next }, updatedAt: Date.now() },
        past: [...s.past, arr],
        future: s.future.slice(1),
      });
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
