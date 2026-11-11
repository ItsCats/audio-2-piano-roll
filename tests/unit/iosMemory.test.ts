/**
 * iOS-specific review of the "page reloads mid-analysis" fix: every iOS browser (Safari, Chrome =
 * CriOS, Firefox = FxiOS, Edge = EdgiOS: all WebKit) is detected, and on phones the transcription
 * worker's memory (WebAssembly memory never shrinks) is given back after an import.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chooseBackendOrder, isMemoryConstrained } from '../../src/lib/transcription/backendChoice';
import { wantsLightPiano } from '../../src/lib/audio/sampleLibrary';

const IOS = {
  safari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  chrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1',
  firefox: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15',
  edge: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 EdgiOS/130.0.2849.80 Mobile/15E148 Safari/605.1.15',
  ipadChrome: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.6723.90 Mobile/15E148 Safari/604.1',
  // iPadOS Safari and Chrome request the desktop site by default: a Mac UA, but a touch screen
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
};

describe('every iOS browser is WebKit: WASM first, light piano', () => {
  it.each(Object.entries(IOS))('%s', (name, ua) => {
    const maxTouchPoints = 5;
    expect(isMemoryConstrained({ ua, maxTouchPoints })).toBe(true);
    // Safari reports no deviceMemory and the renderer reads "Apple GPU" (hardware)
    expect(chooseBackendOrder({ ua, maxTouchPoints, softwareRenderer: false, offscreen: true })[0]).toBe('wasm');
    expect(wantsLightPiano({ ua, maxTouchPoints, screenMin: name.startsWith('ipad') ? 820 : 390 })).toBe(true);
  });

  it('an iPad in desktop mode without the page-side touch facts would look like a Mac (the page must send them)', () => {
    expect(isMemoryConstrained({ ua: IOS.ipadDesktop })).toBe(false);
    expect(isMemoryConstrained({ ua: IOS.ipadDesktop, maxTouchPoints: 5 })).toBe(true);
  });
});

describe('the transcription worker is released after an import on phones', () => {
  class FakeWorker {
    static made: FakeWorker[] = [];
    terminated = false;
    onmessage: ((ev: { data: unknown }) => void) | null = null;
    onerror: unknown = null;
    constructor() {
      FakeWorker.made.push(this);
    }
    postMessage(msg: { type: string; jobId: number }) {
      // answer an extract job at once
      if (msg.type === 'extract') queueMicrotask(() => this.onmessage?.({ data: { type: 'extracted', jobId: msg.jobId, notes: [] } }));
    }
    terminate() {
      this.terminated = true;
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    FakeWorker.made = [];
  });

  const extract = async (transcriber: typeof import('../../src/lib/transcription/pipeline').transcriber) =>
    transcriber.run({ type: 'extract', frames: new Float32Array(88), onsets: new Float32Array(88), nFrames: 1, options: {} as never }, [], () => {}, undefined, 'extracted');

  it('releaseIfIdle stops an idle worker only, and the next job starts a fresh one', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const { transcriber } = await import('../../src/lib/transcription/pipeline');
    transcriber.releaseIfIdle();
    FakeWorker.made = [];
    expect(transcriber.releaseIfIdle()).toBe(false);
    // a job in flight keeps the worker
    const running = extract(transcriber);
    expect(transcriber.releaseIfIdle()).toBe(false);
    await running;
    expect(transcriber.releaseIfIdle()).toBe(true);
    expect(FakeWorker.made[0].terminated).toBe(true);
    await extract(transcriber);
    expect(FakeWorker.made).toHaveLength(2);
    transcriber.releaseIfIdle();
  });

  it('transcribeAudio lets the worker go on an iPhone (also when it fails), not on a desktop', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const { transcriber, transcribeAudio } = await import('../../src/lib/transcription/pipeline');
    const params = (await import('../../src/lib/transcription/pipeline')).EXTRACTION_PRESETS.piano;
    for (const [ua, mtp, released] of [
      [IOS.safari, 5, true],
      ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 0, false],
    ] as const) {
      transcriber.releaseIfIdle();
      FakeWorker.made = [];
      vi.stubGlobal('navigator', { userAgent: ua, maxTouchPoints: mtp, deviceMemory: ua === IOS.safari ? undefined : 16 });
      await extract(transcriber);
      // no audio decoder in Node: the import fails while decoding, after the worker was made
      await expect(transcribeAudio(new Blob([new Uint8Array(1000)]), params, () => {})).rejects.toThrow();
      expect(FakeWorker.made[0].terminated).toBe(released);
    }
    transcriber.releaseIfIdle();
  });
});
