/**
 * "Computer sound" recording (src/lib/audio/tabAudio.ts) with the browser's share dialog
 * (getDisplayMedia) and MediaRecorder replaced by stand-ins: only the shared sound is recorded, the
 * share is stopped afterwards, and the recording goes through the same crash-safe import as a
 * microphone recording (a pending record written first, deleted once the song is saved).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptionResult } from '../../src/lib/transcription/pipeline';

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
vi.mock('../../src/lib/pianoSpecialist', () => ({
  pianoSpecialistSupport: () => ({ available: true, recommended: true, downloadMB: 49, estSecondsPerMinute: 30 }),
  runPianoSpecialist: vi.fn(),
}));

const pipeline = await import('../../src/lib/transcription/pipeline');
const db = await import('../../src/lib/storage/db');
const { useImport } = await import('../../src/state/importStore');
const { useSettings } = await import('../../src/state/settingsStore');
const { startTabAudioCapture, NO_SOUND_SHARED } = await import('../../src/lib/audio/tabAudio');

function result(): TranscriptionResult {
  return {
    notes: [{ id: 1, midi: 60, start: 0, dur: 0.5, vel: 0.7, hand: 'R' }],
    duration: 10,
    tempo: { bpm: 120, beats: [0, 0.5, 1], beatsPerBar: 4, downbeatIndex: 0, confidence: 0.8, source: 'estimated' },
    posteriors: { nFrames: 1, frames: new Uint8Array(88), onsets: new Uint8Array(88), rms: new Uint8Array(1) } as unknown as TranscriptionResult['posteriors'],
    info: { method: 'basic-pitch', estimated: true, backend: 'wasm', warnings: [], confidence: 0.5 } as unknown as TranscriptionResult['info'],
  };
}

/** A shared track: stop() ends it; 'ended' listeners fire when the browser's "Stop sharing" is used. */
class FakeTrack {
  readyState: 'live' | 'ended' = 'live';
  private listeners: (() => void)[] = [];
  constructor(readonly kind: 'audio' | 'video') {}
  stop() {
    this.readyState = 'ended';
  }
  addEventListener(type: string, fn: () => void) {
    if (type === 'ended') this.listeners.push(fn);
  }
  /** what the browser does when the user presses its own "Stop sharing" */
  endFromBrowser() {
    this.stop();
    for (const fn of this.listeners) fn();
  }
}

class FakeStream {
  constructor(readonly tracks: FakeTrack[]) {}
  getTracks() {
    return this.tracks;
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
}

/** Records 3 one-second chunks of "sound" from whatever stream it was given. */
class FakeRecorder {
  static last: FakeRecorder | null = null;
  static isTypeSupported = (m: string) => m === 'audio/webm;codecs=opus';
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  readonly mimeType: string;
  constructor(
    readonly stream: FakeStream,
    opts?: { mimeType?: string },
  ) {
    this.mimeType = opts?.mimeType ?? '';
    FakeRecorder.last = this;
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    for (let i = 0; i < 3; i++) this.ondataavailable?.({ data: new Blob([new Uint8Array(2000)]) });
    queueMicrotask(() => this.onstop?.());
  }
}

let shared: FakeStream | null = null;
let withSound = true;
const getDisplayMedia = vi.fn(async (_opts: DisplayMediaStreamOptions) => {
  shared = new FakeStream(withSound ? [new FakeTrack('video'), new FakeTrack('audio')] : [new FakeTrack('video')]);
  return shared as unknown as MediaStream;
});

beforeEach(() => {
  withSound = true;
  shared = null;
  getDisplayMedia.mockClear();
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('MediaStream', FakeStream);
  vi.stubGlobal('navigator', { ...globalThis.navigator, mediaDevices: { getDisplayMedia } });
  for (const f of [db.savePending, db.deletePending, db.saveSong, db.saveAudio]) vi.mocked(f).mockClear();
  vi.mocked(pipeline.transcribeAudio).mockReset();
  useSettings.setState({ backendUrl: '', detectionPreset: 'mix' });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('recording the sound of another tab', () => {
  it('asks for a tab with its sound, records only the sound, and stops sharing afterwards', async () => {
    const c = await startTabAudioCapture();
    const opts = getDisplayMedia.mock.calls[0][0] as DisplayMediaStreamOptions & Record<string, unknown>;
    expect(opts.audio).toBeTruthy();
    expect(opts.selfBrowserSurface).toBe('exclude'); // this page itself would only record silence
    const rec = FakeRecorder.last!;
    expect(rec.stream.getTracks().map((t) => t.kind)).toEqual(['audio']);
    expect(rec.state).toBe('recording');
    const blob = await c.stop();
    expect(blob.size).toBe(6000);
    expect(blob.type).toBe('audio/webm;codecs=opus');
    expect(shared!.getTracks().every((t) => t.readyState === 'ended')).toBe(true);
  });

  it('sharing without sound: a plain message, and the share is stopped', async () => {
    withSound = false;
    await expect(startTabAudioCapture()).rejects.toThrow(NO_SOUND_SHARED);
    expect(shared!.getTracks().every((t) => t.readyState === 'ended')).toBe(true);
  });

  it('the browser’s own "Stop sharing" is reported once, and the recording can still be kept', async () => {
    const c = await startTabAudioCapture();
    const ended = vi.fn();
    c.onEnded(ended);
    for (const t of shared!.getTracks()) t.endFromBrowser();
    expect(ended).toHaveBeenCalledTimes(1);
    expect((await c.stop()).size).toBe(6000);
  });

  it('Cancel throws the recording away and stops sharing', async () => {
    const c = await startTabAudioCapture();
    c.cancel();
    expect(shared!.getTracks().every((t) => t.readyState === 'ended')).toBe(true);
    expect(FakeRecorder.last!.state).toBe('inactive');
  });
});

describe('a computer-sound recording is imported like a microphone recording', () => {
  it('a crash-recovery record is written before transcribing and deleted once the song is saved', async () => {
    const c = await startTabAudioCapture();
    const blob = await c.stop();
    let pendingFirst = false;
    vi.mocked(pipeline.transcribeAudio).mockImplementation(async () => {
      pendingFirst = vi.mocked(db.savePending).mock.calls.length === 1;
      return result();
    });
    // what the Computer sound tab does on "Stop & transcribe" (src/pages/Import.tsx)
    await useImport.getState().importAudioBlob(blob, { title: 'Tone test', source: { kind: 'capture', mimeType: blob.type, fileSize: blob.size }, separate: false, transcriber: 'basic-pitch' });
    expect(pendingFirst).toBe(true);
    const rec = vi.mocked(db.savePending).mock.calls[0][0];
    expect(rec).toMatchObject({ title: 'Tone test', kind: 'capture', blob, mimeType: 'audio/webm;codecs=opus', separate: false });
    expect(rec.fileName).toBe('Tone test.webm');
    expect(useImport.getState().job!.stage).toBe('done');
    expect(db.saveSong).toHaveBeenCalledWith(expect.objectContaining({ title: 'Tone test' }), { pendingId: rec.id });
    await vi.waitFor(() => expect(db.deletePending).toHaveBeenCalledWith(rec.id, rec.startedAt));
  });

  it('a failed import keeps the recording for "Try again" and download', async () => {
    const blob = await (await startTabAudioCapture()).stop();
    vi.mocked(pipeline.transcribeAudio).mockRejectedValueOnce(new Error('The audio is (nearly) silent — nothing to transcribe.'));
    await useImport.getState().importAudioBlob(blob, { title: 'Tone test', source: { kind: 'capture', mimeType: blob.type, fileSize: blob.size } });
    const st = useImport.getState();
    expect(st.job!.stage).toBe('error');
    expect(st.failed?.recording?.blob).toBe(blob);
  });
});
