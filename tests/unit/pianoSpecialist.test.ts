import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PTI_HOP_SAMPLES,
  PTI_PITCHES,
  PTI_SEGMENT_FRAMES,
  PTI_SEGMENT_SAMPLES,
  deframedLength,
  keptFrames,
  placeSegment,
  planSegments,
  segmentInput,
  downloadFailedMessage,
  specialistMemoryMB,
  PTI_CONSTRAINED_MAX_SECONDS,
  type RunRequest,
  type WorkerResponse,
} from '../../src/lib/pianoSpecialist/protocol';
import {
  IDLE_WORKER_MS,
  PIANO_SPECIALIST_MODEL_BYTES,
  PIANO_SPECIALIST_MODEL_PARTS,
  PIANO_SPECIALIST_MODEL_PATH,
  PIANO_SPECIALIST_MODEL_SHA256,
  estimateSecondsPerMinute,
  pianoSpecialistSupport,
  releasePianoSpecialist,
  runPianoSpecialist,
  specialistSegments,
} from '../../src/lib/pianoSpecialist';

/** piano_transcription_inference 0.0.6 PianoTranscription.enframe / deframe, transcribed literally */
function pyEnframeStarts(n: number): number[] {
  const padded = Math.ceil(n / PTI_SEGMENT_SAMPLES) * PTI_SEGMENT_SAMPLES;
  const out: number[] = [];
  let pointer = 0;
  while (pointer + PTI_SEGMENT_SAMPLES <= padded) {
    out.push(pointer);
    pointer += Math.floor(PTI_SEGMENT_SAMPLES / 2);
  }
  return out;
}
/** x: N segments of [1001] frames (one value per frame here); returns the deframed sequence */
function pyDeframe(x: number[][]): number[] {
  if (x.length === 1) return x[0];
  const y = x.map((s) => s.slice(0, -1));
  const segmentSamples = y[0].length;
  const out: number[] = [];
  out.push(...y[0].slice(0, Math.floor(segmentSamples * 0.75)));
  for (let i = 1; i < y.length - 1; i++) out.push(...y[i].slice(Math.floor(segmentSamples * 0.25), Math.floor(segmentSamples * 0.75)));
  out.push(...y[y.length - 1].slice(Math.floor(segmentSamples * 0.25)));
  return out;
}

describe('segment maths (as the Python package)', () => {
  it('pads to 10 s multiples and hops by 5 s', () => {
    expect(planSegments(1)).toEqual({ starts: [0], padded: PTI_SEGMENT_SAMPLES });
    expect(planSegments(PTI_SEGMENT_SAMPLES)).toEqual({ starts: [0], padded: PTI_SEGMENT_SAMPLES });
    expect(planSegments(PTI_SEGMENT_SAMPLES + 1).starts).toEqual([0, PTI_HOP_SAMPLES, 2 * PTI_HOP_SAMPLES]);
    for (const n of [1, 5000, 159999, 160000, 160001, 480000, 3_103_663, 16000 * 600]) {
      expect(planSegments(n).starts).toEqual(pyEnframeStarts(n));
    }
    expect(specialistSegments(30)).toBe(5);
    expect(specialistSegments(240)).toBe(47);
  });

  it('deframes like PianoTranscription.deframe', () => {
    for (const N of [1, 2, 3, 5, 12]) {
      // segment i, frame f carries the value i * 10000 + f
      const segs = Array.from({ length: N }, (_, i) => Array.from({ length: PTI_SEGMENT_FRAMES }, (_, f) => i * 10000 + f));
      const want = pyDeframe(segs);
      expect(deframedLength(N)).toBe(want.length);
      const out = new Float32Array(deframedLength(N) * PTI_PITCHES).fill(-1);
      segs.forEach((s, i) => {
        const seg = new Float32Array(PTI_SEGMENT_FRAMES * PTI_PITCHES);
        s.forEach((v, f) => seg.fill(v, f * PTI_PITCHES, (f + 1) * PTI_PITCHES));
        placeSegment(out, seg, i, N);
      });
      const got = Array.from({ length: want.length }, (_, t) => out[t * PTI_PITCHES]);
      expect(got).toEqual(want);
      // every pitch column is written (no gaps, no overlaps left at -1)
      expect(out.every((v) => v >= 0)).toBe(true);
    }
    // 30 s → 5 segments → 3000 frames, as the Python run gives
    expect(deframedLength(5)).toBe(3000);
    expect(keptFrames(0, 5)).toEqual({ from: 0, to: 750, dest: 0 });
    expect(keptFrames(4, 5)).toEqual({ from: 250, to: 1000, dest: 2250 });
  });

  it('cuts zero-padded segment inputs', () => {
    const a = Float32Array.from({ length: 200000 }, (_, i) => (i % 7) + 1);
    const buf = new Float32Array(PTI_SEGMENT_SAMPLES).fill(9);
    const s = segmentInput(a, 160000, buf);
    expect(s).toBe(buf);
    expect(s[0]).toBe(a[160000]);
    expect(s[39999]).toBe(a[199999]);
    expect(s[40000]).toBe(0);
    expect(s[PTI_SEGMENT_SAMPLES - 1]).toBe(0);
    expect(segmentInput(a, 240000).every((v) => v === 0)).toBe(true);
  });
});

describe('pianoSpecialistSupport', () => {
  const desktop = { ua: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/140', maxTouchPoints: 0, deviceMemory: 8, mobile: false };
  const iphone = { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1', maxTouchPoints: 5 };
  const low = { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140', maxTouchPoints: 0, deviceMemory: 4, mobile: false };

  it('recommends it on desktops, with honest size / memory / time', () => {
    const s = pianoSpecialistSupport(desktop, 3, { worker: true, simd: true });
    expect(s).toMatchObject({ available: true, recommended: true, threads: 3, memoryMB: 750 });
    expect(s.downloadMB).toBe(Math.round(PIANO_SPECIALIST_MODEL_BYTES / 1e6));
    expect(s.downloadMB).toBeLessThanOrEqual(50);
    expect(s.estSecondsPerMinute).toBe(estimateSecondsPerMinute(3));
    expect(s.reason).toBeUndefined();
    // single-threaded (not cross-origin isolated, e.g. Safari) is slower
    expect(pianoSpecialistSupport(desktop, 1, { worker: true, simd: true }).estSecondsPerMinute).toBeGreaterThan(s.estSecondsPerMinute);
  });

  it('offers but does not recommend it on phones and low-memory devices', () => {
    const p = pianoSpecialistSupport(iphone, 1, { worker: true, simd: true });
    expect(p).toMatchObject({ available: true, recommended: false });
    expect(p.reason).toMatch(/phones/);
    expect(p.reason).toMatch(/750 MB/);
    expect(p.estSecondsPerMinute).toBe(3 * estimateSecondsPerMinute(1));
    const l = pianoSpecialistSupport(low, 3, { worker: true, simd: true });
    expect(l).toMatchObject({ available: true, recommended: false });
    expect(l.reason).toMatch(/reports 4 GB/);
    // both say that long recordings use the fast model there
    for (const x of [p, l]) {
      expect(x.warnAboveSeconds).toBe(PTI_CONSTRAINED_MAX_SECONDS);
      expect(x.reason).toMatch(/over 6 minutes might not work on this device/);
      expect(x.reason).toMatch(/for a 4-minute piece \(more for longer ones\)/);
    }
    expect(pianoSpecialistSupport(desktop, 3, { worker: true, simd: true }).warnAboveSeconds).toBeUndefined();
  });

  it('the phone slow-down applies to phones and tablets, not to desktops that report 4 GB', () => {
    // a 4-core laptop reporting 4 GB runs at desktop speed (~2.4 min for 4 minutes with 3 threads)
    const l = pianoSpecialistSupport(low, 3, { worker: true, simd: true });
    expect(l.estSecondsPerMinute).toBe(estimateSecondsPerMinute(3));
    expect(l.reason).not.toMatch(/several minutes per song/);
    const android = { ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) Chrome/140 Mobile Safari/537.36', maxTouchPoints: 5, deviceMemory: 8, mobile: true };
    expect(pianoSpecialistSupport(android, 3, { worker: true, simd: true }).estSecondsPerMinute).toBe(3 * estimateSecondsPerMinute(3));
    const ipad = { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', maxTouchPoints: 5 };
    expect(pianoSpecialistSupport(ipad, 1, { worker: true, simd: true }).estSecondsPerMinute).toBe(3 * estimateSecondsPerMinute(1));
  });

  it('memory grows with the recording length (the card shows the 4-minute figure)', () => {
    expect(specialistMemoryMB(194)).toBe(750); // measured: +720 MB RSS / +740 MB PSS for a 3:14 piece
    expect(specialistMemoryMB(240)).toBe(750);
    expect(specialistMemoryMB(20 * 60)).toBe(1000);
    expect(specialistMemoryMB(10 * 60)).toBeGreaterThan(specialistMemoryMB(240));
    expect(pianoSpecialistSupport(desktop, 3, { worker: true, simd: true }).memoryMB).toBe(specialistMemoryMB(240));
  });

  it('download failures are explained in plain words', () => {
    expect(downloadFailedMessage(PIANO_SPECIALIST_MODEL_BYTES)).toBe(
      'Could not download the piano model (41 MB). Check your internet connection and try again, or use the normal model.',
    );
    expect(downloadFailedMessage(0)).toMatch(/^Could not download the piano model\. /);
  });

  it('is unavailable without workers or WASM SIMD', () => {
    expect(pianoSpecialistSupport(desktop, 1, { worker: false, simd: true })).toMatchObject({ available: false, recommended: false });
    const s = pianoSpecialistSupport(desktop, 1, { worker: true, simd: false });
    expect(s).toMatchObject({ available: false, recommended: false });
    expect(s.reason).toMatch(/SIMD/);
  });
});

// ---------------------------------------------------------------- runPianoSpecialist with a fake worker

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  posted: { msg: RunRequest; transfer: Transferable[] }[] = [];
  terminated = false;
  constructor(
    public url: URL,
    public opts: WorkerOptions,
  ) {
    FakeWorker.all.push(this);
  }
  postMessage(msg: RunRequest, transfer: Transferable[] = []) {
    this.posted.push({ msg, transfer });
  }
  terminate() {
    this.terminated = true;
  }
  emit(m: WorkerResponse) {
    this.onmessage?.({ data: m } as MessageEvent<WorkerResponse>);
  }
  /** answer the last request with a result of the right size */
  answer() {
    const { msg } = this.posted[this.posted.length - 1];
    const N = planSegments(msg.audio16k.length).starts.length;
    const nFrames = deframedLength(N);
    const z = () => new Float32Array(nFrames * PTI_PITCHES);
    this.emit({ type: 'progress', jobId: msg.jobId, stage: 'loading-model', progress: 0.5, loaded: 10, total: 20 });
    this.emit({ type: 'progress', jobId: msg.jobId + 1000, stage: 'analyzing', progress: 0.9 }); // someone else's job
    this.emit({ type: 'progress', jobId: msg.jobId, stage: 'analyzing', progress: 1, done: N, segments: N });
    this.emit({
      type: 'result',
      jobId: msg.jobId,
      nFrames,
      fps: 100,
      frame: z(),
      onset: z(),
      offset: z(),
      velocity: z(),
      ms: 5,
      threads: msg.threads ?? 1,
      stats: { fromCache: false, reusedSession: false, loadMs: 1, createMs: 1, inferMs: 3, segments: N },
    });
  }
}

describe('runPianoSpecialist', () => {
  beforeEach(() => {
    FakeWorker.all = [];
    vi.useFakeTimers();
    vi.stubGlobal('Worker', FakeWorker);
  });
  afterEach(() => {
    releasePianoSpecialist();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sends a copy of the audio with the model URL and sha, relays progress and resolves the maps', async () => {
    const audio = new Float32Array(16000 * 12).fill(0.25);
    const progress: unknown[] = [];
    const p = runPianoSpecialist(audio, (e) => progress.push(e), undefined, { threads: 3, release: false });
    const w = FakeWorker.all[0];
    expect(w.opts).toMatchObject({ type: 'module' });
    const { msg, transfer } = w.posted[0];
    expect(msg.type).toBe('run');
    expect(msg.audio16k).not.toBe(audio);
    expect(msg.audio16k.length).toBe(audio.length);
    expect(transfer).toEqual([msg.audio16k.buffer]);
    expect(audio[0]).toBe(0.25); // caller's array untouched
    expect(msg.threads).toBe(3);
    expect(msg.modelSha256).toBe(PIANO_SPECIALIST_MODEL_SHA256);
    expect(msg.modelUrl).toContain(PIANO_SPECIALIST_MODEL_PATH);
    expect(msg.modelUrl).toContain(`?v=${PIANO_SPECIALIST_MODEL_SHA256.slice(0, 8)}`);
    expect(msg.modelParts).toHaveLength(PIANO_SPECIALIST_MODEL_PARTS);
    expect(msg.modelParts![0]).toMatch(/models\/piano-specialist\/piano-note\.fp16\.part1\.bin\?v=/);
    expect(msg.modelBytes).toBe(PIANO_SPECIALIST_MODEL_BYTES);
    w.answer();
    const r = await p;
    expect(r.nFrames).toBe(deframedLength(3));
    expect(r.frame.length).toBe(r.nFrames * 88);
    expect(r.fps).toBe(100);
    expect(r.threads).toBe(3);
    expect(progress).toEqual([
      { stage: 'loading-model', progress: 0.5, loaded: 10, total: 20, done: undefined, segments: undefined },
      { stage: 'analyzing', progress: 1, loaded: undefined, total: undefined, done: 3, segments: 3 },
    ]);
    // kept warm for the next import, then terminated when idle
    expect(w.terminated).toBe(false);
    const p2 = runPianoSpecialist(audio, undefined, undefined, { threads: 3, release: false });
    expect(FakeWorker.all.length).toBe(1);
    w.answer();
    await p2;
    vi.advanceTimersByTime(IDLE_WORKER_MS + 1);
    expect(w.terminated).toBe(true);
  });

  it('with transfer, hands the caller\'s buffer over instead of copying it (views into bigger buffers are still copied)', async () => {
    const audio = new Float32Array(16000 * 3).fill(0.5);
    const buf = audio.buffer;
    const p = runPianoSpecialist(audio, undefined, undefined, { release: true, transfer: true });
    const w = FakeWorker.all[0];
    expect(w.posted[0].msg.audio16k).toBe(audio);
    expect(w.posted[0].transfer).toEqual([buf]);
    w.answer();
    await p;
    const big = new Float32Array(1000);
    const view = big.subarray(100, 900);
    const p2 = runPianoSpecialist(view, undefined, undefined, { release: true, transfer: true });
    const w2 = FakeWorker.all[1];
    expect(w2.posted[0].msg.audio16k).not.toBe(view);
    expect(w2.posted[0].msg.audio16k.length).toBe(800);
    expect(w2.posted[0].transfer[0]).not.toBe(big.buffer);
    w2.answer();
    await p2;
  });

  it('shipped model pieces add up to the model file', async () => {
    const fs = await import('node:fs');
    const crypto = await import('node:crypto');
    const { pianoSpecialistPartPaths } = await import('../../src/lib/pianoSpecialist');
    const h = crypto.createHash('sha256');
    let n = 0;
    for (const p of pianoSpecialistPartPaths()) {
      const b = fs.readFileSync(`public/${p}`);
      expect(b.length).toBeLessThan(10e6);
      h.update(b);
      n += b.length;
    }
    expect(n).toBe(PIANO_SPECIALIST_MODEL_BYTES);
    expect(h.digest('hex')).toBe(PIANO_SPECIALIST_MODEL_SHA256);
  });

  it('terminates the worker after the job when asked to release (memory-constrained devices)', async () => {
    const p = runPianoSpecialist(new Float32Array(1000), undefined, undefined, { release: true });
    const w = FakeWorker.all[0];
    expect(w.posted[0].msg.release).toBe(true);
    w.answer();
    await p;
    expect(w.terminated).toBe(true);
  });

  it('rejects with AbortError and terminates the worker on abort', async () => {
    const ac = new AbortController();
    const p = runPianoSpecialist(new Float32Array(1000), undefined, ac.signal);
    const w = FakeWorker.all[0];
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(w.terminated).toBe(true);
    // an already-aborted signal never starts a worker
    await expect(runPianoSpecialist(new Float32Array(10), undefined, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.all.length).toBe(1);
  });

  it('rejects worker errors and does not reuse that worker', async () => {
    const p = runPianoSpecialist(new Float32Array(1000), undefined, undefined, { release: false });
    const w = FakeWorker.all[0];
    w.emit({ type: 'error', jobId: w.posted[0].msg.jobId, message: 'Could not download the piano model (HTTP 404).' });
    await expect(p).rejects.toThrow(/HTTP 404/);
    expect(w.terminated).toBe(true);
  });
});
