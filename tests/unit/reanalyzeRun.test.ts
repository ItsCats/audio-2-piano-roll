/**
 * "Analyze again" as an import job (importStore reanalyze), with the pipeline and storage mocked: it
 * shares the import's run (one job at a time, markers, retry), writes nothing before the new notes
 * exist, keeps the song (same id) and its Studio state in step, and says what happened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptionResult } from '../../src/lib/transcription/pipeline';
import type { Song } from '../../src/lib/music/types';

const mem = new Map<string, string>();
const memStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v), removeItem: (k: string) => void mem.delete(k) };
const fakeWindow = () => ({
  setTimeout: (f: () => void, ms: number) => setTimeout(f, ms),
  clearTimeout: (t: number) => clearTimeout(t),
  addEventListener: () => {},
  removeEventListener: () => {},
  localStorage: memStorage,
});
vi.stubGlobal('window', fakeWindow());

vi.mock('../../src/lib/storage/db', () => ({
  saveSong: vi.fn(async () => undefined),
  saveAudio: vi.fn(async () => undefined),
  savePosteriors: vi.fn(async () => undefined),
  savePending: vi.fn(async () => undefined),
  deletePending: vi.fn(async () => undefined),
  listPending: vi.fn(async () => []),
  listSummaries: vi.fn(async () => []),
  requestPersistence: vi.fn(async () => true),
  getSong: vi.fn(),
  getAudioRecord: vi.fn(),
  commitReanalysis: vi.fn(async () => 'ok'),
  newId: () => `id-${Math.random().toString(36).slice(2)}`,
}));
vi.mock('../../src/lib/transcription/pipeline', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/transcription/pipeline')>()),
  transcribeAudio: vi.fn(),
}));
vi.mock('../../src/lib/separation', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/separation')>()),
  separationSupport: () => ({ ok: true, recommended: true, estSecondsPerMinute: 60, maxSeconds: 600 }),
}));
vi.mock('../../src/lib/pianoSpecialist', () => ({
  pianoSpecialistSupport: () => ({ available: true, recommended: true, downloadMB: 49, estSecondsPerMinute: 30 }),
  runPianoSpecialist: vi.fn(),
}));

const pipeline = await import('../../src/lib/transcription/pipeline');
const db = await import('../../src/lib/storage/db');
const { useImport, checkCrashedSpecialist, checkCrashedBlend, separationCrashNotice, SPECIALIST_RUNNING_KEY, BLEND_RUNNING_KEY, BLEND_CRASH_NOTICE } = await import('../../src/state/importStore');
const { useStudio } = await import('../../src/state/studioStore');
const { useSettings } = await import('../../src/state/settingsStore');
const { useToasts } = await import('../../src/state/toastStore');
const { buildSong, songInputFromResult } = await import('../../src/lib/songs');

const tempo = { bpm: 120, beats: [0, 0.5, 1, 1.5], beatsPerBar: 4, downbeatIndex: 0, confidence: 0.8, source: 'estimated' as const };
const notes = (len: number) => [0, 1, 2, 3].map((i) => ({ id: i + 1, midi: 60 + i, start: i * 0.5, dur: len, vel: 0.7, hand: 'R' as const }));
const bpResult = (): TranscriptionResult => ({
  notes: notes(0.45),
  duration: 4,
  tempo,
  posteriors: { nFrames: 1 } as unknown as TranscriptionResult['posteriors'],
  info: { method: 'basic-pitch', estimated: true, backend: 'wasm', warnings: [] },
});
const specialistResult = (): TranscriptionResult => ({
  notes: notes(0.1),
  pedal: [{ start: 0, end: 2 }],
  duration: 4,
  tempo,
  info: { method: 'piano-specialist', estimated: true, backend: 'wasm (4 threads)', warnings: [] },
});
const stored = (): Song => ({
  ...buildSong(songInputFromResult(bpResult(), { title: 'My recording', source: { kind: 'capture', mimeType: 'audio/mp4' } })),
  id: 'song-1',
  favorite: true,
});
const rec = { blob: new Blob([new Uint8Array(32)], { type: 'audio/mp4' }), name: 'My recording.m4a', type: 'audio/mp4' };
const opts = (o: Partial<{ transcriber: 'basic-pitch' | 'piano-specialist'; separate: boolean }> = {}) => ({
  presetId: 'piano' as const,
  separate: false,
  transcriber: 'piano-specialist' as const,
  pianoBlend: false,
  ...o,
});
const titles = () => useToasts.getState().toasts.map((t) => t.title);

let song: Song;
beforeEach(() => {
  song = stored();
  vi.mocked(pipeline.transcribeAudio).mockReset();
  for (const f of [db.saveSong, db.saveAudio, db.savePending, db.savePosteriors, db.commitReanalysis, db.listSummaries]) vi.mocked(f).mockClear();
  vi.mocked(db.getSong).mockReset();
  vi.mocked(db.getSong).mockImplementation(async (id: string) => (id === song.id ? structuredClone(song) : undefined));
  vi.mocked(db.getAudioRecord).mockReset();
  vi.mocked(db.getAudioRecord).mockResolvedValue(rec);
  vi.mocked(db.commitReanalysis).mockResolvedValue('ok');
  useSettings.setState({ backendUrl: '', detectionPreset: 'mix' });
  useImport.setState({ job: null, controller: null, failed: null });
  useStudio.setState({ song: null, past: [], future: [], analyzeOpen: false });
  useToasts.setState({ toasts: [] });
});
afterEach(() => {
  useImport.getState().setPianoModelPref(false);
});

describe('Analyze again: the run', () => {
  it('analyzes the stored recording itself and replaces the notes of the same song, writing nothing else', async () => {
    vi.mocked(pipeline.transcribeAudio).mockResolvedValueOnce(specialistResult());
    const id = await useImport.getState().reanalyze('song-1', opts());
    expect(id).toBe('song-1');
    const [blob, , , , topts] = vi.mocked(pipeline.transcribeAudio).mock.calls[0];
    expect(blob).toBeInstanceOf(File);
    expect((blob as File).name).toBe('My recording.m4a');
    expect(blob.type).toBe('audio/mp4');
    expect(topts).toEqual({ engine: 'piano-specialist' });
    // no recording, pending copy, posteriors or new song written
    expect(db.saveAudio).not.toHaveBeenCalled();
    expect(db.savePending).not.toHaveBeenCalled();
    expect(db.savePosteriors).not.toHaveBeenCalled();
    expect(db.saveSong).not.toHaveBeenCalled();
    const [next, posteriors, o] = vi.mocked(db.commitReanalysis).mock.calls[0];
    expect(o).toEqual({ keepOther: true });
    expect(posteriors).toBeUndefined();
    expect(next.id).toBe('song-1');
    expect(next.title).toBe('My recording');
    expect(next.favorite).toBe(true);
    expect(next.createdAt).toBe(song.createdAt);
    expect(next.transcription.method).toBe('piano-specialist');
    expect(next.noteLength).toBe('played');
    const job = useImport.getState().job!;
    expect(job.stage).toBe('done');
    expect(job.reanalyze).toEqual({ songId: 'song-1' });
    expect(job.reanalyzeResult).toMatchObject({ label: 'Piano solo · high-accuracy piano model', keptOther: true, was: song.arrangements.hard.notes.length });
    // the library list is refreshed, and the song isn't open: the toast says it is ready
    expect(db.listSummaries).toHaveBeenCalled();
    expect(titles()).toContain('New notes are ready');
  });

  it('a Basic Pitch run passes its posteriors to the commit', async () => {
    vi.mocked(pipeline.transcribeAudio).mockResolvedValueOnce(bpResult());
    await useImport.getState().reanalyze('song-1', opts({ transcriber: 'basic-pitch' }));
    expect(vi.mocked(db.commitReanalysis).mock.calls[0][1]).toMatchObject({ nFrames: 1 });
  });

  it('cancel mid-run leaves the song untouched', async () => {
    vi.mocked(pipeline.transcribeAudio).mockImplementationOnce(
      (_b, _p, _on, signal) => new Promise((_, rej) => signal!.addEventListener('abort', () => rej(new DOMException('Canceled', 'AbortError')))),
    );
    const run = useImport.getState().reanalyze('song-1', opts());
    await vi.waitFor(() => expect(pipeline.transcribeAudio).toHaveBeenCalled());
    useImport.getState().cancel();
    expect(await run).toBeNull();
    expect(db.commitReanalysis).not.toHaveBeenCalled();
    expect(useImport.getState().job).toBeNull();
  });

  it('never takes over a running import', async () => {
    let finish!: () => void;
    vi.mocked(pipeline.transcribeAudio).mockImplementationOnce(() => new Promise((res) => (finish = () => res(bpResult()))));
    const imp = useImport.getState().importFile(new File([new Uint8Array(8)], 'other.mp3', { type: 'audio/mpeg' }), { separate: false });
    await vi.waitFor(() => expect(pipeline.transcribeAudio).toHaveBeenCalledTimes(1));
    expect(await useImport.getState().reanalyze('song-1', opts())).toBeNull();
    expect(pipeline.transcribeAudio).toHaveBeenCalledTimes(1);
    finish();
    await imp;
  });

  it('a failure offers the same run again, and the normal model', async () => {
    useImport.getState().setPianoModelPref(true);
    vi.mocked(pipeline.transcribeAudio).mockRejectedValueOnce(new Error('The model download failed.'));
    await useImport.getState().reanalyze('song-1', opts());
    const st = useImport.getState();
    expect(st.job!.stage).toBe('error');
    expect(st.job!.reanalyze).toEqual({ songId: 'song-1' });
    expect(db.commitReanalysis).not.toHaveBeenCalled();
    vi.mocked(pipeline.transcribeAudio).mockResolvedValueOnce(bpResult());
    await st.failed!.retryFast!();
    expect(useImport.getState().prefs.pianoModel).toBeUndefined();
    expect(vi.mocked(pipeline.transcribeAudio).mock.calls[1][4]).toEqual({});
    expect(useImport.getState().job!.stage).toBe('done');

    vi.mocked(pipeline.transcribeAudio).mockRejectedValueOnce(new Error('boom'));
    await useImport.getState().reanalyze('song-1', opts({ transcriber: 'basic-pitch' }));
    vi.mocked(pipeline.transcribeAudio).mockResolvedValueOnce(bpResult());
    await useImport.getState().failed!.retry();
    expect(pipeline.transcribeAudio).toHaveBeenCalledTimes(4);
  });

  it('a song deleted while it ran is not saved again (no retry)', async () => {
    vi.mocked(pipeline.transcribeAudio).mockResolvedValueOnce(specialistResult());
    vi.mocked(db.commitReanalysis).mockResolvedValueOnce('deleted');
    await useImport.getState().reanalyze('song-1', opts());
    const st = useImport.getState();
    expect(st.job!.stage).toBe('error');
    expect(st.job!.reanalyze!.failure).toBe('deleted');
    expect(st.job!.error).toBe('“My recording” was deleted while it was being analyzed again, so the new notes weren’t saved.');
    expect(st.failed).toBeNull();
    // deleted before the commit (the second read finds nothing): the commit is not even tried
    vi.mocked(db.commitReanalysis).mockClear();
    vi.mocked(db.getSong).mockResolvedValueOnce(structuredClone(song)).mockResolvedValueOnce(undefined);
    vi.mocked(pipeline.transcribeAudio).mockResolvedValueOnce(specialistResult());
    await useImport.getState().reanalyze('song-1', opts());
    expect(db.commitReanalysis).not.toHaveBeenCalled();
    expect(useImport.getState().job!.reanalyze!.failure).toBe('deleted');
  });

  it('no stored recording: says so and analyzes nothing', async () => {
    vi.mocked(db.getAudioRecord).mockResolvedValueOnce(undefined);
    await useImport.getState().reanalyze('song-1', opts());
    expect(pipeline.transcribeAudio).not.toHaveBeenCalled();
    expect(useImport.getState().job!.reanalyze!.failure).toBe('missing');
    expect(useImport.getState().job!.error).toMatch(/no longer has this song’s recording/);
  });

  it('storage too full to keep the old notes: saved without them only when asked', async () => {
    vi.mocked(pipeline.transcribeAudio).mockResolvedValueOnce(specialistResult());
    vi.mocked(db.commitReanalysis).mockResolvedValueOnce('quota');
    await useImport.getState().reanalyze('song-1', opts());
    let st = useImport.getState();
    expect(st.job!.reanalyze!.failure).toBe('quota');
    expect(st.job!.errorTitle).toBe('Not enough storage to keep the old notes');
    expect(db.commitReanalysis).toHaveBeenCalledTimes(1);
    await st.failed!.saveWithoutOld!();
    expect(vi.mocked(db.commitReanalysis).mock.calls[1][2]).toEqual({ keepOther: false });
    st = useImport.getState();
    expect(st.job!.stage).toBe('done');
    expect(st.job!.reanalyzeResult!.keptOther).toBe(false);
    // the same notes (not analyzed again)
    expect(pipeline.transcribeAudio).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.commitReanalysis).mock.calls[1][0]).toBe(vi.mocked(db.commitReanalysis).mock.calls[0][0]);
  });

  it('still too full: the second message, the song unchanged', async () => {
    vi.mocked(pipeline.transcribeAudio).mockResolvedValueOnce(specialistResult());
    vi.mocked(db.commitReanalysis).mockResolvedValueOnce('quota').mockResolvedValueOnce('quota');
    await useImport.getState().reanalyze('song-1', opts());
    await useImport.getState().failed!.saveWithoutOld!();
    const job = useImport.getState().job!;
    expect(job.reanalyze!.failure).toBe('quota-again');
    expect(job.error).toBe('Couldn’t save the new notes because this browser’s storage is full. Your song wasn’t changed.');
  });
});

describe('Analyze again and the open Studio', () => {
  it('the open song shows the new notes; an edit waiting to be saved is saved before, never after', async () => {
    useStudio.setState({ song: structuredClone(song), difficulty: 'hard', past: [], future: [] });
    // an edit (its save is scheduled for 600 ms later)
    useStudio.getState().edit((ns) => ns.slice(1));
    const edited = useStudio.getState().song!;
    let committed: Song | null = null;
    vi.mocked(db.getSong).mockImplementation(async () => structuredClone(committed ?? edited));
    vi.mocked(db.commitReanalysis).mockImplementationOnce(async (next) => ((committed = next), 'ok'));
    useStudio.setState({ analyzeOpen: true });
    vi.mocked(pipeline.transcribeAudio).mockResolvedValueOnce(specialistResult());
    await useImport.getState().reanalyze('song-1', opts());
    // saved first (settled before the run read the song)
    expect(vi.mocked(db.saveSong).mock.calls.map(([s]) => s)).toEqual([edited]);
    expect(vi.mocked(db.saveSong).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(db.commitReanalysis).mock.invocationCallOrder[0]);
    // the commit read the edited song (it is what the other version keeps)
    expect(vi.mocked(db.commitReanalysis).mock.calls[0][0].createdAt).toBe(edited.createdAt);
    const st = useStudio.getState();
    expect(st.song!.transcription.method).toBe('piano-specialist');
    expect(st.past).toEqual([]);
    expect(st.selection.size).toBe(0);
    // nothing saved later over the new notes
    await new Promise((r) => setTimeout(r, 700));
    expect(db.saveSong).toHaveBeenCalledTimes(1);
    // the dialog is open on this song: no "ready" toast (the dialog says it)
    expect(titles()).not.toContain('New notes are ready');
  });

  it('another open song is left alone', async () => {
    const other = { ...structuredClone(song), id: 'song-2', title: 'Other' };
    useStudio.setState({ song: other });
    vi.mocked(pipeline.transcribeAudio).mockResolvedValueOnce(specialistResult());
    await useImport.getState().reanalyze('song-1', opts());
    expect(useStudio.getState().song).toBe(other);
  });
});

describe('crash markers of Analyze again', () => {
  let store: Map<string, string>;
  let held: Set<string>;
  beforeEach(() => {
    store = new Map();
    held = new Set();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140',
      maxTouchPoints: 0,
      locks: {
        request: (name: string, cb: () => Promise<void>) => {
          held.add(name);
          return Promise.resolve(cb()).finally(() => held.delete(name));
        },
        query: async () => ({ held: [...held].map((name) => ({ name })) }),
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.stubGlobal('window', fakeWindow());
  });

  it('say which song is being analyzed again', async () => {
    let during: Record<string, unknown> | null = null;
    vi.mocked(pipeline.transcribeAudio).mockImplementationOnce(async () => {
      during = JSON.parse(store.get(SPECIALIST_RUNNING_KEY) ?? 'null');
      return specialistResult();
    });
    await useImport.getState().reanalyze('song-1', opts());
    expect(during).toMatchObject({ reanalyze: 'song-1', title: 'My recording' });
    expect(store.has(SPECIALIST_RUNNING_KEY)).toBe(false);
  });

  it('after a crash: the re-analysis wording, the option off, and a button to the song', async () => {
    store.set(SPECIALIST_RUNNING_KEY, JSON.stringify({ reanalyze: 'song-1', title: 'My recording', at: Date.now() }));
    const turnOff = vi.fn();
    expect(await checkCrashedSpecialist(turnOff)).toBe(true);
    expect(turnOff).toHaveBeenCalledTimes(1);
    const t = useToasts.getState().toasts.at(-1)!;
    expect(t.title).toBe('The high-accuracy piano model stopped the page');
    expect(t.body).toBe(
      'The page most likely ran out of memory while analyzing “My recording” again. Your song wasn’t changed, and the normal model is selected again. Close other tabs and tick “High-accuracy piano model” again to retry it.',
    );
    expect(t.actions!.map((a) => a.label)).toEqual(['Open the song']);

    store.set(BLEND_RUNNING_KEY, JSON.stringify({ reanalyze: 'song-1', title: 'My recording', at: Date.now() }));
    expect(await checkCrashedBlend(vi.fn())).toBe(true);
    expect(useToasts.getState().toasts.at(-1)!.body).toBe(
      'The page most likely ran out of memory while analyzing “My recording” again. Your song wasn’t changed. “Add the high-accuracy piano model” is now off; you can tick it again under Full song in Analyze again.',
    );
  });

  it('an import’s marker (or one from an older version) keeps the import wording, without a button', async () => {
    store.set(SPECIALIST_RUNNING_KEY, JSON.stringify({ pendingId: 'p1', at: Date.now() }));
    expect(await checkCrashedSpecialist(vi.fn())).toBe(true);
    const t = useToasts.getState().toasts.at(-1)!;
    expect(t.body).toBe(
      'The page most likely ran out of memory while the high-accuracy piano model was running, so the normal model is selected again. Close other tabs and tick “High-accuracy piano model” again to retry it.',
    );
    expect(t.actions).toBeUndefined();
    store.set(BLEND_RUNNING_KEY, JSON.stringify({ at: Date.now() }));
    await checkCrashedBlend(vi.fn());
    expect(useToasts.getState().toasts.at(-1)!.body).toBe(BLEND_CRASH_NOTICE);
  });

  it('separation crash wording', () => {
    expect(separationCrashNotice('piano', true)).toEqual([
      'Analyze again stopped while removing the singing and drums',
      'The page most likely ran out of memory. Your song wasn’t changed. “Remove singing and drums” is now off for Piano solo. Close other tabs and tick it again in Analyze again to retry.',
    ]);
    expect(separationCrashNotice('mix', true)[0]).toBe('Analyze again stopped while separating vocals & drums');
    expect(separationCrashNotice('mix')[0]).toBe('The last import stopped while separating vocals & drums');
  });
});
