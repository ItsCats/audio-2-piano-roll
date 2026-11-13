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
import { timelineFadeGain } from '../audio/fade';

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

/**
 * What the sound track actually holds, given what this song and browser can do. `hasHandsSound`: the
 * song has a hands video added after its import (its sound can be used).
 */
export function effectiveSound(s: Pick<ExportSettings, 'sound'>, env: { hasOriginal: boolean; webCodecs: boolean; hasHandsSound?: boolean }): ExportSound {
  if (!env.webCodecs) return 'piano';
  if (s.sound === 'hands' || s.sound === 'hands+piano') return env.hasHandsSound ? s.sound : 'piano';
  if (!env.hasOriginal) return 'piano';
  return s.sound === 'original' || s.sound === 'both' ? s.sound : 'piano';
}

/** The sound track has no piano in it. */
export const soundWithoutPiano = (sound: ExportSound): boolean => sound === 'original' || sound === 'hands';
/** The song's original recording is in the sound track. */
export const usesOriginalRecording = (sound: ExportSound): boolean => sound === 'original' || sound === 'both';
/** A hands video's own sound is in the sound track. */
export const usesHandsSound = (sound: ExportSound): boolean => sound === 'hands' || sound === 'hands+piano';

/**
 * Export speed: locked to 100 % whenever a recording is included (no time-stretching) or a hands video
 * is shown (it plays at its real speed).
 */
export function effectiveRate(s: Pick<ExportSettings, 'rate'>, sound: ExportSound, handsVideo = false): number {
  return sound === 'piano' && !handsVideo ? s.rate : 1;
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
  return timelineFadeGain(o, duration, fadeIn, fadeOut);
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

/** A span up to this long is copied out of the decoded recording (so the rest can be freed). */
export const COPY_SPAN_UP_TO_SECONDS = 60;

/**
 * The part of a decoded recording this export can hear.
 *
 * Memory: the decoded song is already in memory when this runs, so copying a long span would double
 * the peak. A short span (up to COPY_SPAN_UP_TO_SECONDS, about the size of one piano render chunk) is
 * copied so the full decode can be freed; a longer one is kept as views into the decoded channels, so
 * nothing is copied. Mono (when asked, or for files with more than two channels) is mixed in place into
 * channel 0, so dropping the AudioBuffer frees the other channels.
 */
export function trimOriginal(
  buf: BufferLike,
  span: { start: number; end: number },
  opts: { mono?: boolean; copyUpToSeconds?: number } = {},
): OriginalSource {
  const sr = buf.sampleRate;
  const from = Math.max(0, Math.min(buf.length, Math.floor(span.start * sr)));
  const to = Math.max(from, Math.min(buf.length, Math.ceil(span.end * sr) + 1));
  const n = to - from;
  const chs = buf.numberOfChannels;
  const copy = n <= (opts.copyUpToSeconds ?? COPY_SPAN_UP_TO_SECONDS) * sr;
  if ((opts.mono || chs > 2) && chs > 1) {
    const k = 1 / chs;
    if (copy) {
      const out = new Float32Array(n);
      for (let c = 0; c < chs; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < n; i++) out[i] += d[from + i];
      }
      for (let i = 0; i < n; i++) out[i] *= k;
      return { channels: [out], offsetFrame: from };
    }
    const out = buf.getChannelData(0);
    for (let c = 1; c < chs; c++) {
      const d = buf.getChannelData(c);
      for (let i = from; i < to; i++) out[i] += d[i];
    }
    for (let i = from; i < to; i++) out[i] *= k;
    return { channels: [out.subarray(from, to)], offsetFrame: from };
  }
  const channels: Float32Array[] = [];
  for (let c = 0; c < chs; c++) {
    const d = buf.getChannelData(c);
    channels.push(copy ? d.slice(from, to) : d.subarray(from, to));
  }
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

/** Peak level the mix is limited to when the original is included (about -1 dB, room for the encoder). */
export const LIMIT_CEILING = 0.89;
/** how far ahead the limiter looks, so it turns down before a peak instead of on it */
export const LIMIT_LOOKAHEAD_SECONDS = 0.005;
export const LIMIT_RELEASE_SECONDS = 0.15;

/**
 * Peak limiter for the mixed sound track. Offline and look-ahead without delaying the audio: the gain
 * needed to keep every sample at or below the ceiling is known in advance for each block, so the gain
 * ramps down over the look-ahead window before a peak and recovers smoothly afterwards. Both channels
 * get the same gain (the stereo image doesn't move). The gain carries over from block to block.
 * Below the ceiling with no recent peak, the audio is untouched.
 */
export function createLimiter(sr: number, ceiling = LIMIT_CEILING, lookaheadSeconds = LIMIT_LOOKAHEAD_SECONDS, releaseSeconds = LIMIT_RELEASE_SECONDS) {
  const look = Math.max(1, Math.round(lookaheadSeconds * sr));
  const attackStep = 1 / look;
  const rc = 1 - Math.exp(-1 / Math.max(1, releaseSeconds * sr));
  let gain = 1;
  return {
    process(chans: Float32Array[]): void {
      const n = chans[0]?.length ?? 0;
      if (!n) return;
      // gain needed at each sample, then a backward pass so the gain falls ahead of each peak
      const target = new Float32Array(n);
      let next = 1;
      for (let i = n - 1; i >= 0; i--) {
        let a = 0;
        for (const ch of chans) {
          const v = ch[i] < 0 ? -ch[i] : ch[i];
          if (v > a) a = v;
        }
        const need = a > ceiling ? ceiling / a : 1;
        next = Math.min(need, next + attackStep);
        target[i] = next;
      }
      // forward pass: fall as needed, rise slowly
      let g = gain;
      for (let i = 0; i < n; i++) {
        const t = target[i];
        g = t < g ? t : g + (t - g) * rc;
        if (g < 1) for (const ch of chans) ch[i] *= g;
      }
      gain = g > 0.999999 ? 1 : g;
    },
  };
}

/** Below this the WASM AAC encoder can stall on some content, so such values are set to 0 (about -120 dB, inaudible). */
export const TINY_SAMPLE = 1e-6;

export function flushTinyInPlace(ch: Float32Array, threshold = TINY_SAMPLE): void {
  for (let i = 0; i < ch.length; i++) {
    const x = ch[i];
    if (x !== 0 && x < threshold && x > -threshold) ch[i] = 0;
  }
}
