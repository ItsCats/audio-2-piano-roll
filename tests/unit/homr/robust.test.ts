// The homr reader's safeguards and integration contract (not in Python homr): float16 weights
// expanded before session creation, image size limits, sideways pages, low-memory mode, the SMT
// reader's calling conventions.
import { describe, expect, it } from 'vitest';
import * as ort from 'onnxruntime-web';
import { expandFp16Weights } from '../../../src/lib/omr/homr/fp16w';
import { assemble, homrEngine, homrReaderSupport, MAX_PAGES_PHONE, pagePixels, workerError } from '../../../src/lib/omr/homr';
import { fitSize, MAX_INPUT_SIDE, rotate90, shrinkPixels } from '../../../src/lib/omr/homr/page';
import { NoMusicError, readPage, type HomrInfer } from '../../../src/lib/omr/homr/pipeline';
import { stagedInfer, type SessionName } from '../../../src/lib/omr/homr/ort';
import { img } from '../../../src/lib/omr/homr/cv';
import { READER_STOPPED_MESSAGE, type RunStats } from '../../../src/lib/omr/homr/protocol';

/** y = x W + b with W (32 x 32) stored as float16 + Cast by tests/homr/convert_models.py fp16_storage (generated, random weights) */
const TINY_FP16W = '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';
/** numpy's y for x = [0, 1, ..., 31] / 32, W rounded to float16 */
const TINY_Y = [-0.129311,-2.498696,2.685123,-3.270021,2.530776,-1.584917,0.702122,-2.945516,1.007498,2.736857,4.390932,-0.352426,-2.152357,2.163164,-0.598810,-0.010495,0.053345,-2.546451,0.444842,-2.050232,-2.217172,-2.727649,0.481073,0.653231,1.217704,-2.645593,-0.091313,1.200945,3.250678,-3.092657,-1.386238,-4.447806];
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));

const stats: RunStats = { fromCache: true, reusedSession: false, loadMs: 0, createMs: 0, segmentMs: 0, encodeMs: 0, decodeMs: 0, steps: 0, threads: 1 };
const xml = '<score-partwise><part id="P1"><measure number="1"><note><pitch><step>C</step><octave>4</octave></pitch></note></measure></part></score-partwise>';
const phone = { ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', maxTouchPoints: 5, mobile: true };

describe('homr reader: float16-stored weights', () => {
  it('turns X__fp16 + Cast back into a float32 initializer with the same results', async () => {
    const model = fromB64(TINY_FP16W);
    const out = expandFp16Weights(model);
    expect(out).not.toBe(model);
    expect(out.length).toBeGreaterThan(model.length + 2 * 1024 - 64);
    const text = new TextDecoder('latin1').decode(out);
    expect(text).not.toContain('__fp16');
    expect(text).not.toContain('Cast');
    ort.env.wasm.numThreads = 1;
    const x = new ort.Tensor('float32', Float32Array.from({ length: 32 }, (_, i) => i / 32), [1, 32]);
    const ys: Float32Array[] = [];
    for (const m of [model, out]) {
      const s = await ort.InferenceSession.create(m);
      ys.push((await s.run({ x })).y.data as Float32Array);
      await s.release();
    }
    expect(Array.from(ys[1])).toEqual(Array.from(ys[0]));
    ys[1].forEach((v, i) => expect(v).toBeCloseTo(TINY_Y[i], 4));
  });

  it('leaves other models (and anything unexpected) unchanged', () => {
    const junk = new Uint8Array([8, 7, 18, 3, 1, 2, 3]);
    expect(expandFp16Weights(junk)).toBe(junk);
    const truncated = fromB64(TINY_FP16W).slice(0, 100);
    expect(expandFp16Weights(truncated)).toBe(truncated);
  });
});

describe('homr reader: input limits', () => {
  it('scales big images down by area averaging, keeping the aspect', () => {
    expect(fitSize(8000, 6000)).toMatchObject({ w: MAX_INPUT_SIDE, h: 3000 });
    // a 4 x 2 gray image, left half 200, right half 0
    const s = shrinkPixels(Uint8Array.from([200, 200, 0, 0, 200, 200, 0, 0]), 4, 2, 1, 2);
    expect([s.w, s.h]).toEqual([2, 1]);
    expect(Array.from(s.data)).toEqual([200, 0]);
    const same = Uint8Array.from([1, 2, 3]);
    expect(shrinkPixels(same, 3, 1, 1).data).toBe(same);
    // the page side copies gray pages (the caller keeps them) and scales them down
    const big = { w: 5000, h: 100, d: new Uint8Array(5000 * 100).fill(9) };
    const px = pagePixels(big);
    expect([px.w, px.h, px.channels, px.scale]).toEqual([MAX_INPUT_SIDE, 80, 1, MAX_INPUT_SIDE / 5000]);
    expect(px.data[0]).toBe(9);
  });

  it('turns images by 90 degrees both ways', () => {
    const a = img(3, 2, 1);
    a.d.set([1, 2, 3, 4, 5, 6]);
    expect(Array.from(rotate90(a, 90).d)).toEqual([4, 1, 5, 2, 6, 3]);
    expect(Array.from(rotate90(a, 270).d)).toEqual([3, 6, 2, 5, 1, 4]);
    expect(Array.from(rotate90(rotate90(a, 90), 270).d)).toEqual(Array.from(a.d));
  });

  it('does not read a strip much taller than a page (no segmentation run)', async () => {
    let calls = 0;
    const infer: HomrInfer = {
      segment: async () => (calls++, new Float32Array(0)),
      transcribe: async () => [],
    };
    const strip = img(351, 3000, 1, 255);
    await expect(readPage(strip, infer)).rejects.toMatchObject({ kind: 'too-tall' });
    await expect(readPage(strip, infer)).rejects.toBeInstanceOf(NoMusicError);
    expect(calls).toBe(0);
  });
});

describe('homr reader: low-memory mode', () => {
  it('keeps only the networks of the current step', async () => {
    const live = new Set<SessionName>();
    const log: string[] = [];
    const fake = (name: SessionName) =>
      ({
        inputNames: ['x'],
        outputNames: ['y'],
        run: async () => ({ y: { data: new Float32Array(6 * 320 * 320), dispose() {} } }),
        release: async () => (live.delete(name), log.push('-' + name)),
      }) as unknown as ort.InferenceSession;
    const s = stagedInfer(ort, async (name) => (live.add(name), log.push('+' + name), fake(name)));
    await s.segment(new Float32Array(3 * 320 * 320), 1);
    await s.segment(new Float32Array(3 * 320 * 320), 1);
    expect([...live]).toEqual(['segnet']);
    // the encoder / decoder fakes fail on run: only the sessions' lifecycle is checked here
    await s.transcribe(new Float32Array(256 * 1280), 1, 2).catch(() => undefined);
    expect([...live].sort()).toEqual(['decoder', 'encoder']);
    await s.segment(new Float32Array(3 * 320 * 320), 1);
    expect([...live]).toEqual(['segnet']);
    await s.release();
    expect(live.size).toBe(0);
    expect(log.slice(0, 4)).toEqual(['+segnet', '-segnet', '+encoder', '+decoder']);
  });
});

describe('homr reader: the Sheet Music Transformer reader\'s conventions', () => {
  it('support() takes the SMT arguments (kind first) and sizes phones for one thread', () => {
    const viaKind = homrEngine.support('pdf', phone);
    expect(viaKind).toMatchObject({ phone: true, recommended: false, threads: 1, maxPages: MAX_PAGES_PHONE });
    // a kind string where a device is expected is ignored, not taken for a desktop
    expect(homrReaderSupport('photo' as never, undefined, { worker: true, simd: true }).available).toBe(true);
    const desktop = homrReaderSupport({ ua: 'Mozilla/5.0 (X11; Linux x86_64)' }, 3, { worker: true, simd: true });
    expect(desktop.memoryMB).toBeGreaterThan(viaKind.memoryMB);
  });

  it('shows technical worker errors as one plain sentence', () => {
    expect(workerError('Could not download the sheet-music reader (93 MB).', true).message).toMatch(/download/);
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(workerError('RuntimeError: Aborted(OOM)', false).message).toBe(READER_STOPPED_MESSAGE);
    } finally {
      console.warn = warn;
    }
  });

  it('explains skipped, sideways and too-tall pages, and a reader that could not be stored', () => {
    const r = assemble(
      {
        musicXml: xml,
        pages: [
          { staves: 2, systems: 1, ms: 1, rotated: 90 },
          { staves: 0, systems: 0, error: 'x', errorKind: 'too-tall', ms: 1 },
          { staves: 0, systems: 0, error: 'No staffs found', errorKind: 'no-music', ms: 1 },
        ],
        stats: { ...stats, notStored: true },
      },
      3,
    );
    expect(r.warnings).toEqual([
      'No music was found on page 3.',
      'Page 2 was skipped: much taller than a page of music. Crop it into pages to read it.',
      'Page 1 was sideways and was read turned upright.',
      'The sheet-music reader could not be saved in this browser (private browsing or not enough storage), so it will be downloaded again next time.',
    ]);
    expect(() => assemble({ musicXml: '', pages: [{ staves: 0, systems: 0, error: 'x', errorKind: 'too-tall', ms: 1 }], stats }, 1)).toThrow(/taller than a page/);
    expect(() => assemble({ musicXml: '', pages: [{ staves: 0, systems: 0, error: 'x', ms: 1 }], stats }, 1)).toThrow(/upright/);
  });
});
