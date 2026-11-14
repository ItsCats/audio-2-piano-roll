/**
 * "Remove singing and drums" (Piano solo with separation: TranscribeOptions.pianoPart) through the real
 * transcribeAudio, with the decoder, the Basic Pitch worker, the separation and the piano model faked:
 * what each model is given, in which order, and what the result records.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeparationResult } from '../../src/lib/separation';
import type { Note } from '../../src/lib/music/types';

const SR = 22050;
const SECONDS = 4;
const N = SR * SECONDS;
/** orthogonal tones over the 4 s: the piano part ("other"), the bass, the singer */
const tone = (f: number, a: number, n = N, rate = SR) => Float32Array.from({ length: n }, (_, i) => a * Math.sin((2 * Math.PI * f * i) / rate));
const other = tone(440, 0.4);
const bass = tone(55, 0.3);
const vocals = tone(660, 0.4);
const mix22 = Float32Array.from(other, (v, i) => v + bass[i] + vocals[i]);
const mix16 = tone(440, 0.5, 16000 * SECONDS, 16000);

vi.mock('../../src/lib/transcription/decode', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/transcription/decode')>()),
  decodeToRate: vi.fn(async (_blob: Blob, rate: number) => {
    const data = rate === 16000 ? mix16 : mix22;
    return { numberOfChannels: 1, length: data.length, sampleRate: rate, duration: data.length / rate, getChannelData: () => data } as unknown as AudioBuffer;
  }),
}));
vi.mock('../../src/lib/separation', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/separation')>()),
  separateStems: vi.fn(),
  separationSupport: () => ({ ok: true, recommended: true, estSecondsPerMinute: 60, maxSeconds: 600 }),
}));
const order: string[] = [];
vi.mock('../../src/lib/pianoSpecialist', () => ({
  runPianoSpecialist: vi.fn(async (audio: Float32Array) => {
    order.push(`model:${audio.length}`);
    return { frame: new Float32Array(0), onset: new Float32Array(0), offset: new Float32Array(0), velocity: new Float32Array(0), nFrames: 0, fps: 100, ms: 1, threads: 3 };
  }),
}));
const specNotes: { value: Note[] } = { value: [] };
vi.mock('../../src/lib/pianoSpecialist/postprocess', () => ({ regressionToNotes: () => specNotes.value.map((n) => ({ ...n })) }));

/** The Basic Pitch worker: answers every transcribe request with a few notes and records what it heard. */
class FakeWorker {
  static heard: Float32Array[] = [];
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: unknown = null;
  postMessage(msg: { type: string; jobId: number; audio?: Float32Array }) {
    if (msg.type !== 'transcribe') return;
    FakeWorker.heard.push(msg.audio!.slice());
    const nFrames = Math.ceil(SECONDS * 86.13);
    const ev = (midi: number, s: number, e: number) => ({ midi, startFrame: s, endFrame: e, amplitude: 0.8, onset: 0.9 });
    queueMicrotask(() =>
      this.onmessage?.({
        data: {
          type: 'transcribed',
          jobId: msg.jobId,
          notes: [ev(69, 10, 60), ev(57, 70, 120), ev(64, 130, 200), ev(72, 210, 300)],
          nFrames,
          frames: new Uint8Array(nFrames * 88),
          onsets: new Uint8Array(nFrames * 88),
          rms: new Float32Array(nFrames).fill(0.3),
          backend: 'wasm',
          ms: 1,
        },
      }),
    );
  }
  terminate() {}
}

const P = await import('../../src/lib/transcription/pipeline');
const separation = await import('../../src/lib/separation');
const specialist = await import('../../src/lib/pianoSpecialist');
const piano = P.EXTRACTION_PRESETS.piano;
const blob = () => new Blob([new Uint8Array(100)], { type: 'audio/wav' });

function browserSep(extra: Partial<SeparationResult> = {}): SeparationResult {
  return {
    sampleRate: SR,
    vocals: vocals.slice(),
    accomp: Float32Array.from(other, (v, i) => v + bass[i]),
    bass: bass.slice(),
    vocalPresence: { activeFraction: 0.9, relDb: -3, present: true },
    engine: 'scnet-browser',
    ms: 1234,
    threads: 3,
    ...extra,
  };
}
/** normalised dot product of two signals */
const corr = (a: Float32Array, b: Float32Array) => {
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return ab / Math.sqrt(aa * bb + 1e-20);
};

beforeEach(() => {
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('location', new URL('http://localhost/import'));
  FakeWorker.heard = [];
  order.length = 0;
  vi.mocked(separation.separateStems).mockReset();
  vi.mocked(specialist.runPianoSpecialist).mockClear();
  specNotes.value = Array.from({ length: 8 }, (_, k) => ({ id: k + 1, midi: 60 + k, start: k * 0.4, dur: 0.3, vel: 0.7, hand: 'R' as const }));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('pianoPartStem', () => {
  it('browser: accomp - bass; a server with "other": that stem; an older server: its accompaniment', () => {
    const sep = browserSep();
    const b = separation.pianoPartStem(sep);
    expect(b.bassRemoved).toBe(true);
    expect(corr(b.audio, other)).toBeGreaterThan(0.9999);
    expect(Math.abs(corr(b.audio, bass))).toBeLessThan(1e-3);
    const serverOther = tone(440, 0.2);
    const s = separation.pianoPartStem({ accomp: sep.accomp, other: serverOther });
    expect(s).toEqual({ audio: serverOther, bassRemoved: true });
    const old = separation.pianoPartStem({ accomp: sep.accomp });
    expect(old.audio).toBe(sep.accomp);
    expect(old.bassRemoved).toBe(false);
  });
});

describe('Basic Pitch on the piano part', () => {
  it('one pass on the "other" stem: no vocal pass, no melody line, nothing added back', async () => {
    const r = await P.transcribeAudio(blob(), piano, () => {}, undefined, { separation: browserSep(), pianoPart: true });
    expect(FakeWorker.heard).toHaveLength(1);
    const heard = FakeWorker.heard[0];
    expect(corr(heard, other)).toBeGreaterThan(0.9999);
    expect(Math.abs(corr(heard, vocals))).toBeLessThan(1e-3);
    expect(Math.abs(corr(heard, bass))).toBeLessThan(1e-3);
    expect(r.notes.length).toBeGreaterThan(0);
    expect(r.notes.some((n) => n.role === 'melody')).toBe(false);
    expect(r.info.separated).toBe(true);
    expect(r.info.separation).toEqual({ engine: 'scnet-browser', vocals: false, pianoPart: true, singing: true, bassRemoved: true, ms: 1234, threads: 3 });
    expect(r.info.separation).not.toHaveProperty('vocalsInAccomp');
    expect(r.posteriors?.separated).toBe(true);
    expect(r.separationFailure).toBeUndefined();
  });

  it('the same separation without pianoPart keeps today’s flow (a vocal pass first)', async () => {
    await P.transcribeAudio(blob(), piano, () => {}, undefined, { separation: browserSep() });
    expect(FakeWorker.heard.length).toBe(2);
  });

  it('an older server without the "other" stem: its accompaniment, with a warning', async () => {
    const sep = browserSep({ bass: undefined, engine: 'scnet-server', threads: undefined });
    const r = await P.transcribeAudio(blob(), piano, () => {}, undefined, { separation: sep, pianoPart: true });
    expect(r.info.warnings).toContain(separation.PIANO_PART_OLD_SERVER);
    expect(r.info.separation).toMatchObject({ engine: 'scnet-server', pianoPart: true, bassRemoved: false });
  });

  it('no singing found: the same flow, recorded as such', async () => {
    const r = await P.transcribeAudio(blob(), piano, () => {}, undefined, { separation: browserSep({ vocalPresence: { activeFraction: 0, relDb: -40, present: false } }), pianoPart: true });
    expect(FakeWorker.heard).toHaveLength(1);
    expect(Math.abs(corr(FakeWorker.heard[0], vocals))).toBeLessThan(1e-3);
    expect(r.info.separation).toMatchObject({ pianoPart: true, singing: false });
  });

  it('nothing left after removing the singing and drums: a plain error', async () => {
    const sep = browserSep({ accomp: bass.slice() });
    await expect(P.transcribeAudio(blob(), piano, () => {}, undefined, { separation: sep, pianoPart: true })).rejects.toThrow(P.PIANO_PART_EMPTY);
    expect(FakeWorker.heard).toHaveLength(0);
  });

  it('a failed separation transcribes the whole recording with a notice; the progress says "Removing singing and drums"', async () => {
    const details: string[] = [];
    vi.mocked(separation.separateStems).mockImplementation(async (_b, onProgress) => {
      onProgress(0.5, 'Separating vocals & drums: part 3 of 12');
      throw new Error('std::bad_alloc');
    });
    const r = await P.transcribeAudio(blob(), piano, (e) => e.detail && details.push(e.detail), undefined, { separate: true, pianoPart: true });
    expect(details).toContain('Removing singing and drums: part 3 of 12');
    expect(r.separationFailure).toBe('memory');
    expect(r.info.warnings.join(' ')).toMatch(/^The singing could not be removed \(out of memory\), so the whole recording was turned into notes/);
    expect(r.info.separation).toBeUndefined();
    expect(FakeWorker.heard).toHaveLength(1);
    expect(corr(FakeWorker.heard[0], mix22)).toBeGreaterThan(0.9999);
  });

  it('an abort right after separation rejects with AbortError', async () => {
    const ac = new AbortController();
    vi.mocked(separation.separateStems).mockImplementation(async () => {
      ac.abort();
      return browserSep();
    });
    await expect(P.transcribeAudio(blob(), piano, () => {}, ac.signal, { separate: true, pianoPart: true })).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.heard).toHaveLength(0);
  });
});

describe('the piano model on the piano part', () => {
  it('separates first, then gives the model the stem at 16 kHz (never the normal model)', async () => {
    vi.mocked(separation.separateStems).mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('separated');
      return browserSep();
    });
    const phases: string[] = [];
    const r = await P.transcribeAudio(blob(), piano, () => {}, undefined, {
      separate: true,
      pianoPart: true,
      engine: 'piano-specialist',
      onPhase: (p) => phases.push(p),
    });
    expect(order).toEqual(['separated', `model:${16000 * SECONDS}`]);
    expect(phases).toEqual(['piano-model']);
    expect(FakeWorker.heard).toHaveLength(0);
    // the 22.05 kHz "other" stem, resampled: the 440 Hz tone, not the singer or the bass
    const input = vi.mocked(specialist.runPianoSpecialist).mock.calls[0][0];
    expect(corr(input, tone(440, 1, 16000 * SECONDS, 16000))).toBeGreaterThan(0.999);
    expect(Math.abs(corr(input, tone(660, 1, 16000 * SECONDS, 16000)))).toBeLessThan(0.01);
    expect(vi.mocked(specialist.runPianoSpecialist).mock.calls[0][3]).toMatchObject({ release: true, transfer: true });
    expect(r.info.method).toBe('piano-specialist');
    expect(r.info.separated).toBe(true);
    expect(r.info.separation).toEqual({ engine: 'scnet-browser', vocals: false, pianoPart: true, singing: true, bassRemoved: true, ms: 1234, threads: 3 });
    expect(r.info.warnings.join(' ')).not.toMatch(/not used with the high-accuracy/);
    expect(r.posteriors).toBeUndefined();
  });

  it('very few notes in the piano part: the few-notes notice', async () => {
    specNotes.value = [{ id: 1, midi: 60, start: 0.5, dur: 0.3, vel: 0.7, hand: 'R' }];
    const r = await P.transcribeAudio(blob(), piano, () => {}, undefined, { separation: browserSep(), pianoPart: true, engine: 'piano-specialist' });
    expect(r.info.warnings).toContain(P.PIANO_PART_FEW_NOTES);
    // without separation it is never shown
    const plain = await P.transcribeAudio(blob(), piano, () => {}, undefined, { engine: 'piano-specialist' });
    expect(plain.info.warnings).not.toContain(P.PIANO_PART_FEW_NOTES);
  });

  it('a failed separation: the whole recording, decoded at 16 kHz exactly as without the option', async () => {
    vi.mocked(separation.separateStems).mockRejectedValue(new Error('The separation worker failed.'));
    const phases: string[] = [];
    const r = await P.transcribeAudio(blob(), piano, () => {}, undefined, { separate: true, pianoPart: true, engine: 'piano-specialist', onPhase: (p) => phases.push(p) });
    expect(r.separationFailure).toBe('memory');
    expect(r.info.warnings[0]).toMatch(/^The singing could not be removed/);
    expect(phases).toEqual(['piano-model']);
    const input = vi.mocked(specialist.runPianoSpecialist).mock.calls[0][0];
    expect(input.length).toBe(mix16.length);
    expect(Array.from(input.subarray(0, 50))).toEqual(Array.from(mix16.subarray(0, 50)));
    expect(r.info.separation).toBeUndefined();
  });

  it('nothing left: the plain error, and the model never starts', async () => {
    await expect(
      P.transcribeAudio(blob(), piano, () => {}, undefined, { separation: browserSep({ accomp: bass.slice() }), pianoPart: true, engine: 'piano-specialist' }),
    ).rejects.toThrow(P.PIANO_PART_EMPTY);
    expect(specialist.runPianoSpecialist).not.toHaveBeenCalled();
  });

  it('an abort after separation rejects with AbortError before the model starts', async () => {
    const ac = new AbortController();
    vi.mocked(separation.separateStems).mockImplementation(async () => {
      ac.abort();
      return browserSep();
    });
    await expect(P.transcribeAudio(blob(), piano, () => {}, ac.signal, { separate: true, pianoPart: true, engine: 'piano-specialist' })).rejects.toMatchObject({ name: 'AbortError' });
    expect(specialist.runPianoSpecialist).not.toHaveBeenCalled();
  });

  it('without pianoPart the model ignores separation as before (warning kept)', async () => {
    const r = await P.transcribeAudio(blob(), piano, () => {}, undefined, { separation: browserSep(), engine: 'piano-specialist' });
    expect(r.info.warnings).toContain('"Separate vocals & drums" is not used with the high-accuracy piano model.');
    expect(r.info.separation).toBeUndefined();
    expect(vi.mocked(specialist.runPianoSpecialist).mock.calls[0][0].length).toBe(mix16.length);
  });
});

describe('wording', () => {
  it('progress and failure texts for the piano part', () => {
    expect(P.pianoPartDetail('Separating vocals & drums: part 3 of 12')).toBe('Removing singing and drums: part 3 of 12');
    expect(P.separationFailureWarning(new Error('boom'), true)).toEqual({
      kind: 'error',
      warning: 'The singing could not be removed (boom), so the whole recording was turned into notes: some notes may come from the singing.',
    });
    // Full song wording unchanged
    expect(P.separationFailureWarning(new Error('boom')).warning).toBe('Separating vocals and drums failed (boom); the full mix was transcribed instead.');
  });
});
