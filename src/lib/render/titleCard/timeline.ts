/**
 * Where the title page and end card sit in an exported video.
 *
 *   0 ──── intro ────┬──── the piano roll (lead-in + music + tail, unchanged) ────┬── outro ──
 *   title page       │ every roll frame / audio sample is shifted by `intro`       │ end card
 *   (silent)         │                                                             │ (silent)
 *
 * `intro` and `outro` are rounded to whole frames; at 30/60 fps that is also a whole number of
 * 48 kHz samples, so audio and video stay exactly in sync after the title.
 */
import { CROSSFADE_SECONDS } from './types';

export interface CardTimeline {
  fps: number;
  intro: number;
  introFrames: number;
  outro: number;
  outroFrames: number;
}

export function cardTimeline(fps: number, titleSeconds: number, endSeconds: number): CardTimeline {
  const introFrames = titleSeconds > 0 ? Math.round(titleSeconds * fps) : 0;
  const outroFrames = endSeconds > 0 ? Math.round(endSeconds * fps) : 0;
  return { fps, intro: introFrames / fps, introFrames, outro: outroFrames / fps, outroFrames };
}

/** Length of the whole file for a roll of `rollFrames` frames. */
export function totalSeconds(tl: CardTimeline, rollFrames: number): number {
  return tl.intro + rollFrames / tl.fps + tl.outro;
}

/** Title page opacity over the first roll frame during the crossfade (1 = only the title page). */
export function titleOpacity(t: number, intro: number): number {
  const cf = Math.min(CROSSFADE_SECONDS, intro / 2);
  return Math.max(0, Math.min(1, (intro - t) / cf));
}

/** End card brightness: in from black over 0.6 s, out to black over the last 0.8 s. */
export function endOpacity(t: number, outro: number): number {
  return Math.max(0, Math.min(1, t / 0.6, (outro - t) / 0.8));
}

// ---------------------------------------------------------------------------------------
// Track wrappers: they put the cards around an unchanged piano-roll export
// ---------------------------------------------------------------------------------------

export interface AudioTrackLike<S> {
  add(sample: S): Promise<void>;
}
export interface AudioSampleLike {
  timestamp: number;
  duration: number;
  setTimestamp(t: number): void;
}

/**
 * Audio track wrapper: before the first sample it adds `intro` seconds of silence, and it moves
 * every sample by `intro`. `finish()` pads with silence until `end` seconds.
 */
export function shiftAudio<S extends AudioSampleLike>(track: AudioTrackLike<S>, intro: number, silence: (timestamp: number, seconds: number) => S) {
  let started = false;
  let end = 0;
  const addSilence = async (from: number, to: number) => {
    // pieces of at most 1 s keep memory small
    for (let t = from; t < to - 1e-9; t += 1) {
      const s = silence(t, Math.min(1, to - t));
      await track.add(s);
      (s as unknown as { close?: () => void }).close?.();
    }
  };
  return {
    async add(sample: S): Promise<void> {
      if (!started) {
        started = true;
        if (intro > 0) await addSilence(0, intro);
      }
      if (intro > 0) sample.setTimestamp(sample.timestamp + intro);
      end = Math.max(end, sample.timestamp + sample.duration);
      await track.add(sample);
    },
    /** silence after the music up to `until` seconds (the end of the end card) */
    async finish(until: number): Promise<void> {
      if (!started) {
        started = true;
        end = 0;
      }
      if (until > end + 1e-6) await addSilence(end, until);
    },
    get end() {
      return end;
    },
  };
}

export interface VideoTrackLike {
  add(timestamp: number, duration?: number, opts?: unknown): Promise<void>;
}

/**
 * Video track wrapper: before the first roll frame it calls `beforeFirst` (which renders and adds
 * the title page frames), and it moves every roll frame by `intro`.
 */
export function shiftVideo(track: VideoTrackLike, intro: number, beforeFirst: () => Promise<void>) {
  let started = false;
  let end = 0;
  return {
    async add(timestamp: number, duration?: number, opts?: unknown): Promise<void> {
      if (!started) {
        started = true;
        await beforeFirst();
      }
      end = Math.max(end, timestamp + intro + (duration ?? 0));
      await track.add(timestamp + intro, duration, opts);
    },
    get end() {
      return end;
    },
  };
}
