/**
 * Import flows with the processing server, the pipeline and storage mocked: which errors start the
 * separation fallback, where the fallback runs, and the server health cache.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptionResult } from '../../src/lib/transcription/pipeline';
import type { SeparationSupport } from '../../src/lib/separation';

const support: { value: SeparationSupport } = { value: { ok: true, recommended: true, estSecondsPerMinute: 60, maxSeconds: 600 } };

vi.mock('../../src/lib/storage/db', () => ({
  saveSong: vi.fn(async () => undefined),
  saveAudio: vi.fn(async () => undefined),
  savePosteriors: vi.fn(async () => undefined),
  savePending: vi.fn(async () => undefined),
  deletePending: vi.fn(async () => undefined),
  listPending: vi.fn(async () => []),
  listSummaries: vi.fn(async () => []),
  requestPersistence: vi.fn(async () => true),
  newId: () => `id-${Math.random().toString(36).slice(2)}`,
}));
vi.mock('../../src/lib/transcription/pipeline', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/transcription/pipeline')>()),
  transcribeAudio: vi.fn(),
}));
vi.mock('../../src/lib/separation', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/separation')>()),
  separationSupport: () => support.value,
}));
// the piano specialist (T1's module): only whether this browser can run it matters here
const specialist = { available: true };
vi.mock('../../src/lib/pianoSpecialist', () => ({
  pianoSpecialistSupport: () => ({ available: specialist.available, recommended: true, downloadMB: 49, estSecondsPerMinute: 30 }),
  runPianoSpecialist: vi.fn(),
}));
vi.mock('../../src/lib/backend/client', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/backend/client')>()),
  health: vi.fn(),
  createYouTubeJob: vi.fn(),
  createSeparationJob: vi.fn(),
  waitForJob: vi.fn(),
  getJobAudio: vi.fn(),
  fetchStems: vi.fn(),
}));

const pipeline = await import('../../src/lib/transcription/pipeline');
const client = await import('../../src/lib/backend/client');
const db = await import('../../src/lib/storage/db');
const {
  useImport,
  serverHealth,
  rememberServerHealth,
  separationChoice,
  separationAvailability,
  transcriberChoice,
  parsePrefs,
  resumeTranscriber,
  checkCrashedSpecialist,
  SPECIALIST_RUNNING_KEY,
  pianoBlendAvailability,
  pianoBlendChoice,
  PIANO_BLEND_DEFAULT,
  BLEND_RUNNING_KEY,
  checkCrashedBlend,
  resumeBlend,
  STAGE_LABELS,
} = await import('../../src/state/importStore');
const { interruptedNotice } = await import('../../src/state/interruptedImport');
const { useSettings } = await import('../../src/state/settingsStore');

const healthy = { ok: true, version: '2.0.0', features: { youtube: true, separation: true, stems: true } } as unknown as Awaited<ReturnType<typeof client.health>>;

function result(): TranscriptionResult {
  return {
    notes: [{ id: 1, midi: 60, start: 0, dur: 0.5, vel: 0.7, hand: 'R' }],
    duration: 10,
    tempo: { bpm: 120, beats: [0, 0.5, 1], beatsPerBar: 4, downbeatIndex: 0, confidence: 0.8, source: 'estimated' },
    posteriors: { nFrames: 1, frames: new Uint8Array(88), onsets: new Uint8Array(88), rms: new Uint8Array(1) } as unknown as TranscriptionResult['posteriors'],
    info: { method: 'basic-pitch', estimated: true, backend: 'wasm', warnings: [], confidence: 0.5 } as unknown as TranscriptionResult['info'],
  };
}

let url = 0;
beforeEach(() => {
  vi.mocked(pipeline.transcribeAudio).mockReset();
  for (const f of [client.health, client.createYouTubeJob, client.createSeparationJob, client.waitForJob, client.getJobAudio, client.fetchStems, db.saveSong]) vi.mocked(f).mockReset();
  vi.mocked(db.saveSong).mockResolvedValue(undefined);
  support.value = { ok: true, recommended: true, estSecondsPerMinute: 60, maxSeconds: 600 };
  // a fresh server URL per test: nothing from the health cache leaks between tests
  useSettings.setState({ backendUrl: `http://server-${++url}.test`, detectionPreset: 'mix' });
  vi.mocked(client.health).mockResolvedValue(healthy);
  vi.mocked(client.createYouTubeJob).mockResolvedValue({ id: 'job1', status: 'queued', stage: 'queued', progress: null });
  vi.mocked(client.getJobAudio).mockImplementation(async (_u, _id, stem) => new Blob([stem ?? 'audio'], { type: 'audio/mp4' }));
  vi.mocked(client.fetchStems).mockResolvedValue({ vocals: new Blob(['v']), accomp: new Blob(['a']) });
});

const done = (extra: Record<string, unknown> = {}) => ({ id: 'job1', status: 'done' as const, stage: 'done', progress: 1, title: 'Video', ...extra });

describe('YouTube import via a separating server', () => {
  it('a transcription error is reported as is, not retried as a separation fallback', async () => {
    vi.mocked(client.waitForJob).mockResolvedValue(done({ stems: ['accomp', 'mix', 'vocals'], separationMs: 90_000 }));
    vi.mocked(pipeline.transcribeAudio).mockRejectedValue(new Error('The audio is (nearly) silent — nothing to transcribe.'));
    await useImport.getState().importYouTubeViaServer('https://youtu.be/abc', 'abc', true);
    const job = useImport.getState().job!;
    expect(job.stage).toBe('error');
    expect(job.error).toMatch(/silent/);
    expect(job.warnings.join(' ')).not.toMatch(/could not separate/);
    expect(client.createYouTubeJob).toHaveBeenCalledTimes(1);
    expect(pipeline.transcribeAudio).toHaveBeenCalledTimes(1);
    // the server's own separation time is passed on (not the stem decode time)
    expect(vi.mocked(pipeline.transcribeAudio).mock.calls[0][4]?.stems?.serverMs).toBe(90_000);
  });

  it('a save error is not retried either (no second set of audio in storage)', async () => {
    vi.mocked(client.waitForJob).mockResolvedValue(done({ stems: ['accomp', 'mix', 'vocals'] }));
    vi.mocked(pipeline.transcribeAudio).mockResolvedValue(result());
    vi.mocked(db.saveSong).mockRejectedValue(new Error('QuotaExceededError'));
    await useImport.getState().importYouTubeViaServer('https://youtu.be/abc', 'abc', true);
    expect(useImport.getState().job!.error).toMatch(/Quota/);
    expect(pipeline.transcribeAudio).toHaveBeenCalledTimes(1);
    expect(db.saveAudio).toHaveBeenCalledTimes(1);
  });

  it('a job whose separation failed: its mix is reused (no second download) and separated in the browser', async () => {
    vi.mocked(client.waitForJob).mockResolvedValue(done({ stems: ['mix'], separationError: 'bad_alloc' }));
    vi.mocked(pipeline.transcribeAudio).mockResolvedValue(result());
    await useImport.getState().importYouTubeViaServer('https://youtu.be/abc', 'abc', true);
    const job = useImport.getState().job!;
    expect(job.stage).toBe('done');
    expect(client.createYouTubeJob).toHaveBeenCalledTimes(1);
    expect(client.fetchStems).not.toHaveBeenCalled();
    expect(vi.mocked(pipeline.transcribeAudio).mock.calls[0][4]).toEqual({ separate: true });
    expect(job.warnings.join(' ')).toMatch(/bad_alloc.*separated in the browser instead/);
  });

  it('on a device where browser separation is not recommended the fallback transcribes the full mix', async () => {
    support.value = { ok: true, recommended: false, reason: 'Phone.', estSecondsPerMinute: 120, maxSeconds: 600 };
    vi.mocked(client.waitForJob).mockResolvedValue(done({ stems: ['mix'], separationError: 'model download failed' }));
    vi.mocked(pipeline.transcribeAudio).mockResolvedValue(result());
    await useImport.getState().importYouTubeViaServer('https://youtu.be/abc', 'abc', true);
    const job = useImport.getState().job!;
    expect(job.stage).toBe('done');
    expect(vi.mocked(pipeline.transcribeAudio).mock.calls[0][4]).toEqual({});
    expect(job.warnings.join(' ')).toMatch(/full mix was transcribed \(separating in this browser is not recommended on this device: Phone\.\)/);
    expect(job.separation).toBeUndefined();
  });
});

describe('file import with a separating server', () => {
  it('a failed server job falls back to the browser only where that is recommended', async () => {
    vi.mocked(client.createSeparationJob).mockRejectedValue(new Error('File too large'));
    vi.mocked(pipeline.transcribeAudio).mockResolvedValue(result());
    const file = new File([new Uint8Array(16)], 'song.mp3', { type: 'audio/mpeg' });
    support.value = { ok: true, recommended: false, reason: 'Low memory.', estSecondsPerMinute: 60, maxSeconds: 600 };
    await useImport.getState().importFile(file, { separate: true });
    expect(vi.mocked(pipeline.transcribeAudio).mock.calls[0][4]).toEqual({});
    expect(useImport.getState().job!.warnings.join(' ')).toMatch(/full mix was transcribed/);
    support.value = { ok: true, recommended: true, estSecondsPerMinute: 60, maxSeconds: 600 };
    await useImport.getState().importFile(file, { separate: true });
    expect(vi.mocked(pipeline.transcribeAudio).mock.calls[1][4]).toEqual({ separate: true });
  });

  it('a browser separation that ran out of memory turns the option off for the preset', async () => {
    useSettings.setState({ backendUrl: '' });
    vi.mocked(pipeline.transcribeAudio).mockResolvedValue({ ...result(), separationFailure: 'memory' });
    useImport.getState().setSeparatePref('mix', true, 'browser');
    await useImport.getState().importFile(new File([new Uint8Array(16)], 'song.mp3', { type: 'audio/mpeg' }), { separate: true });
    expect(useImport.getState().prefs.separate.mix).toBe(false);
    expect(useImport.getState().job!.warnings.join(' ')).toMatch(/now off for this detection preset/);
  });
});

describe('server health cache', () => {
  it('does not cache an unreachable server', async () => {
    const u = 'http://cold.test';
    vi.mocked(client.health).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(healthy);
    expect(await serverHealth(u)).toBeNull();
    expect(await serverHealth(u)).toEqual(healthy);
    expect(client.health).toHaveBeenCalledTimes(2);
    // a reachable one is cached
    expect(await serverHealth(u)).toEqual(healthy);
    expect(client.health).toHaveBeenCalledTimes(2);
  });

  it('a check made elsewhere (Settings) is used by the import', async () => {
    const u = 'http://warm.test';
    rememberServerHealth(u, healthy);
    expect(await serverHealth(u)).toEqual(healthy);
    expect(client.health).not.toHaveBeenCalled();
  });
});

describe('remembered separation choice', () => {
  it('a "yes" given for the server does not turn on browser separation where it is not recommended', () => {
    const notRec: SeparationSupport = { ok: true, recommended: false, reason: 'Phone.', estSecondsPerMinute: 120, maxSeconds: 600 };
    const browserAvail = separationAvailability(false, notRec);
    expect(separationChoice({ separate: { mix: true }, engine: { mix: 'server' } }, 'mix', browserAvail)).toBe(false);
    // ticked for this browser explicitly: kept
    expect(separationChoice({ separate: { mix: true }, engine: { mix: 'browser' } }, 'mix', browserAvail)).toBe(true);
    expect(separationChoice({ separate: { mix: true }, engine: { mix: 'server' } }, 'mix', separationAvailability(true, notRec))).toBe(true);
  });
});

describe('interrupted-import record (crash recovery)', () => {
  beforeEach(() => {
    for (const f of [db.savePending, db.deletePending, db.saveAudio]) vi.mocked(f).mockClear();
    useSettings.setState({ backendUrl: '' });
  });
  const recording = () => new Blob([new Uint8Array(4000)], { type: 'audio/mp4' });
  const meta = { title: 'Recording 1', source: { kind: 'capture' as const, mimeType: 'audio/mp4', fileSize: 4000 } };

  it('is written before the audio is decoded and deleted once the song is saved', async () => {
    let writtenBeforeDecode = false;
    vi.mocked(pipeline.transcribeAudio).mockImplementation(async () => {
      writtenBeforeDecode = vi.mocked(db.savePending).mock.calls.length === 1;
      expect(db.deletePending).not.toHaveBeenCalled();
      return result();
    });
    const blob = recording();
    await useImport.getState().importAudioBlob(blob, { ...meta, separate: false });
    expect(writtenBeforeDecode).toBe(true);
    const rec = vi.mocked(db.savePending).mock.calls[0][0];
    expect(rec).toMatchObject({ title: 'Recording 1', kind: 'capture', blob, mimeType: 'audio/mp4', presetId: 'mix', separate: false });
    expect(rec.fileName).toBe('Recording 1.m4a');
    expect(useImport.getState().job!.stage).toBe('done');
    // the song and the record's deletion are one transaction (a tab killed while saving can't leave both)
    expect(db.saveSong).toHaveBeenCalledWith(expect.objectContaining({ title: 'Recording 1' }), { pendingId: rec.id });
    // the cleanup deletes only the record this run wrote
    await vi.waitFor(() => expect(db.deletePending).toHaveBeenCalledWith(rec.id, rec.startedAt));
  });

  it('a failure deletes the record but keeps "Try again" and the recording for the open page', async () => {
    vi.mocked(pipeline.transcribeAudio).mockRejectedValueOnce(new Error('The audio is (nearly) silent — nothing to transcribe.'));
    const blob = recording();
    await useImport.getState().importAudioBlob(blob, meta);
    const st = useImport.getState();
    expect(st.job!.stage).toBe('error');
    const { id, startedAt } = vi.mocked(db.savePending).mock.calls[0][0];
    await vi.waitFor(() => expect(db.deletePending).toHaveBeenCalledWith(id, startedAt));
    expect(st.failed?.jobId).toBe(st.job!.id);
    expect(st.failed?.recording?.blob).toBe(blob);
    expect(st.failed?.recording?.fileName).toBe('Recording 1.m4a');
    // Try again runs the same import with the same preset
    useSettings.setState({ detectionPreset: 'piano' });
    vi.mocked(pipeline.transcribeAudio).mockResolvedValueOnce(result());
    await st.failed!.retry();
    expect(useImport.getState().job!.stage).toBe('done');
    expect(vi.mocked(db.savePending).mock.calls[1][0]).toMatchObject({ presetId: 'mix', blob });
    expect(useImport.getState().failed).toBeNull();
  });

  it('Cancel deletes the record', async () => {
    let release!: () => void;
    vi.mocked(pipeline.transcribeAudio).mockImplementation(
      (_b, _p, _on, signal) =>
        new Promise((_res, rej) => {
          release = () => rej(new DOMException('Cancelled', 'AbortError'));
          signal?.addEventListener('abort', () => release());
        }),
    );
    const run = useImport.getState().importAudioBlob(recording(), meta);
    await vi.waitFor(() => expect(pipeline.transcribeAudio).toHaveBeenCalled());
    useImport.getState().cancel();
    await run;
    const { id, startedAt } = vi.mocked(db.savePending).mock.calls[0][0];
    await vi.waitFor(() => expect(db.deletePending).toHaveBeenCalledWith(id, startedAt));
    expect(useImport.getState().job).toBeNull();
  });

  it('resuming a record re-runs it with its own preset and options, under the same id', async () => {
    vi.mocked(pipeline.transcribeAudio).mockResolvedValue(result());
    const blob = recording();
    await useImport.getState().resumePending({
      id: 'old-1',
      title: 'Recording 1',
      kind: 'capture',
      source: meta.source,
      blob,
      mimeType: 'audio/mp4',
      fileName: 'Recording 1.m4a',
      startedAt: 1,
      presetId: 'piano',
      separate: false,
    });
    expect(useImport.getState().job!.stage).toBe('done');
    expect(vi.mocked(db.savePending).mock.calls[0][0]).toMatchObject({ id: 'old-1', presetId: 'piano' });
    expect(db.saveSong).toHaveBeenLastCalledWith(expect.anything(), { pendingId: 'old-1' });
    await vi.waitFor(() => expect(db.deletePending).toHaveBeenCalledWith('old-1', expect.any(Number)));
    // a file is resumed as a file
    await useImport.getState().resumePending({
      id: 'old-2',
      title: 'Song',
      kind: 'audio',
      source: { kind: 'audio', fileName: 'song.mp3', mimeType: 'audio/mpeg' },
      blob: new Blob([new Uint8Array(16)], { type: 'audio/mpeg' }),
      mimeType: 'audio/mpeg',
      fileName: 'song.mp3',
      startedAt: 1,
      presetId: 'mix',
      separate: false,
    });
    const last = vi.mocked(pipeline.transcribeAudio).mock.calls.at(-1)![0] as File;
    expect(last).toBeInstanceOf(File);
    expect(last.name).toBe('song.mp3');
  });

  it('storage full while saving: the crash-recovery copy is dropped and the audio stored after all', async () => {
    vi.mocked(pipeline.transcribeAudio).mockResolvedValue(result());
    vi.mocked(db.saveAudio).mockRejectedValueOnce(new DOMException('The quota has been exceeded.', 'QuotaExceededError'));
    vi.mocked(db.saveSong).mockClear();
    await useImport.getState().importAudioBlob(recording(), { ...meta, separate: false });
    const { id, startedAt } = vi.mocked(db.savePending).mock.calls[0][0];
    expect(db.deletePending).toHaveBeenCalledWith(id, startedAt);
    expect(db.saveAudio).toHaveBeenCalledTimes(2);
    expect(vi.mocked(db.saveSong).mock.calls[0][0].hasAudio).toBe(true);
    expect(useImport.getState().job!.stage).toBe('done');
  });

  it('other storage errors while saving keep the arrangement without the audio (no retry)', async () => {
    vi.mocked(pipeline.transcribeAudio).mockResolvedValue(result());
    vi.mocked(db.saveAudio).mockRejectedValueOnce(new Error('disk I/O error'));
    vi.mocked(db.saveSong).mockClear();
    await useImport.getState().importAudioBlob(recording(), { ...meta, separate: false });
    expect(db.saveAudio).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.saveSong).mock.calls[0][0].hasAudio).toBe(false);
    expect(useImport.getState().job!.stage).toBe('done');
  });

  it('the YouTube server path keeps no record (and still saves the song plainly)', async () => {
    vi.mocked(pipeline.transcribeAudio).mockResolvedValue(result());
    useSettings.setState({ backendUrl: 'http://server.test' });
    vi.mocked(client.createYouTubeJob).mockResolvedValue({ id: 'j1' } as never);
    vi.mocked(client.waitForJob).mockResolvedValue({ id: 'j1', status: 'done', title: 'Video' } as never);
    vi.mocked(client.getJobAudio).mockResolvedValue(new Blob([new Uint8Array(4000)], { type: 'audio/mp4' }));
    vi.mocked(db.saveSong).mockClear();
    const songId = await useImport.getState().importYouTubeViaServer('https://youtu.be/x', 'x', false);
    expect(songId).toBeTruthy();
    expect(db.savePending).not.toHaveBeenCalled();
    expect(vi.mocked(db.saveSong).mock.calls[0][1]).toBeUndefined();
  });

  it('big files are not copied (the record only says which file it was)', async () => {
    vi.mocked(pipeline.transcribeAudio).mockResolvedValue(result());
    const { PENDING_COPY_MAX_BYTES } = await import('../../src/state/importStore');
    const big = new File([new Uint8Array(16)], 'film.mp4', { type: 'video/mp4' });
    Object.defineProperty(big, 'size', { value: PENDING_COPY_MAX_BYTES + 1 });
    await useImport.getState().importFile(big, { separate: false });
    const rec = vi.mocked(db.savePending).mock.calls[0][0];
    expect(rec.blob).toBeUndefined();
    expect(rec.fileName).toBe('film.mp4');
  });
});

describe('high-accuracy piano model (piano specialist)', () => {
  beforeEach(() => {
    for (const f of [db.savePending, db.saveAudio, db.savePosteriors, db.saveSong]) vi.mocked(f).mockClear();
    useSettings.setState({ backendUrl: '', detectionPreset: 'piano' });
    useImport.getState().setPianoModelPref(false);
    specialist.available = true;
  });
  const file = () => new File([new Uint8Array(16)], 'piece.mp3', { type: 'audio/mpeg' });
  /** what the pipeline returns for the specialist: no posteriors */
  const specialistResult = (): TranscriptionResult => ({
    ...result(),
    posteriors: undefined,
    info: { method: 'piano-specialist', estimated: true, warnings: [] } as unknown as TranscriptionResult['info'],
  });

  it('is off unless ticked, and only used with "Piano solo" where the browser can run it', () => {
    expect(transcriberChoice({ separate: {} }, 'piano', true)).toBe('basic-pitch');
    expect(transcriberChoice({ separate: {}, pianoModel: true }, 'piano', true)).toBe('piano-specialist');
    expect(transcriberChoice({ separate: {}, pianoModel: true }, 'mix', true)).toBe('basic-pitch');
    expect(transcriberChoice({ separate: {}, pianoModel: true }, 'sensitive', true)).toBe('basic-pitch');
    expect(transcriberChoice({ separate: {}, pianoModel: true }, 'piano', false)).toBe('basic-pitch');
  });

  it('saves the specialist’s notes as played, with the pedal heard in the recording on Medium and Hard (automatic pedal off)', async () => {
    useImport.getState().setPianoModelPref(true);
    const pedal = [{ start: 0.2, end: 1.4 }];
    vi.mocked(pipeline.transcribeAudio).mockResolvedValue({ ...specialistResult(), pedal });
    await useImport.getState().importFile(file());
    const song = vi.mocked(db.saveSong).mock.calls[0][0];
    expect(song).toMatchObject({ noteLength: 'played', autoPedal: false, basePedal: pedal });
    expect(song.arrangements.hard.pedal).toEqual(pedal);
    expect(song.arrangements.medium.pedal).toEqual(pedal);
    expect(song.arrangements.easy.pedal).toEqual([]);
    // Basic Pitch results (no pedal): automatic pedal on, no note length, as before
    vi.mocked(db.saveSong).mockClear();
    useImport.getState().setPianoModelPref(false);
    vi.mocked(pipeline.transcribeAudio).mockResolvedValue(result());
    await useImport.getState().importFile(file());
    const bp = vi.mocked(db.saveSong).mock.calls[0][0];
    expect(bp.autoPedal).toBe(true);
    expect(bp.basePedal).toEqual([]);
    expect('noteLength' in bp).toBe(false);
  });

  it('the choice is kept in the import prefs; older prefs (without it) still load', () => {
    useImport.getState().setPianoModelPref(true);
    expect(useImport.getState().prefs.pianoModel).toBe(true);
    useImport.getState().setPianoModelPref(false);
    expect(useImport.getState().prefs.pianoModel).toBeUndefined();
    expect(parsePrefs('{"separate":{"mix":true},"engine":{"mix":"server"}}')).toEqual({ separate: { mix: true }, engine: { mix: 'server' } });
    expect(parsePrefs('{"separate":{},"pianoModel":true}').pianoModel).toBe(true);
    expect(parsePrefs('{"separate":{},"pianoModel":"yes"}').pianoModel).toBeUndefined();
    expect(parsePrefs('not json')).toEqual({ separate: {} });
  });

  it('a ticked choice runs the specialist (no separation), keeps it in the crash record and saves no posteriors', async () => {
    useImport.getState().setPianoModelPref(true);
    vi.mocked(pipeline.transcribeAudio).mockResolvedValue(specialistResult());
    await useImport.getState().importFile(file(), { separate: true });
    const job = useImport.getState().job!;
    expect(job.stage).toBe('done');
    expect(job.transcriber).toBe('piano-specialist');
    expect(vi.mocked(pipeline.transcribeAudio).mock.calls[0][4]).toEqual({ engine: 'piano-specialist' });
    expect(job.warnings.join(' ')).toMatch(/not used with the high-accuracy piano model/);
    expect(vi.mocked(db.savePending).mock.calls[0][0]).toMatchObject({ transcriber: 'piano-specialist', separate: false, presetId: 'piano' });
    expect(db.savePosteriors).not.toHaveBeenCalled();
    expect(vi.mocked(db.saveSong).mock.calls[0][0]).toMatchObject({ hasPosteriors: false, hasAudio: true });
  });

  it('Basic Pitch imports are unchanged (no engine option, no field in the record)', async () => {
    vi.mocked(pipeline.transcribeAudio).mockResolvedValue(result());
    await useImport.getState().importFile(file(), { separate: false });
    expect(vi.mocked(pipeline.transcribeAudio).mock.calls[0][4]).toEqual({});
    expect(vi.mocked(db.savePending).mock.calls[0][0]).not.toHaveProperty('transcriber');
    expect(useImport.getState().job!.transcriber).toBeUndefined();
    expect(db.savePosteriors).toHaveBeenCalledTimes(1);
  });

  it('an explicit model wins over the remembered choice (the Record tab passes Basic Pitch)', async () => {
    useImport.getState().setPianoModelPref(true);
    vi.mocked(pipeline.transcribeAudio).mockResolvedValue(result());
    await useImport.getState().importAudioBlob(new Blob([new Uint8Array(4000)], { type: 'audio/mp4' }), {
      title: 'Recording',
      source: { kind: 'capture', mimeType: 'audio/mp4', fileSize: 4000 },
      transcriber: 'basic-pitch',
    });
    expect(vi.mocked(pipeline.transcribeAudio).mock.calls[0][4]).toEqual({});
  });

  it('Try again (open page) follows the model selected now; "Try with the normal model" selects and runs the fast one', async () => {
    useImport.getState().setPianoModelPref(true);
    vi.mocked(pipeline.transcribeAudio).mockRejectedValue(new Error('The high-accuracy piano model ran out of memory on this device.'));
    await useImport.getState().importFile(file(), { separate: false });
    expect(vi.mocked(pipeline.transcribeAudio).mock.calls[0][4]).toEqual({ engine: 'piano-specialist' });
    let failed = useImport.getState().failed!;
    expect(failed.retryFast).toBeTypeOf('function');
    // still selected: the same model again
    await failed.retry();
    expect(vi.mocked(pipeline.transcribeAudio).mock.calls[1][4]).toEqual({ engine: 'piano-specialist' });
    // the user switched the radio to the normal model: Try again runs what the page shows
    failed = useImport.getState().failed!;
    useImport.getState().setPianoModelPref(false);
    vi.mocked(pipeline.transcribeAudio).mockResolvedValueOnce(result());
    await failed.retry();
    expect(vi.mocked(pipeline.transcribeAudio).mock.calls[2][4]).toEqual({});
    expect(useImport.getState().job!.stage).toBe('done');

    // the error card's second button
    useImport.getState().setPianoModelPref(true);
    await useImport.getState().importAudioBlob(new Blob([new Uint8Array(4000)], { type: 'audio/mp4' }), {
      title: 'Recording',
      source: { kind: 'capture', mimeType: 'audio/mp4', fileSize: 4000 },
    });
    expect(vi.mocked(pipeline.transcribeAudio).mock.calls[3][4]).toEqual({ engine: 'piano-specialist' });
    vi.mocked(pipeline.transcribeAudio).mockResolvedValueOnce(result());
    await useImport.getState().failed!.retryFast!();
    expect(vi.mocked(pipeline.transcribeAudio).mock.calls[4][4]).toEqual({});
    expect(useImport.getState().prefs.pianoModel).toBeUndefined();
    expect(useImport.getState().job!.stage).toBe('done');

    // Basic Pitch failures have no fast alternative to offer
    vi.mocked(pipeline.transcribeAudio).mockRejectedValueOnce(new Error('boom'));
    await useImport.getState().importFile(file(), { separate: false });
    expect(useImport.getState().failed!.retryFast).toBeUndefined();
    vi.mocked(pipeline.transcribeAudio).mockReset();
  });

  it('a resumed record uses its own model, except where the high-accuracy run took the tab down or memory is tight', async () => {
    vi.mocked(pipeline.transcribeAudio).mockResolvedValue(specialistResult());
    const rec = {
      id: 'old-pti',
      title: 'Piece',
      kind: 'audio' as const,
      source: { kind: 'audio' as const, fileName: 'piece.mp3', mimeType: 'audio/mpeg' },
      blob: new Blob([new Uint8Array(16)], { type: 'audio/mpeg' }),
      mimeType: 'audio/mpeg',
      fileName: 'piece.mp3',
      startedAt: 1,
      presetId: 'piano',
      separate: false,
    };
    // a desktop (the test runner) that can run it: the same model, whatever is ticked now
    await useImport.getState().resumePending({ ...rec, transcriber: 'piano-specialist' } as typeof rec);
    expect(vi.mocked(pipeline.transcribeAudio).mock.calls.at(-1)![4]).toEqual({ engine: 'piano-specialist' });
    // an older record (no field) stays on Basic Pitch even with the box ticked now
    useImport.getState().setPianoModelPref(true);
    await useImport.getState().resumePending(rec);
    expect(vi.mocked(pipeline.transcribeAudio).mock.calls.at(-1)![4]).toEqual({});
    // a browser that can no longer run the specialist resumes with Basic Pitch
    specialist.available = false;
    await useImport.getState().resumePending({ ...rec, transcriber: 'piano-specialist' } as typeof rec);
    expect(vi.mocked(pipeline.transcribeAudio).mock.calls.at(-1)![4]).toEqual({});

    const spec = { id: 'r1', transcriber: 'piano-specialist' as const };
    expect(resumeTranscriber(spec, { available: true, constrained: false, crashed: false })).toBe('piano-specialist');
    // phones / ≤ 4 GB: a killed tab almost always means the model ran out of memory
    expect(resumeTranscriber(spec, { available: true, constrained: true, crashed: false })).toBe('basic-pitch');
    expect(resumeTranscriber(spec, { available: true, constrained: false, crashed: true })).toBe('basic-pitch');
    expect(resumeTranscriber({ id: 'r2' }, { available: true, constrained: false, crashed: false })).toBe('basic-pitch');
  });

  it('the interrupted-import notice says which model Try again uses', () => {
    const rec = { title: 'Piece', kind: 'audio' as const, blob: new Blob(['x']), transcriber: 'piano-specialist' };
    expect(interruptedNotice(rec, 'basic-pitch').body).toMatch(/Try again uses the normal model/);
    expect(interruptedNotice(rec, 'piano-specialist').body).toMatch(/Try again uses the high-accuracy piano model again/);
    expect(interruptedNotice({ ...rec, transcriber: undefined }, 'basic-pitch').body).not.toMatch(/Solo piano/);
    expect(interruptedNotice({ ...rec, blob: undefined }, 'basic-pitch').body).not.toMatch(/Try again/);
  });
});

describe('crash marker for the high-accuracy piano model', () => {
  /** Web Locks and localStorage as a browser tab has them */
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
    for (const f of [db.savePending, db.saveSong]) vi.mocked(f).mockClear();
    useSettings.setState({ backendUrl: '', detectionPreset: 'piano' });
    specialist.available = true;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useImport.getState().setPianoModelPref(false);
  });
  const file = () => new File([new Uint8Array(16)], 'piece.mp3', { type: 'audio/mpeg' });

  it('is set (with its lock) while the model runs and removed afterwards; Basic Pitch sets none', async () => {
    useImport.getState().setPianoModelPref(true);
    let during: { pendingId?: string; at?: number } | null = null;
    let locked = false;
    vi.mocked(pipeline.transcribeAudio).mockImplementationOnce(async () => {
      during = JSON.parse(store.get(SPECIALIST_RUNNING_KEY) ?? 'null');
      locked = held.has(SPECIALIST_RUNNING_KEY);
      return { ...result(), posteriors: undefined };
    });
    await useImport.getState().importFile(file(), { separate: false });
    expect(during).toMatchObject({ pendingId: vi.mocked(db.savePending).mock.calls[0][0].id });
    expect(locked).toBe(true);
    expect(store.has(SPECIALIST_RUNNING_KEY)).toBe(false);
    await vi.waitFor(() => expect(held.has(SPECIALIST_RUNNING_KEY)).toBe(false));
    // a failed run removes it too
    vi.mocked(pipeline.transcribeAudio).mockRejectedValueOnce(new Error('boom'));
    await useImport.getState().importFile(file(), { separate: false });
    expect(store.has(SPECIALIST_RUNNING_KEY)).toBe(false);

    useImport.getState().setPianoModelPref(false);
    vi.mocked(pipeline.transcribeAudio).mockImplementationOnce(async () => {
      during = JSON.parse(store.get(SPECIALIST_RUNNING_KEY) ?? 'null');
      return result();
    });
    await useImport.getState().importFile(file(), { separate: false });
    expect(during).toBeNull();
  });

  it('a marker left by a dead tab turns the choice off, and its record resumes with the normal model', async () => {
    useImport.getState().setPianoModelPref(true);
    store.set(SPECIALIST_RUNNING_KEY, JSON.stringify({ pendingId: 'crashed-1', at: Date.now() - 60_000 }));
    const turnOff = vi.fn(() => useImport.getState().setPianoModelPref(false));
    expect(await checkCrashedSpecialist(turnOff)).toBe(true);
    expect(turnOff).toHaveBeenCalledTimes(1);
    expect(useImport.getState().prefs.pianoModel).toBeUndefined();
    expect(store.has(SPECIALIST_RUNNING_KEY)).toBe(false);
    expect(resumeTranscriber({ id: 'crashed-1', transcriber: 'piano-specialist' }, { available: true, constrained: false })).toBe('basic-pitch');
    expect(resumeTranscriber({ id: 'other', transcriber: 'piano-specialist' }, { available: true, constrained: false })).toBe('piano-specialist');
    // Try again on that record
    vi.mocked(pipeline.transcribeAudio).mockResolvedValueOnce(result());
    await useImport.getState().resumePending({
      id: 'crashed-1',
      title: 'Piece',
      kind: 'audio',
      source: { kind: 'audio', fileName: 'piece.mp3', mimeType: 'audio/mpeg' },
      blob: new Blob([new Uint8Array(16)], { type: 'audio/mpeg' }),
      mimeType: 'audio/mpeg',
      fileName: 'piece.mp3',
      startedAt: 1,
      presetId: 'piano',
      separate: false,
      transcriber: 'piano-specialist',
    } as Parameters<ReturnType<typeof useImport.getState>['resumePending']>[0]);
    expect(vi.mocked(pipeline.transcribeAudio).mock.calls.at(-1)![4]).toEqual({});
    // checked once: a second look finds nothing
    expect(await checkCrashedSpecialist(turnOff)).toBe(false);
  });

  it('leaves a marker alone while another tab runs the model, and drops stale ones silently', async () => {
    store.set(SPECIALIST_RUNNING_KEY, JSON.stringify({ pendingId: 'p', at: Date.now() }));
    held.add(SPECIALIST_RUNNING_KEY);
    const turnOff = vi.fn();
    expect(await checkCrashedSpecialist(turnOff)).toBe(false);
    expect(store.has(SPECIALIST_RUNNING_KEY)).toBe(true);
    held.clear();
    store.set(SPECIALIST_RUNNING_KEY, JSON.stringify({ at: Date.now() - 7 * 3600_000 }));
    expect(await checkCrashedSpecialist(turnOff)).toBe(false);
    expect(store.has(SPECIALIST_RUNNING_KEY)).toBe(false);
    expect(turnOff).not.toHaveBeenCalled();
  });
});

describe('sheet-music import', () => {
  const xml = `<?xml version="1.0"?><score-partwise version="4.0"><work><work-title>Minuet</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name></score-part><score-part id="P2"><part-name>Flute</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>3</beats><beat-type>4</beat-type></time><staves>2</staves></attributes><note><pitch><step>C</step><octave>5</octave></pitch><duration>3</duration><staff>1</staff></note><backup><duration>3</duration></backup><note><pitch><step>C</step><octave>3</octave></pitch><duration>3</duration><staff>2</staff></note><barline location="right"><repeat direction="backward"/></barline></measure></part>
<part id="P2"><measure number="1"><attributes><divisions>1</divisions></attributes><note><pitch><step>G</step><octave>5</octave></pitch><duration>3</duration></note></measure></part></score-partwise>`;

  it('a .musicxml file becomes an exact song (source "score") with the file’s notes shown on the import card', async () => {
    const id = await useImport.getState().importFile(new File([xml], 'minuet.musicxml', { type: '' }));
    const job = useImport.getState().job!;
    expect(job.stage).toBe('done');
    expect(job.kind).toBe('score');
    expect(job.plan).toEqual(['validating', 'arranging', 'saving']);
    expect(job.warnings.join(' ')).toMatch(/2 parts/);
    const song = vi.mocked(db.saveSong).mock.calls[0][0];
    expect(song.id).toBe(id);
    expect(song.title).toBe('Minuet');
    expect(song.source).toMatchObject({ kind: 'score', fileName: 'minuet.musicxml' });
    expect(song.transcription).toMatchObject({ method: 'score-file', estimated: false });
    // the repeat is played out: 2 × (C5, C3, G5)
    expect(song.base.length).toBe(6);
    expect(song.tempo.beatsPerBar).toBe(3);
  });

  it('a damaged file fails with a plain message; MusicXML text can be imported directly (PDF / photo hook)', async () => {
    await useImport.getState().importFile(new File(['not a score'], 'broken.mxl'));
    expect(useImport.getState().job!.stage).toBe('error');
    expect(useImport.getState().job!.error).toMatch(/damaged/);
    const id = await useImport.getState().importMusicXml(xml, { fileName: 'scan.pdf', title: 'Scanned minuet' });
    expect(id).toBeTruthy();
    const song = vi.mocked(db.saveSong).mock.calls.at(-1)![0];
    expect(song.title).toBe('Scanned minuet');
    expect(song.source).toMatchObject({ kind: 'score', fileName: 'scan.pdf' });
  });
});

describe('"Full song + piano model" (piano-model blend)', () => {
  let store: Map<string, string>;
  let held: Set<string>;
  const desktop = 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140';
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const browser = (ua: string, deviceMemory?: number) => {
    vi.stubGlobal('navigator', {
      userAgent: ua,
      maxTouchPoints: ua === iphone ? 5 : 0,
      ...(deviceMemory ? { deviceMemory } : {}),
      locks: {
        request: (name: string, cb: () => Promise<void>) => {
          held.add(name);
          return Promise.resolve(cb()).finally(() => held.delete(name));
        },
        query: async () => ({ held: [...held].map((name) => ({ name })) }),
      },
    });
  };
  beforeEach(() => {
    store = new Map();
    held = new Set();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    browser(desktop, 16);
    for (const f of [db.savePending, db.saveSong, db.savePosteriors]) vi.mocked(f).mockClear();
    useSettings.setState({ backendUrl: '', detectionPreset: 'mix' });
    specialist.available = true;
    useImport.setState({ prefs: { separate: {} } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    useImport.setState({ prefs: { separate: {} } });
  });
  const file = () => new File([new Uint8Array(16)], 'band.mp3', { type: 'audio/mpeg' });

  it('is offered for Full song where the piano model runs, separation runs in this browser and memory is not tight', () => {
    const ok = { specialist: true, constrained: false, browserSeparation: true };
    expect(pianoBlendAvailability(ok)).toEqual({ available: true });
    expect(pianoBlendAvailability({ ...ok, constrained: true }).reason).toBe('Not recommended on this device: it needs about 0.8 GB more memory and may close the tab.');
    expect(pianoBlendAvailability({ ...ok, browserSeparation: false }).reason).toBe('Needs in-browser instrument separation.');
    expect(pianoBlendAvailability({ ...ok, specialist: false }).available).toBe(false);
    // default (opt-in until the thresholds are tuned), the remembered choice, never where it cannot run
    expect(PIANO_BLEND_DEFAULT).toBe(false);
    expect(pianoBlendChoice({ separate: {} }, 'mix', { available: true })).toBe(PIANO_BLEND_DEFAULT);
    expect(pianoBlendChoice({ separate: {}, pianoBlend: true }, 'mix', { available: true })).toBe(true);
    expect(pianoBlendChoice({ separate: {}, pianoBlend: true }, 'piano', { available: true })).toBe(false);
    expect(pianoBlendChoice({ separate: {}, pianoBlend: true }, 'mix', { available: false })).toBe(false);
  });

  it('the choice is remembered in the import prefs (on and off); older prefs still load', () => {
    useImport.getState().setPianoBlendPref(true);
    expect(useImport.getState().prefs.pianoBlend).toBe(true);
    expect(JSON.parse(store.get('piano2vision-import-prefs')!).pianoBlend).toBe(true);
    useImport.getState().setPianoBlendPref(false);
    expect(useImport.getState().prefs.pianoBlend).toBe(false);
    expect(parsePrefs('{"separate":{},"pianoBlend":false}').pianoBlend).toBe(false);
    expect(parsePrefs('{"separate":{},"pianoBlend":"yes"}')).not.toHaveProperty('pianoBlend');
    expect(parsePrefs('{"separate":{"mix":true}}')).toEqual({ separate: { mix: true }, engine: {} });
  });

  it('a ticked choice asks the pipeline for the blend (browser separation only), plans its stage and keeps it in the crash record', async () => {
    useImport.getState().setPianoBlendPref(true);
    vi.mocked(pipeline.transcribeAudio).mockResolvedValue(result());
    await useImport.getState().importFile(file(), { separate: true });
    const opts = vi.mocked(pipeline.transcribeAudio).mock.calls[0][4]!;
    expect(opts.separate).toBe(true);
    expect(opts.pianoBlend).toBe(true);
    expect(typeof opts.onPhase).toBe('function');
    expect(useImport.getState().job!.plan).toContain('piano-model');
    expect(STAGE_LABELS['piano-model']).toBe('Piano model: keyboard parts and in-between notes');
    expect(vi.mocked(db.savePending).mock.calls[0][0]).toMatchObject({ pianoBlend: true, separate: true });
    // without separation (or Piano solo): nothing asked
    vi.mocked(pipeline.transcribeAudio).mockClear();
    await useImport.getState().importFile(file(), { separate: false });
    expect(vi.mocked(pipeline.transcribeAudio).mock.calls[0][4]).toEqual({});
    vi.mocked(pipeline.transcribeAudio).mockClear();
    useSettings.setState({ detectionPreset: 'piano' });
    await useImport.getState().importFile(file(), { separate: true });
    expect(vi.mocked(pipeline.transcribeAudio).mock.calls[0][4]).toEqual({ separate: true });
  });

  it('a song the blend does not run on (a sung line): its stage leaves the checklist', async () => {
    useImport.getState().setPianoBlendPref(true);
    let planDuring: string[] | undefined;
    vi.mocked(pipeline.transcribeAudio).mockImplementationOnce(async (_b, _p, _o, _s, opts) => {
      opts!.onPhase!('piano-blend-skipped');
      planDuring = [...useImport.getState().job!.plan];
      // the crash marker stays at separation: the piano model never ran
      expect(store.has(BLEND_RUNNING_KEY)).toBe(false);
      return result();
    });
    await useImport.getState().importFile(file(), { separate: true });
    expect(planDuring).not.toContain('piano-model');
    expect(planDuring).toContain('separating');
  });

  it('unticked (the default): the pipeline gets exactly what it got before', async () => {
    vi.mocked(pipeline.transcribeAudio).mockResolvedValue(result());
    await useImport.getState().importFile(file(), { separate: true });
    expect(vi.mocked(pipeline.transcribeAudio).mock.calls[0][4]).toEqual({ separate: true });
    expect(vi.mocked(db.savePending).mock.calls[0][0]).not.toHaveProperty('pianoBlend');
    expect(useImport.getState().job!.plan).not.toContain('piano-model');
  });

  it('a phone (memory-constrained) never runs it, even with the choice remembered', async () => {
    browser(iphone);
    useImport.getState().setPianoBlendPref(true);
    vi.mocked(pipeline.transcribeAudio).mockResolvedValue(result());
    await useImport.getState().importFile(file(), { separate: true });
    expect(vi.mocked(pipeline.transcribeAudio).mock.calls[0][4]).toEqual({ separate: true });
    // a desktop reporting little memory: the same
    browser(desktop, 2);
    vi.mocked(pipeline.transcribeAudio).mockClear();
    await useImport.getState().importFile(file(), { separate: true, pianoBlend: true });
    expect(vi.mocked(pipeline.transcribeAudio).mock.calls[0][4]).toEqual({ separate: true });
  });

  it('the crash marker moves from separation to the blend; a tab that died there resumes with separation on and the blend off', async () => {
    useImport.getState().setPianoBlendPref(true);
    let atSeparation: string | undefined;
    let atBlend: string | undefined;
    let separationAfterPhase: string | undefined;
    vi.mocked(pipeline.transcribeAudio).mockImplementationOnce(async (_b, _p, _o, _s, opts) => {
      atSeparation = store.get('piano2vision-separating');
      opts!.onPhase!('piano-blend');
      atBlend = store.get(BLEND_RUNNING_KEY);
      separationAfterPhase = store.get('piano2vision-separating');
      return result();
    });
    await useImport.getState().importFile(file(), { separate: true });
    const pendingId = vi.mocked(db.savePending).mock.calls[0][0].id;
    expect(atSeparation).toBeDefined();
    expect(JSON.parse(atBlend!)).toMatchObject({ pendingId });
    expect(separationAfterPhase).toBeUndefined();
    expect(store.has(BLEND_RUNNING_KEY)).toBe(false);

    // a dead tab's marker: the choice is turned off, separation stays on, the record resumes without the blend
    store.set(BLEND_RUNNING_KEY, JSON.stringify({ pendingId: 'crashed-b', at: Date.now() - 30_000 }));
    const turnOff = vi.fn(() => useImport.getState().setPianoBlendPref(false));
    expect(await checkCrashedBlend(turnOff)).toBe(true);
    expect(useImport.getState().prefs.pianoBlend).toBe(false);
    expect(useImport.getState().prefs.separate.mix).not.toBe(false);
    expect(resumeBlend({ id: 'crashed-b', pianoBlend: true })).toBe(false);
    expect(resumeBlend({ id: 'other', pianoBlend: true })).toBe(true);
    expect(resumeBlend({ id: 'old' })).toBe(false);
    vi.mocked(pipeline.transcribeAudio).mockClear();
    vi.mocked(pipeline.transcribeAudio).mockResolvedValueOnce(result());
    await useImport.getState().resumePending({
      id: 'crashed-b',
      title: 'Band',
      kind: 'audio',
      source: { kind: 'audio', fileName: 'band.mp3', mimeType: 'audio/mpeg' },
      blob: new Blob([new Uint8Array(16)], { type: 'audio/mpeg' }),
      mimeType: 'audio/mpeg',
      fileName: 'band.mp3',
      startedAt: 1,
      presetId: 'mix',
      separate: true,
      pianoBlend: true,
    } as Parameters<ReturnType<typeof useImport.getState>['resumePending']>[0]);
    expect(vi.mocked(pipeline.transcribeAudio).mock.calls[0][4]).toEqual({ separate: true });
    expect(await checkCrashedBlend(turnOff)).toBe(false);
  });
});
