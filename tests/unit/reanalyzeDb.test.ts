/**
 * The other version of a song after "Analyze again", against a real IndexedDB (fake-indexeddb): the
 * commit in one transaction (nothing written for a deleted song or a full storage), who owns the
 * stored posteriors, switching versions and back, and the library never listing the other version.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Song } from '../../src/lib/music/types';
import type { StoredPosteriors } from '../../src/lib/transcription/posteriors';
import {
  commitReanalysis,
  deleteOtherVersion,
  deleteSong,
  getOtherVersion,
  getPosteriors,
  getSong,
  hasOtherVersion,
  listSummaries,
  otherKey,
  savePosteriors,
  saveSong,
  swapWithOther,
} from '../../src/lib/storage/db';
import { withAnalysisOf } from '../../src/lib/songs';

let n = 0;
const song = (id: string, method: 'basic-pitch' | 'piano-specialist', hasPosteriors: boolean, extra: Partial<Song> = {}): Song =>
  ({
    id,
    title: 'Practice piece',
    createdAt: 1,
    updatedAt: ++n,
    duration: 10,
    source: { kind: 'audio', fileName: 'piece.wav' },
    tempo: { bpm: 120, beats: [0, 0.5], beatsPerBar: 4, downbeatIndex: 0, confidence: 1, source: 'estimated' },
    transcription: { method, estimated: true, warnings: [] },
    base: [{ id: 1, midi: method === 'piano-specialist' ? 62 : 60, start: 0, dur: 0.5, vel: 0.7, hand: 'R' }],
    basePedal: [],
    arrangements: {
      easy: { notes: [], pedal: [], edited: false, generatedAt: 1 },
      medium: { notes: [], pedal: [], edited: false, generatedAt: 1 },
      hard: { notes: [{ id: 2, midi: 60, start: 0, dur: 0.5, vel: 0.7, hand: 'R' }], pedal: [], edited: false, generatedAt: 1 },
    },
    hasAudio: true,
    hasPosteriors,
    ...extra,
  }) as Song;
const post = (tag: number) => ({ nFrames: tag, frames: new Uint8Array(88), onsets: new Uint8Array(88), rms: new Uint8Array(1) }) as unknown as StoredPosteriors;

let ids = 0;
const fresh = () => `s${++ids}`;

describe('commitReanalysis', () => {
  it('keeps the stored song as the other version and writes the new one with its summary, in one go', async () => {
    const id = fresh();
    await saveSong(song(id, 'basic-pitch', true, { favorite: true }));
    await savePosteriors(id, post(1));
    const next = song(id, 'piano-specialist', false, { favorite: true });
    expect(await commitReanalysis(next, undefined)).toBe('ok');
    expect((await getSong(id))!.transcription.method).toBe('piano-specialist');
    const other = (await getOtherVersion(id))!;
    expect(other.id).toBe(otherKey(id));
    expect(other.otherVersion.role).toBe('older');
    expect(other.transcription.method).toBe('basic-pitch');
    // the posteriors now belong to the old version (the specialist has none)
    expect(other.hasPosteriors).toBe(true);
    expect(await getPosteriors(id)).toMatchObject({ nFrames: 1 });
    // the library lists the song once, with the new summary
    const mine = (await listSummaries()).filter((s) => s.id.startsWith(id));
    expect(mine.map((s) => s.id)).toEqual([id]);
    expect(mine[0].noteCount).toBe(1);
  });

  it('a song deleted meanwhile is not brought back, and nothing is written', async () => {
    const id = fresh();
    expect(await commitReanalysis(song(id, 'piano-specialist', false), undefined)).toBe('deleted');
    expect(await getSong(id)).toBeUndefined();
    expect(await hasOtherVersion(id)).toBe(false);
    expect((await listSummaries()).some((s) => s.id === id)).toBe(false);
  });

  it('posteriors go with the version that has them: Basic Pitch → Basic Pitch replaces them', async () => {
    const id = fresh();
    await saveSong(song(id, 'basic-pitch', true));
    await savePosteriors(id, post(1));
    await commitReanalysis(song(id, 'basic-pitch', true), post(2));
    expect(await getPosteriors(id)).toMatchObject({ nFrames: 2 });
    expect((await getOtherVersion(id))!.hasPosteriors).toBe(false);
    expect((await getSong(id))!.hasPosteriors).toBe(true);
  });

  it('specialist → Basic Pitch: new posteriors; specialist → specialist: none kept for nobody', async () => {
    const a = fresh();
    await saveSong(song(a, 'piano-specialist', false));
    await commitReanalysis(song(a, 'basic-pitch', true), post(3));
    expect(await getPosteriors(a)).toMatchObject({ nFrames: 3 });
    expect((await getOtherVersion(a))!.hasPosteriors).toBe(false);

    const b = fresh();
    await saveSong(song(b, 'piano-specialist', false));
    // stale posteriors of an earlier analysis nobody has any more
    await savePosteriors(b, post(9));
    await commitReanalysis(song(b, 'piano-specialist', false), undefined);
    expect(await getPosteriors(b)).toBeUndefined();
  });

  it('without keeping the old notes: the song is replaced and no other version is left', async () => {
    const id = fresh();
    await saveSong(song(id, 'basic-pitch', true));
    await savePosteriors(id, post(1));
    await commitReanalysis(song(id, 'piano-specialist', false), undefined);
    expect(await hasOtherVersion(id)).toBe(true);
    expect(await commitReanalysis(song(id, 'basic-pitch', false), undefined, { keepOther: false })).toBe('ok');
    expect(await hasOtherVersion(id)).toBe(false);
    // nobody owns the posteriors now
    expect(await getPosteriors(id)).toBeUndefined();
  });

  describe('a full storage', () => {
    const put = IDBObjectStore.prototype.put;
    afterEach(() => {
      IDBObjectStore.prototype.put = put;
    });
    it('gives "quota" and changes nothing; without the old notes it can still be saved', async () => {
      const id = fresh();
      const before = song(id, 'basic-pitch', true);
      await saveSong(before);
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        if ((value as { id?: string })?.id === otherKey(id)) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        return put.call(this, value, key);
      } as typeof put;
      expect(await commitReanalysis(song(id, 'piano-specialist', false), undefined)).toBe('quota');
      expect((await getSong(id))!.transcription.method).toBe('basic-pitch');
      expect(await hasOtherVersion(id)).toBe(false);
      expect(await commitReanalysis(song(id, 'piano-specialist', false), undefined, { keepOther: false })).toBe('ok');
      expect((await getSong(id))!.transcription.method).toBe('piano-specialist');
    });
  });
});

describe('switching versions', () => {
  it('swaps the analysis (edits included) and back again; the posteriors flag moves with it', async () => {
    const id = fresh();
    await saveSong(song(id, 'basic-pitch', true));
    await savePosteriors(id, post(1));
    await commitReanalysis(song(id, 'piano-specialist', false), undefined);
    // an edit of the new notes, and a rename (the song's own: it stays with whichever version is used)
    const cur = (await getSong(id))!;
    await saveSong({ ...cur, title: 'Renamed', arrangements: { ...cur.arrangements, hard: { ...cur.arrangements.hard, edited: true } } });

    const back = (await swapWithOther(id, withAnalysisOf))!;
    expect(back.transcription.method).toBe('basic-pitch');
    expect(back.hasPosteriors).toBe(true);
    expect(back.title).toBe('Renamed');
    expect('otherVersion' in back).toBe(false);
    const kept = (await getOtherVersion(id))!;
    expect(kept.otherVersion.role).toBe('newer');
    expect(kept.transcription.method).toBe('piano-specialist');
    expect(kept.arrangements.hard.edited).toBe(true);
    expect(kept.hasPosteriors).toBe(false);
    expect((await listSummaries()).find((s) => s.id === id)!.title).toBe('Renamed');

    const again = (await swapWithOther(id, withAnalysisOf))!;
    expect(again.transcription.method).toBe('piano-specialist');
    expect(again.arrangements.hard.edited).toBe(true);
    expect(again.hasPosteriors).toBe(false);
    expect((await getOtherVersion(id))!.otherVersion.role).toBe('older');
    expect((await getOtherVersion(id))!.hasPosteriors).toBe(true);
    expect(await getPosteriors(id)).toMatchObject({ nFrames: 1 });
  });

  it('no other version: nothing to swap', async () => {
    const id = fresh();
    await saveSong(song(id, 'basic-pitch', true));
    expect(await swapWithOther(id, withAnalysisOf)).toBeUndefined();
  });
});

describe('deleting', () => {
  it('the other version: its posteriors go when only it had them', async () => {
    const id = fresh();
    await saveSong(song(id, 'basic-pitch', true));
    await savePosteriors(id, post(1));
    await commitReanalysis(song(id, 'piano-specialist', false), undefined);
    await deleteOtherVersion(id);
    expect(await hasOtherVersion(id)).toBe(false);
    expect(await getPosteriors(id)).toBeUndefined();
    expect((await getSong(id))!.transcription.method).toBe('piano-specialist');
  });

  it('the other version of a song with its own posteriors keeps them', async () => {
    const id = fresh();
    await saveSong(song(id, 'piano-specialist', false));
    await commitReanalysis(song(id, 'basic-pitch', true), post(4));
    await deleteOtherVersion(id);
    expect(await getPosteriors(id)).toMatchObject({ nFrames: 4 });
  });

  it('the song: its other version goes with it', async () => {
    const id = fresh();
    await saveSong(song(id, 'basic-pitch', true));
    await commitReanalysis(song(id, 'piano-specialist', false), undefined);
    await deleteSong(id);
    expect(await getSong(id)).toBeUndefined();
    expect(await hasOtherVersion(id)).toBe(false);
  });
});
