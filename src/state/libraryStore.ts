import { create } from 'zustand';
import type { SongSummary } from '../lib/music/types';
import { deleteSong, listSummaries } from '../lib/storage/db';

interface LibraryState {
  songs: SongSummary[];
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const useLibrary = create<LibraryState>((set, get) => ({
  songs: [],
  loaded: false,
  error: null,
  refresh: async () => {
    try {
      set({ songs: await listSummaries(), loaded: true, error: null });
    } catch (err) {
      set({ loaded: true, error: err instanceof Error ? err.message : String(err) });
    }
  },
  remove: async (id) => {
    await deleteSong(id);
    await get().refresh();
  },
}));
