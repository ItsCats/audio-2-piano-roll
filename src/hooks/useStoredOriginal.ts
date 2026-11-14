import { useEffect, useState } from 'react';
import { hasStoredAudio } from '../lib/storage/db';

/**
 * Whether the open song's original recording is still stored ('checking' while we look). `open`:
 * only looked up while the caller needs it. `refresh`: look again when it changes.
 */
export function useStoredOriginal(songId: string | undefined, hasAudio: boolean | undefined, open: boolean, refresh?: unknown): 'checking' | 'yes' | 'no' {
  const [state, setState] = useState<{ id: string; has: boolean } | null>(null);
  useEffect(() => {
    if (!open || !songId || !hasAudio) return;
    let alive = true;
    void hasStoredAudio(songId)
      .catch(() => false)
      .then((has) => alive && setState({ id: songId, has }));
    return () => {
      alive = false;
    };
  }, [songId, hasAudio, open, refresh]);
  if (!songId || !hasAudio) return 'no';
  if (!state || state.id !== songId) return 'checking';
  return state.has ? 'yes' : 'no';
}
