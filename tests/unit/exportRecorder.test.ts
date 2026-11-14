/**
 * The export's real-time recorder (no WebCodecs): its file format on Apple devices, the duration
 * written into a recorded WebM, and the page's turns during long runs of frames.
 */
import { describe, expect, it } from 'vitest';
import { webmDurationPatch, withWebmDuration } from '../../src/lib/export/webmDuration';
import { isAppleWebKit, recorderMimeOrder, recorderVideoCodec } from '../../src/lib/export/recorderFormat';
import { pageBreather } from '../../src/lib/export/guard';

/** an EBML element: id bytes, a 1-byte size (or `size` bytes as given), the body */
const el = (id: number[], body: number[], size?: number[]) => [...id, ...(size ?? [0x80 | body.length]), ...body];
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];

/** the start of a file as Chrome's MediaRecorder writes it: header, a Segment of unknown size, Info, Tracks, a Cluster */
function recordedWebm({ withDuration = false, segmentSize = UNKNOWN, scale = [0x0f, 0x42, 0x40] } = {}) {
  const ebml = el([0x1a, 0x45, 0xdf, 0xa3], [...el([0x42, 0x82], [...'webm'].map((c) => c.charCodeAt(0)))]);
  const info = el([0x15, 0x49, 0xa9, 0x66], [
    ...el([0x2a, 0xd7, 0xb1], scale),
    ...el([0x4d, 0x80], [...'Chrome'].map((c) => c.charCodeAt(0))),
    ...el([0x57, 0x41], [...'Chrome'].map((c) => c.charCodeAt(0))),
    ...(withDuration ? el([0x44, 0x89], [0x40, 0x8f, 0x40, 0, 0, 0, 0, 0]) : []),
  ]);
  const tracks = el([0x16, 0x54, 0xae, 0x6b], el([0xae], el([0xd7], [1])));
  const cluster = [0x1f, 0x43, 0xb6, 0x75, ...UNKNOWN, ...el([0xe7], [0]), ...el([0xa3], [0x81, 0, 0, 0x80, 1, 2, 3, 4])];
  return new Uint8Array([...ebml, 0x18, 0x53, 0x80, 0x67, ...segmentSize, ...info, ...tracks, ...cluster]);
}

/** finds the Info element's Duration (in TimecodeScale units) and checks everything after Info is unchanged */
function readDuration(bytes: Uint8Array): number | null {
  for (let i = 0; i + 11 <= bytes.length; i++) {
    if (bytes[i] === 0x44 && bytes[i + 1] === 0x89 && bytes[i + 2] === 0x88) return new DataView(bytes.buffer, bytes.byteOffset + i + 3, 8).getFloat64(0);
  }
  return null;
}

describe('a recorded WebM gets its duration', () => {
  it('adds Duration to Info (in TimecodeScale units) and keeps everything else byte for byte', async () => {
    const src = recordedWebm();
    const out = new Uint8Array(await (await withWebmDuration(new Blob([src], { type: 'video/webm' }), 47.5)).arrayBuffer());
    expect(readDuration(out)).toBeCloseTo(47_500, 6); // ms at the default scale of 1 000 000 ns
    expect(out.length).toBe(src.length + 11 + 7); // the Duration element, and an 8-byte size for Info
    // what follows Info (Tracks, the Cluster: the video itself) is untouched
    const tracksAt = [...src].findIndex((b, i) => b === 0x16 && src[i + 1] === 0x54);
    expect([...out.slice(out.length - (src.length - tracksAt))]).toEqual([...src.slice(tracksAt)]);
    // Info's new size is right: its body ends where Tracks starts
    const infoAt = [...out].findIndex((b, i) => b === 0x15 && out[i + 1] === 0x49);
    const size = new DataView(out.buffer, infoAt + 4, 8).getBigUint64(0) & 0x00ffffffffffffffn;
    expect(infoAt + 4 + 8 + Number(size)).toBe(out.length - (src.length - tracksAt));
  });

  it('follows another TimecodeScale', () => {
    const p = webmDurationPatch(recordedWebm({ scale: [0x98, 0x96, 0x80] }), 2); // 10 ms units
    expect(readDuration(p!.insert)).toBeCloseTo(200, 6);
  });

  it('leaves a file alone that has a duration, a known-size Segment, or isn’t WebM', async () => {
    expect(webmDurationPatch(recordedWebm({ withDuration: true }), 3)).toBeNull();
    expect(webmDurationPatch(recordedWebm({ segmentSize: [0x01, 0, 0, 0, 0, 0, 0x10, 0] }), 3)).toBeNull();
    expect(webmDurationPatch(new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]), 3)).toBeNull();
    expect(webmDurationPatch(recordedWebm(), NaN)).toBeNull();
    const junk = new Blob([new Uint8Array([1, 2, 3])]);
    expect(await withWebmDuration(junk, 3)).toBe(junk);
  });
});

describe('the recorder’s format', () => {
  const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
  const iphoneChrome = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0 Mobile/15E148 Safari/604.1';
  const macSafari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
  const macChrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
  const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36';

  it('Apple devices record MP4 first (an iPhone can’t save a WebM to Photos); others keep WebM first', () => {
    expect(isAppleWebKit(iphone)).toBe(true);
    expect(isAppleWebKit(iphoneChrome)).toBe(true);
    expect(isAppleWebKit(macSafari)).toBe(true);
    expect(isAppleWebKit(macSafari, 5)).toBe(true); // an iPad in desktop mode
    expect(isAppleWebKit(macChrome)).toBe(false);
    expect(isAppleWebKit(android, 5)).toBe(false);
    expect(recorderMimeOrder(true)[0]).toMatch(/^video\/mp4/);
    expect(recorderMimeOrder(false)[0]).toMatch(/^video\/webm/);
    expect(new Set(recorderMimeOrder(true))).toEqual(new Set(recorderMimeOrder(false)));
  });

  it('names the recorded codec as the WebCodecs path does', () => {
    expect(recorderVideoCodec('video/webm;codecs=vp9,opus', false)).toBe('vp9');
    expect(recorderVideoCodec('video/webm;codecs=vp8,opus', false)).toBe('vp8');
    expect(recorderVideoCodec('video/mp4;codecs=avc1.42E01E,mp4a.40.2', true)).toBe('avc');
    expect(recorderVideoCodec('video/mp4', true)).toBe('avc');
  });
});

describe('pageBreather', () => {
  it('gives the page a turn during a long run of work, and not after every frame', async () => {
    let ran = false;
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ran = true;
      ch.port1.close();
    };
    ch.port2.postMessage(null); // stands for a tap waiting to be handled
    const breathe = pageBreather(20);
    let turnsBeforeTap = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < 120) {
      const s = performance.now();
      while (performance.now() - s < 2); // a frame's work
      await breathe(); // the encoder answering at once: no real break otherwise
      if (!ran) turnsBeforeTap++;
    }
    expect(ran).toBe(true);
    expect(turnsBeforeTap).toBeLessThan(15); // answered within ~20 ms of work, not at the end
  });
});
