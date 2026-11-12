/**
 * Timeline and mixing math for putting the song's original recording into an exported video.
 *
 * Sync rule: at video/output time `o` the picture shows song time `range.start + (o - lead) * rate`.
 * The original recording's time 0 is song time 0 (the same timebase the transcription used), so at
 * output time `o` we play the recording at that same song time. Song time before 0 or past the end of
 * the recording is silence. The original is only mixed at rate 1 (no time-stretching), which makes the
 * mapping a whole-sample offset: output frame k ↔ source frame k − leadFrames + startFrame.
 *
 * Everything here is pure so it can be unit-tested without a browser.
 */
import type { ExportSettings, ExportSound } from './types';

export const EXPORT_SAMPLE_RATE = 48000;
/** short ramp to silence at the very end of the file, so a cut-off recording doesn't end in a click */
export const END_RAMP_SECONDS = 0.3;
/** Longer songs are downmixed to mono on phones to halve the decoded size. */
export const MONO_ON_CONSTRAINED_AFTER_SECONDS = 4 * 60;

export interface ExportTimeline {
  sr: number;
  rate: number;
  /** seconds of lead-in before range.start */
  lead: number;
  /** seconds after range.end (ringing notes / fade-out) */
  tail: number;
  /** (range.end - range.start) / rate */
  musicDur: number;
  /** total output length in seconds */
  duration: number;
  fadeIn: number;
  fadeOut: number;
  /** audio frames of lead-in silence/original before the piano render starts */
  leadFrames: number;
  /** song frame at range.start */
  startFrame: number;
  /** audio frames after the lead-in (what the offline piano render produces) */
  bodyFrames: number;
}

export function exportTimeline(
  s: Pick<ExportSettings, 'leadIn' | 'fadeIn' | 'fadeOut'>,
  range: { start: number; end: number },
  rate: number,
  sr = EXPORT_SAMPLE_RATE,
): ExportTimeline {
  const lead = Math.max(0, s.leadIn);
  const tail = Math.max(1.5, s.fadeOut);
  const musicDur = (range.end - range.start) / rate;
  return {
    sr,
    rate,
    lead,
    tail,
    musicDur,
    duration: lead + musicDur + tail,
    fadeIn: Math.max(0, s.fadeIn),
    fadeOut: Math.max(0, s.fadeOut),
    leadFrames: Math.round(lead * sr),
    startFrame: Math.round(range.start * sr),
    bodyFrames: Math.ceil((musicDur + tail) * sr),
  };
}

/** What the sound track actually holds, given what this song and browser can do. */
export function effectiveSound(s: Pick<ExportSettings, 'sound'>, env: { hasOriginal: boolean; webCodecs: boolean }): ExportSound {
  if (!env.hasOriginal || !env.webCodecs) return 'piano';
  return s.sound === 'original' || s.sound === 'both' ? s.sound : 'piano';
}

/** Export speed: locked to 100 % whenever the original recording is included (no time-stretching). */
export function effectiveRate(s: Pick<ExportSettings, 'rate'>, sound: ExportSound): number {
  return sound === 'piano' ? s.rate : 1;
}

/** The Studio's "Original" volume if it is turned up, else a sensible default. */
export function defaultOriginalVolume(studioOriginalVolume: number | undefined): number {
  return typeof studioOriginalVolume === 'number' && studioOriginalVolume >= 0.05 ? studioOriginalVolume : 0.8;
}

export function originalGain(s: Pick<ExportSettings, 'originalVolume'>, studioOriginalVolume: number | undefined): number {
  return typeof s.originalVolume === 'number' ? s.originalVolume : defaultOriginalVolume(studioOriginalVolume);
}

/** Picture fade (and the original's fade) at output time `o`: 0 at the start and the end of the file. */
export function fadeGain(o: number, duration: number, fadeIn: number, fadeOut: number): number {
  return Math.max(0, Math.min(1, fadeIn > 0 ? o / fadeIn : 1, fadeOut > 0 ? (duration - o) / fadeOut : 1));
}

/** Gain envelope applied to the original at output time `o` (picture fade plus the end ramp). */
export function originalEnvelope(o: number, tl: ExportTimeline, endRamp = END_RAMP_SECONDS): number {
  const f = fadeGain(o, tl.duration, tl.fadeIn, tl.fadeOut);
  return endRamp > 0 ? Math.min(f, Math.max(0, (tl.duration - o) / endRamp)) : f;
}

/** Song frame (recording frame) heard at output frame `outFrame`. Only valid at rate 1. */
export function songFrameAt(outFrame: number, tl: Pick<ExportTimeline, 'leadFrames' | 'startFrame'>): number {
  return outFrame - tl.leadFrames + tl.startFrame;
}

/** Span of the recording (song seconds) that can be heard in this export. */
export function neededSpan(range: { start: number; end: number }, lead: number, tail: number, rate = 1): { start: number; end: number } {
  return { start: Math.max(0, range.start - lead * rate), end: range.end + tail * rate };
}

/** The decoded original, possibly trimmed: channels[c][j] is song frame offsetFrame + j. */
export interface OriginalSource {
  channels: Float32Array[];
  offsetFrame: number;
}

interface BufferLike {
  numberOfChannels: number;
  length: number;
  sampleRate: number;
  getChannelData(c: number): Float32Array;
}

/**
 * Copies only the needed span of a decoded recording (so the full AudioBuffer can be dropped),
 * downmixing to mono when asked or when the file has more than two channels.
 */
export function trimOriginal(buf: BufferLike, span: { start: number; end: number }, opts: { mono?: boolean } = {}): OriginalSource {
  const sr = buf.sampleRate;
  const from = Math.max(0, Math.min(buf.length, Math.floor(span.start * sr)));
  const to = Math.max(from, Math.min(buf.length, Math.ceil(span.end * sr) + 1));
  const n = to - from;
  const chs = buf.numberOfChannels;
  if (opts.mono || chs > 2) {
    const out = new Float32Array(n);
    for (let c = 0; c < chs; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] += d[from + i];
    }
    if (chs > 1) {
      const k = 1 / chs;
      for (let i = 0; i < n; i++) out[i] *= k;
    }
    return { channels: [out], offsetFrame: from };
  }
  const channels: Float32Array[] = [];
  for (let c = 0; c < chs; c++) channels.push(buf.getChannelData(c).slice(from, to));
  return { channels, offsetFrame: from };
}

/** Whether to downmix the decoded original to mono to save memory. */
export function shouldDownmix(durationSeconds: number, channels: number, memoryConstrained: boolean): boolean {
  return channels > 2 || (memoryConstrained && durationSeconds > MONO_ON_CONSTRAINED_AFTER_SECONDS);
}

/**
 * Adds the original recording into `dst` (planar channels) for output frames
 * [dstOutFrame0, dstOutFrame0 + n). A mono source feeds every channel.
 */
export function mixOriginal(dst: Float32Array[], dstOutFrame0: number, n: number, src: OriginalSource, tl: ExportTimeline, gain: number, endRamp = END_RAMP_SECONDS): void {
  if (tl.rate !== 1) throw new Error('The original recording can only be mixed at 100% speed.');
  const srcLen = src.channels[0]?.length ?? 0;
  if (!srcLen || gain === 0) return;
  // i range where the source index j = songFrameAt(dstOutFrame0 + i) - offsetFrame is inside [0, srcLen)
  const shift = songFrameAt(dstOutFrame0, tl) - src.offsetFrame; // j = i + shift
  const i0 = Math.max(0, -shift);
  const i1 = Math.min(n, srcLen - shift);
  if (i1 <= i0) return;
  const sr = tl.sr;
  const srcCh = src.channels.length;
  for (let i = i0; i < i1; i++) {
    const g = gain * originalEnvelope((dstOutFrame0 + i) / sr, tl, endRamp);
    if (g === 0) continue;
    const j = i + shift;
    for (let c = 0; c < dst.length; c++) dst[c][i] += src.channels[Math.min(c, srcCh - 1)][j] * g;
  }
}

/** Soft limiter: identity below the knee, smoothly approaching ±1 above it. Adds no delay. */
export function softClipInPlace(ch: Float32Array, knee = 0.85): void {
  const room = 1 - knee;
  for (let i = 0; i < ch.length; i++) {
    const x = ch[i];
    const a = x < 0 ? -x : x;
    if (a <= knee) continue;
    const y = knee + room * Math.tanh((a - knee) / room);
    ch[i] = x < 0 ? -y : y;
  }
}
