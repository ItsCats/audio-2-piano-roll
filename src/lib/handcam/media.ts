/**
 * Reading a hands video with mediabunny (already used for export, so no new library): probing it,
 * streaming its sound at 8 kHz for the sync, measuring where an imported video's sound sits against the
 * song, and decoding the part of its sound an export needs.
 */
import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny';
import { Resampler, SYNC_SR, gccPhatRefine } from './sync';
import { decodeRoute, decodeToRate } from '../transcription/decode';
import type { HandVideo } from './types';

export const HEVC_MESSAGE =
  'This browser can’t play this video’s format (often HEVC from an iPhone). On iPhone, set Settings > Camera > Formats > Most Compatible before filming, or use Safari or Chrome on a Mac.';
export const NO_VIDEO_MESSAGE = 'This file has no video in it.';
export const VIDEO_READ_MESSAGE = 'Couldn’t read this video. Try another file (MP4, MOV or WebM).';

/** Above this size the user is told the video takes room in the browser. */
export const BIG_VIDEO_BYTES = 500 * 1024 * 1024;
export const MAX_VIDEO_BYTES_DESKTOP = 4 * 1024 * 1024 * 1024;
export const MAX_VIDEO_BYTES_PHONE = 2 * 1024 * 1024 * 1024;

export interface VideoProbe {
  duration: number;
  displayW: number;
  displayH: number;
  rotation: number;
  codec?: string;
  fps?: number;
  canDecode: boolean;
  hasAudio: boolean;
  /** first audio timestamp (s, may be negative: encoder priming) */
  audioStart?: number;
}

const abort = () => new DOMException('Canceled', 'AbortError');

/** Size, rotation, length and whether this browser can show the video. Throws a friendly error for non-videos. */
export async function probeVideo(blob: Blob): Promise<VideoProbe> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    let track;
    try {
      track = await input.getPrimaryVideoTrack();
    } catch (e) {
      throw new Error(VIDEO_READ_MESSAGE, { cause: e });
    }
    if (!track) throw new Error(NO_VIDEO_MESSAGE);
    const audio = await input.getPrimaryAudioTrack().catch(() => null);
    const [duration, canDecode, stats, audioStart] = await Promise.all([
      track.computeDuration(),
      track.canDecode().catch(() => false),
      track.computePacketStats(120).catch(() => null),
      audio ? audio.getFirstTimestamp().catch(() => undefined) : Promise.resolve(undefined),
    ]);
    return {
      duration,
      displayW: track.displayWidth,
      displayH: track.displayHeight,
      rotation: track.rotation,
      codec: track.codec ?? undefined,
      fps: stats?.averagePacketRate ? Math.round(stats.averagePacketRate * 100) / 100 : undefined,
      canDecode,
      hasAudio: !!audio,
      audioStart,
    };
  } finally {
    input.dispose();
  }
}

export function handVideoFrom(blob: Blob & { name?: string }, p: VideoProbe, extra: Pick<HandVideo, 'store' | 'offset'> & Partial<HandVideo>): HandVideo {
  return {
    v: 1,
    fileName: blob.name ?? 'video',
    mimeType: blob.type,
    size: blob.size,
    duration: p.duration,
    displayW: p.displayW,
    displayH: p.displayH,
    rotation: p.rotation,
    fps: p.fps,
    codec: p.codec,
    addedAt: Date.now(),
    ...extra,
  };
}

/**
 * The video's sound, mono at 8 kHz, between `start` and `end` (video seconds; default the whole file),
 * streamed (the file is never loaded whole). `t0` is the video time of samples[0]. Gaps between packets
 * are filled with silence so sample k is always at t0 + k / 8000.
 */
export async function videoSound8k(blob: Blob, opts: { start?: number; end?: number; signal?: AbortSignal; onProgress?: (f: number) => void } = {}): Promise<{ samples: Float32Array; t0: number; sr: number }> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('This video has no sound, so it can’t be lined up automatically. Use the slider to line it up.');
    if (!(await track.canDecode())) throw new Error(`This browser can’t decode the video’s sound (${track.codec ?? 'unknown'}).`);
    const total = (opts.end ?? (await track.computeDuration())) - (opts.start ?? 0);
    const sink = new AudioBufferSink(track);
    let rs: Resampler | null = null;
    let t0 = 0;
    let inPos = 0; // input samples so far
    const parts: Float32Array[] = [];
    let n = 0;
    for await (const { buffer, timestamp } of sink.buffers(opts.start, opts.end)) {
      if (opts.signal?.aborted) throw abort();
      const sr = buffer.sampleRate;
      if (!rs) {
        rs = new Resampler(sr, SYNC_SR);
        t0 = timestamp;
      }
      // silence for a gap (or the start of a later packet)
      const expected = Math.round((timestamp - t0) * sr);
      if (expected > inPos + 1) {
        const gap = new Float32Array(expected - inPos);
        const o = rs.push(gap);
        parts.push(o);
        n += o.length;
        inPos = expected;
      }
      const mono = new Float32Array(buffer.length);
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const d = buffer.getChannelData(c);
        for (let i = 0; i < d.length; i++) mono[i] += d[i] / buffer.numberOfChannels;
      }
      const o = rs.push(mono);
      parts.push(o);
      n += o.length;
      inPos += buffer.length;
      if (total > 0) opts.onProgress?.(Math.min(1, (timestamp + buffer.duration - (opts.start ?? 0)) / total));
    }
    if (!rs) throw new Error('The video’s sound is empty.');
    const tail = rs.flush();
    parts.push(tail);
    n += tail.length;
    const samples = new Float32Array(n);
    let o = 0;
    for (const p of parts) {
      samples.set(p, o);
      o += p.length;
    }
    return { samples, t0, sr: SYNC_SR };
  } finally {
    input.dispose();
  }
}

/**
 * Where an imported video's sound is against the song: video time = song time + offset. Song time 0 is
 * sample 0 of the decode the transcription used (decodeToRate), which can differ from the video's own
 * timeline by encoder priming (AAC 20–50 ms, Opus a few ms). Streamed decodes start at the audio
 * track's first timestamp; native decodes are measured by GCC-PHAT on the first 20 s (when that fails:
 * NATIVE_FALLBACK_OFFSET).
 */
/**
 * The import offset when it can't be measured (a short or quiet start, a decode error) on the native
 * route: the browser's decoder drops the encoder priming (measured: 0.0 ms in Chrome), so sample 0 is
 * video time 0.
 */
export const NATIVE_FALLBACK_OFFSET = 0;

export async function measureImportOffset(blob: Blob, probe: Pick<VideoProbe, 'audioStart'>, signal?: AbortSignal): Promise<number> {
  const first = probe.audioStart ?? 0;
  // a streamed decode starts at the first audio sample in the file: exact by construction
  if (decodeRoute(blob) === 'stream') return first;
  try {
    const span = 25;
    const vid = await videoSound8k(blob, { end: span, signal });
    const nat = await decodeToRate(blob, SYNC_SR);
    const ref = new Float32Array(Math.min(nat.length, span * SYNC_SR));
    for (let c = 0; c < nat.numberOfChannels; c++) {
      const d = nat.getChannelData(c);
      for (let i = 0; i < ref.length; i++) ref[i] += d[i] / nat.numberOfChannels;
    }
    const len = Math.min(ref.length, vid.samples.length, 20 * SYNC_SR) - SYNC_SR;
    if (len < 2 * SYNC_SR) return NATIVE_FALLBACK_OFFSET;
    const d = gccPhatRefine(ref, vid.samples, SYNC_SR, 0, Math.round(0.25 * SYNC_SR), len - Math.round(0.25 * SYNC_SR), 0.25);
    return d === null ? NATIVE_FALLBACK_OFFSET : vid.t0 + d;
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    return NATIVE_FALLBACK_OFFSET;
  }
}

/**
 * The video's sound for the part of the song an export can hear, at `sr`, as song frames:
 * channels[c][j] is song frame offsetFrame + j (see lib/export/originalMix.ts).
 */
export async function videoSoundForSpan(
  blob: Blob,
  offset: number,
  span: { start: number; end: number },
  sr: number,
  opts: { mono?: boolean; signal?: AbortSignal; onProgress?: (f: number) => void } = {},
): Promise<{ channels: Float32Array[]; offsetFrame: number }> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('This video has no sound. Choose another sound for the export.');
    if (!(await track.canDecode())) throw new Error(`This browser can’t decode the video’s sound (${track.codec ?? 'unknown'}).`);
    const vStart = span.start + offset;
    const vEnd = span.end + offset;
    const sink = new AudioBufferSink(track);
    let srcRate = 0;
    let t0: number | null = null;
    let chans = 0;
    // decoded straight into one buffer at the file's rate (sized from the span once the rate is known),
    // then resampled once: at most two copies of the span in memory
    let raw: AudioBuffer | null = null;
    let used = 0;
    for await (const { buffer, timestamp } of sink.buffers(Math.max(0, vStart - 0.1), vEnd + 0.1)) {
      if (opts.signal?.aborted) throw abort();
      if (!raw) {
        srcRate = buffer.sampleRate;
        t0 = timestamp;
        chans = opts.mono || buffer.numberOfChannels === 1 ? 1 : Math.min(2, buffer.numberOfChannels);
        const cap = Math.ceil((vEnd + 0.1 - t0) * srcRate) + 2 * buffer.length + 16;
        raw = new AudioBuffer({ length: Math.max(1, cap), numberOfChannels: chans, sampleRate: srcRate });
      }
      const at = Math.round((timestamp - t0!) * srcRate);
      if (at >= raw.length) break;
      if (chans === 1) {
        const m = new Float32Array(Math.min(buffer.length, raw.length - at));
        for (let c = 0; c < buffer.numberOfChannels; c++) {
          const d = buffer.getChannelData(c);
          for (let i = 0; i < m.length; i++) m[i] += d[i] / buffer.numberOfChannels;
        }
        raw.copyToChannel(m, 0, at);
      } else for (let c = 0; c < chans; c++) raw.copyToChannel(buffer.getChannelData(c).subarray(0, raw.length - at) as Float32Array<ArrayBuffer>, c, at);
      used = Math.max(used, Math.min(raw.length, at + buffer.length));
      opts.onProgress?.(Math.min(1, (timestamp - vStart) / Math.max(0.001, vEnd - vStart)));
    }
    if (t0 === null || !raw || !used) return { channels: [new Float32Array(0)], offsetFrame: 0 };
    let channels = Array.from({ length: chans }, (_, c) => raw!.getChannelData(c).subarray(0, used));
    if (srcRate !== sr) {
      const outLen = Math.ceil((used * sr) / srcRate);
      const ctx = new OfflineAudioContext(chans, outLen, sr);
      const node = ctx.createBufferSource();
      node.buffer = raw;
      node.connect(ctx.destination);
      node.start(0, 0, used / srcRate);
      const out = await ctx.startRendering();
      raw = null;
      channels = Array.from({ length: chans }, (_, c) => out.getChannelData(c));
    }
    // channels[j] is at video time t0 + j / sr = song time t0 − offset + j / sr
    return { channels, offsetFrame: Math.round((t0 - offset) * sr) };
  } finally {
    input.dispose();
  }
}
