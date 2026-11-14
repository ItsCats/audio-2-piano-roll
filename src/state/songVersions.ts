/**
 * The two versions of a song after "Analyze again" (lib/storage/db.ts otherKey): switching between them
 * and deleting the one not used, with the Studio and the library kept in step.
 */
import { deleteOtherVersion, swapWithOther } from '../lib/storage/db';
import { withAnalysisOf } from '../lib/songs';
import type { Song } from '../lib/music/types';
import { settleStudioSave, useStudio } from './studioStore';
import { useLibrary } from './libraryStore';

/** Switches the song to its other version (edits on both sides are kept). Returns the song now, or undefined when there is none. */
export async function swapSongVersions(songId: string): Promise<Song | undefined> {
  // an edit waiting to be saved belongs to the version on screen: it is saved first
  await settleStudioSave();
  const song = await swapWithOther(songId, withAnalysisOf);
  if (song) {
    useStudio.getState().applyReanalysis(song);
    void useLibrary.getState().refresh();
  }
  return song;
}

/** Deletes the version the song is not using. */
export async function deleteOtherSongVersion(songId: string): Promise<void> {
  await deleteOtherVersion(songId);
}
