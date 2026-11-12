/**
 * Import flows with the processing server, the pipeline and storage mocked: which errors start the
 * separation fallback, where the fallback runs, and the server health cache.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
const { useImport, serverHealth, rememberServerHealth, separationChoice, separationAvailability } = await import('../../src/state/importStore');
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
