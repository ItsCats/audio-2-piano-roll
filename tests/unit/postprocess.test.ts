/**
 * The piano specialist's post-processing (port of piano_transcription_inference's
 * RegressionPostProcessor). Synthetic arrays here; with PTI_DUMP_DIR set, also a parity check
 * against the Python package on dumped model outputs (scratch data, never in the repo):
 *   PTI_DUMP_DIR=/path/to/dump npx vitest run tests/unit/postprocess.test.ts
 * where the directory holds <name>.{frame,onset,offset,velocity}.f32 (float32, nFrames x 88,
 * frame-major) and <name>.notes.json ({ nFrames, notes: [{ onset, offset, pitch, velocity }] },
 * the package's est_note_events).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { regressionToEvents, regressionToNotes, type RegressionOutputs } from '../../src/lib/pianoSpecialist/postprocess';

// pipeline test below: the decoder and the specialist's worker (T1's module) are stubbed
vi.mock('../../src/lib/transcription/decode', async (orig) => ({
  ...(await orig<typeof import('../../src/lib/transcription/decode')>()),
  decodeToRate: vi.fn(),
}));
vi.mock('../../src/lib/pianoSpecialist', () => ({
  runPianoSpecialist: vi.fn(),
  pianoSpecialistSupport: () => ({ available: true, recommended: true, downloadMB: 49, estSecondsPerMinute: 30 }),
}));

const P = 88;

function blank(nFrames: number): RegressionOutputs {
  const z = () => new Float32Array(nFrames * P);
  return { frame: z(), onset: z(), offset: z(), velocity: z(), nFrames, fps: 100 };
}

/** a regression bump (the model's target shape: 1 - |Δt| / J, J = 5 frames) centred at `centre` (fractional frame) */
function bump(m: Float32Array, k: number, centre: number, nFrames: number, J = 5) {
  for (let t = 0; t < nFrames; t++) {
    const v = Math.max(0, 1 - Math.abs(t - centre) / J);
    if (v > m[t * P + k]) m[t * P + k] = v;
  }
}

function note(o: RegressionOutputs, midi: number, on: number, off: number, vel: number, withOffset = true) {
  const k = midi - 21;
  bump(o.onset, k, on, o.nFrames);
  if (withOffset) bump(o.offset, k, off, o.nFrames);
  for (let t = Math.floor(on); t < Math.ceil(off); t++) o.frame[t * P + k] = 0.9;
  for (let t = 0; t < o.nFrames; t++) if (Math.abs(t - on) < 3) o.velocity[t * P + k] = vel;
}

describe('regressionToEvents (port of RegressionPostProcessor)', () => {
  it('finds a note with sub-frame onset/offset times and the package velocity', () => {
    const o = blank(300);
    note(o, 60, 50.3, 120.6, 0.5);
    const ev = regressionToEvents(o);
    expect(ev).toHaveLength(1);
    expect(ev[0].pitch).toBe(60);
    // the shift formula recovers the bump's true centre
    expect(ev[0].onset).toBeCloseTo(0.503, 4);
    expect(ev[0].offset).toBeCloseTo(1.206, 4);
    expect(ev[0].velocity).toBe(64); // int(0.5 * 128)
  });

  it('ends a note where the frame output fades when no offset peak comes', () => {
    const o = blank(300);
    note(o, 40, 20, 80, 0.7, false);
    const [e] = regressionToEvents(o);
    expect(e.pitch).toBe(40);
    // first frame at or below the frame threshold is frame 80
    expect(e.offset).toBeCloseTo(0.8, 5);
  });

  it('a re-strike (second onset while the frame is on) closes the first note one frame earlier', () => {
    const o = blank(400);
    note(o, 64, 30, 200, 0.6, false);
    bump(o.onset, 64 - 21, 100, o.nFrames);
    const ev = regressionToEvents(o).filter((e) => e.pitch === 64);
    expect(ev).toHaveLength(2);
    expect(ev[0].offset).toBeCloseTo(0.99, 5); // fin = 100 - 1, offset shift 0
    expect(ev[1].onset).toBeCloseTo(1.0, 5);
  });

  it('closes a note after 600 frames (6 s) without an offset', () => {
    const o = blank(900);
    const k = 50 - 21;
    bump(o.onset, k, 10, o.nFrames);
    for (let t = 10; t < 900; t++) o.frame[t * P + k] = 0.9;
    const [e] = regressionToEvents(o);
    expect(e.offset - e.onset).toBeCloseTo(6, 2);
  });

  it('ignores peaks below the threshold or without monotonic neighbours, and peaks at the edges', () => {
    const o = blank(100);
    const k = 30;
    o.onset[40 * P + k] = 0.25; // below 0.3
    o.onset[60 * P + k] = 0.9; // a lone spike: neighbours not monotonic over 2 frames
    o.onset[61 * P + k] = 0.1;
    o.onset[62 * P + k] = 0.5;
    o.onset[1 * P + k] = 0.9; // within `neighbour` frames of the start
    for (let t = 0; t < 100; t++) o.frame[t * P + k] = 0.9;
    expect(regressionToEvents(o)).toHaveLength(0);
  });

  it('orders events by pitch, then onset (as the package does); regressionToNotes sorts by time', () => {
    const o = blank(400);
    note(o, 72, 20, 60, 0.5);
    note(o, 48, 100, 150, 0.5);
    note(o, 72, 200, 260, 0.5);
    expect(regressionToEvents(o).map((e) => e.pitch)).toEqual([48, 72, 72]);
    const notes = regressionToNotes(o);
    expect(notes.map((n) => n.midi)).toEqual([72, 48, 72]);
    for (const n of notes) {
      expect(n.vel).toBeCloseTo(64 / 127, 6);
      expect(n.dur).toBeGreaterThan(0);
      expect(n.hand).toBe('R');
    }
  });
});

const DUMP = process.env.PTI_DUMP_DIR;

describe.skipIf(!DUMP || !existsSync(DUMP))('parity with the Python package on dumped model outputs', () => {
  const names = DUMP && existsSync(DUMP) ? readdirSync(DUMP).filter((f) => f.endsWith('.notes.json')).map((f) => f.slice(0, -'.notes.json'.length)) : [];
  const f32 = (name: string, k: string) => {
    const b = readFileSync(join(DUMP!, `${name}.${k}.f32`));
    return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  };
  it.each(names)('%s: same notes, times within 1 ms, same velocities', (name) => {
    const ref = JSON.parse(readFileSync(join(DUMP!, `${name}.notes.json`), 'utf8')) as {
      nFrames: number;
      notes: { onset: number; offset: number; pitch: number; velocity: number }[];
    };
    const o: RegressionOutputs = { frame: f32(name, 'frame'), onset: f32(name, 'onset'), offset: f32(name, 'offset'), velocity: f32(name, 'velocity'), nFrames: ref.nFrames, fps: 100 };
    const ev = regressionToEvents(o);
    expect(ev.length).toBe(ref.notes.length);
    let maxDt = 0;
    let exact = 0;
    ev.forEach((e, i) => {
      const r = ref.notes[i];
      expect(e.pitch).toBe(r.pitch);
      expect(e.velocity).toBe(r.velocity);
      maxDt = Math.max(maxDt, Math.abs(e.onset - r.onset), Math.abs(e.offset - r.offset));
      if (e.onset === r.onset && e.offset === r.offset) exact++;
    });
    expect(maxDt).toBeLessThan(0.001);
    console.log(`${name}: ${ev.length} notes, max |dt| ${(maxDt * 1000).toFixed(4)} ms, ${exact} bit-identical`);
  });
});

describe('transcribeAudio with the piano specialist', () => {
  it('decodes at 16 kHz, runs the model, post-processes and arranges (no separation, no posteriors)', async () => {
    const decode = await import('../../src/lib/transcription/decode');
    const spec = await import('../../src/lib/pianoSpecialist');
    const { transcribeAudio, EXTRACTION_PRESETS } = await import('../../src/lib/transcription/pipeline');
    const sr = 16000;
    const samples = new Float32Array(sr * 4);
    for (let i = 0; i < samples.length; i++) samples[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / sr);
    vi.mocked(decode.decodeToRate).mockResolvedValue({
      duration: 4,
      length: samples.length,
      sampleRate: sr,
      numberOfChannels: 1,
      getChannelData: () => samples,
    } as unknown as AudioBuffer);
    const out = blank(400);
    note(out, 69, 50.25, 150.5, 0.6);
    note(out, 45, 100, 300, 0.4);
    vi.mocked(spec.runPianoSpecialist).mockImplementation((async (audio: Float32Array, onProgress: (e: { stage: string; progress: number }) => void) => {
      expect(audio.length).toBe(samples.length);
      onProgress({ stage: 'loading-model', progress: 0.5, loaded: 12e6, total: 41e6 } as never);
      onProgress({ stage: 'analyzing', progress: 0, done: 0, segments: 2 } as never);
      onProgress({ stage: 'analyzing', progress: 1 });
      return { ...out, ms: 1000, threads: 4 };
    }) as unknown as typeof spec.runPianoSpecialist);
    const progress: { stage: string; detail?: string }[] = [];
    const res = await transcribeAudio(new Blob([new Uint8Array(8)]), EXTRACTION_PRESETS.piano, (e) => progress.push(e), undefined, { engine: 'piano-specialist', separate: true });
    expect(decode.decodeToRate).toHaveBeenCalledWith(expect.any(Blob), 16000);
    expect(res.notes.map((n) => n.midi)).toEqual([69, 45]);
    expect(res.notes[0].start).toBeCloseTo(0.5025, 4);
    expect(new Set(res.notes.map((n) => n.hand))).toEqual(new Set(['L', 'R']));
    expect(res.posteriors).toBeUndefined();
    expect(res.info).toMatchObject({ method: 'piano-specialist', estimated: true, backend: 'wasm (4 threads)' });
    expect(res.info.warnings.join(' ')).toMatch(/not used with the high-accuracy piano model/);
    expect(progress.map((p) => p.detail)).toEqual(
      expect.arrayContaining(['Downloading the piano model, once (12 of 41 MB)', 'Listening to the piano (part 1 of 2)', 'Listening to the piano']),
    );
    // the import is followed by the Studio: the worker and its ~550 MB are released right away, and
    // the samples are handed over instead of copied
    expect(vi.mocked(spec.runPianoSpecialist).mock.calls[0][3]).toMatchObject({ release: true, transfer: true });
  });

  /** a 16 kHz mono AudioBuffer stand-in of `seconds` */
  const fakeBuffer = (seconds: number) => {
    const sr = 16000;
    const samples = new Float32Array(Math.round(sr * Math.min(seconds, 4)));
    for (let i = 0; i < samples.length; i++) samples[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / sr);
    return { duration: seconds, length: samples.length, sampleRate: sr, numberOfChannels: 1, getChannelData: () => samples } as unknown as AudioBuffer;
  };

  it('model failures: out of memory gets plain advice, the worker\'s own download errors are kept, the code load is explained', async () => {
    const decode = await import('../../src/lib/transcription/decode');
    const spec = await import('../../src/lib/pianoSpecialist');
    const { transcribeAudio, EXTRACTION_PRESETS, specialistFailureMessage, SPECIALIST_CODE_FAILED } = await import('../../src/lib/transcription/pipeline');
    vi.mocked(decode.decodeToRate).mockResolvedValue(fakeBuffer(4));
    const run = (msg: string) => {
      vi.mocked(spec.runPianoSpecialist).mockRejectedValueOnce(new Error(msg));
      return transcribeAudio(new Blob([new Uint8Array(8)]), EXTRACTION_PRESETS.piano, () => {}, undefined, { engine: 'piano-specialist' });
    };
    for (const raw of [
      "Can't create a session. ERROR_CODE: 6, ERROR_MESSAGE: std::bad_alloc",
      'RangeError: WebAssembly.Memory.grow(): Maximum memory size exceeded',
      'The piano model worker failed.',
    ]) {
      await expect(run(raw)).rejects.toThrow(/ran out of memory on this device.*the normal model/);
    }
    const download = 'Could not download the piano model (41 MB). Check your internet connection and try again, or use the normal model.';
    await expect(run(download)).rejects.toThrow(download);
    expect(specialistFailureMessage(new Error('The piano model download was corrupted. Please try again.'))).toBe('The piano model download was corrupted. Please try again.');
    // a cancel stays a cancel
    vi.mocked(spec.runPianoSpecialist).mockRejectedValueOnce(new DOMException('Piano transcription cancelled', 'AbortError'));
    await expect(transcribeAudio(new Blob([new Uint8Array(8)]), EXTRACTION_PRESETS.piano, () => {}, undefined, { engine: 'piano-specialist' })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(SPECIALIST_CODE_FAILED).toMatch(/reload the page/);
  });

  it('memory-constrained devices: long recordings still run the high-accuracy model (no switch to the normal one)', async () => {
    const decode = await import('../../src/lib/transcription/decode');
    const spec = await import('../../src/lib/pianoSpecialist');
    const pipeline = await import('../../src/lib/transcription/pipeline');
    const { PTI_CONSTRAINED_MAX_SECONDS } = await import('../../src/lib/pianoSpecialist/protocol');
    vi.mocked(decode.decodeToRate).mockReset();
    vi.mocked(decode.decodeToRate).mockResolvedValue(fakeBuffer(PTI_CONSTRAINED_MAX_SECONDS + 120));
    vi.mocked(spec.runPianoSpecialist).mockReset();
    // the model call stops the test once the pipeline got there
    vi.mocked(spec.runPianoSpecialist).mockRejectedValue(new Error('specialist reached'));
    const bp = vi.spyOn(pipeline.transcriber, 'run').mockRejectedValue(new Error('basic pitch reached'));
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1', maxTouchPoints: 5 });
    vi.stubGlobal('location', { href: 'http://localhost/', origin: 'http://localhost' });
    try {
      await expect(pipeline.transcribeAudio(new Blob([new Uint8Array(8)]), pipeline.EXTRACTION_PRESETS.piano, () => {}, undefined, { engine: 'piano-specialist' })).rejects.toThrow(
        'specialist reached',
      );
      expect(spec.runPianoSpecialist).toHaveBeenCalledTimes(1);
      expect(bp).not.toHaveBeenCalled();
      expect(vi.mocked(decode.decodeToRate).mock.calls.map((c) => c[1])).toEqual([16000]);
    } finally {
      vi.unstubAllGlobals();
      bp.mockRestore();
      vi.mocked(spec.runPianoSpecialist).mockReset();
    }
  });

  it('progress text: real download bytes, then the parts done', async () => {
    const { specialistDetail } = await import('../../src/lib/transcription/pipeline');
    expect(specialistDetail({ stage: 'loading-model', loaded: 0, total: 41_044_512 })).toBe('Downloading the piano model, once (0 of 41 MB)');
    expect(specialistDetail({ stage: 'loading-model', loaded: 41_044_512, total: 41_044_512 })).toBe('Loading the piano model');
    expect(specialistDetail({ stage: 'loading-model' })).toBe('Loading the piano model');
    expect(specialistDetail({ stage: 'analyzing', done: 38, segments: 39 })).toBe('Listening to the piano (part 39 of 39)');
    expect(specialistDetail({ stage: 'analyzing', done: 39, segments: 39 })).toBe('Listening to the piano (part 39 of 39)');
  });
});
