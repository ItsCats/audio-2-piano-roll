/**
 * Title page / end card in the video export (src/lib/export/videoExport.ts).
 *
 * The piano-roll export stays exactly as it is; the cards are put around it by wrapping its
 * audio and video tracks (timeline.ts): the title page frames are rendered just before the first
 * roll frame is added, every roll frame and audio sample is moved by the title's length, silence
 * covers the title page and the end card, and the end card frames are added after the last roll
 * frame. The title page crossfades into the first roll frame; the end card fades in from black.
 */
import { AudioSample } from 'mediabunny';
import { makeCanvas, type AnyCanvas, type Ctx2D } from '../color';
import type { VisualSettings } from '../settings';
import { getMedia } from '../../storage/db';
import { loadTitleImages, type TitleImages } from './assets';
import type { CardImages } from './background';
import { TitleCardCache, drawTitleCard } from './draw';
import { resolveLook, type ResolvedLook, type StudioLookHint } from './presets';
import { endCardText } from './settings';
import { cardTimeline, endOpacity, shiftAudio, shiftVideo, titleOpacity, totalSeconds, type CardTimeline, type VideoTrackLike } from './timeline';
import type { TitleCardSettings, TitleText } from './types';

export interface TitleCardJob {
  settings: TitleCardSettings;
  /** title page text (already defaulted from the song) */
  text: TitleText;
  /** Studio colours a style may follow */
  hint?: StudioLookHint;
  /** told when something did not work out but the export went on (e.g. a font failed to load) */
  onWarning?: (message: string) => void;
}

export const FONT_WARNING = 'The title font didn’t load, so a standard font was used.';

/** End card main line size compared with a title */
export const END_LAYOUT = { sizeMul: { title: 0.6 } };

const hasText = (t: TitleText) => Object.values(t).some((v) => v && v.trim());

/** Whether the job adds a title page and/or an end card. */
export function titleCardsActive(tc: TitleCardJob | undefined): { title: boolean; end: boolean } {
  if (!tc) return { title: false, end: false };
  return { title: tc.settings.enabled && hasText(tc.text), end: tc.settings.end.enabled && hasText(endCardText(tc.settings.end, tc.text)) };
}

/** Seconds the cards add to a video (for the length shown in the dialog). */
export function titleCardsSeconds(tc: TitleCardJob | undefined, fps: number): number {
  const on = titleCardsActive(tc);
  const tl = cardTimeline(fps, on.title ? tc!.settings.duration : 0, on.end ? tc!.settings.end.duration : 0);
  return tl.intro + tl.outro;
}

export interface Renderable {
  /** paints the Studio background (no notes, no keyboard) */
  drawBackdrop(ctx: Ctx2D): void;
}

export interface PrepareOptions {
  width: number;
  height: number;
  fps: number;
  visual: VisualSettings;
  /** the export canvas (the roll renderer draws into it) */
  canvas: AnyCanvas;
  renderer: Renderable;
  /** number of piano-roll frames */
  rollFrames: number;
  /** sample rate of the export's audio track (the silence is made at the same rate) */
  sampleRate?: number;
  signal?: AbortSignal;
  /** told after each title page / end card frame */
  onFrame?: (done: number, total: number, part: 'title' | 'end') => void;
}

export interface TitleCardHooks {
  timeline: CardTimeline;
  /** whole file length */
  total: number;
  /** milliseconds spent drawing the title page frames (not part of the roll's render speed) */
  readonly introMs: number;
  /** wraps the audio track: silence first, samples moved by the title length, silence at the end */
  audio<T extends { add(s: AudioSample): Promise<void>; close(): void }>(track: T): { add(s: AudioSample): Promise<void>; close(): void };
  /** wraps the video track: title page frames before the first roll frame, roll frames moved */
  video<T extends VideoTrackLike & { close(): void }>(track: T): { add(timestamp: number, duration?: number, opts?: VideoEncoderEncodeOptions): Promise<void>; close(): void };
  /** adds the end card frames; call after the last roll frame, before closing the video track */
  finish(): Promise<void>;
  /** for real-time capture: keep the canvas (the first roll frame) as the crossfade target */
  captureRollFirst(): void;
  /** for real-time capture: draws the title page / end card at time t */
  drawIntro(ctx: Ctx2D, t: number): void;
  drawOutro(ctx: Ctx2D, t: number): void;
  dispose(): void;
}

function aborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
}

export const CARDS_FAILED = 'The title page couldn’t be added to this video.';

/** Never throws: if the cards can't be prepared the video is exported without them (and the caller is told). */
export async function prepareTitleCards(tc: TitleCardJob | undefined, o: PrepareOptions): Promise<TitleCardHooks | null> {
  try {
    return await prepare(tc, o);
  } catch {
    tc?.onWarning?.(CARDS_FAILED);
    return null;
  }
}

async function prepare(tc: TitleCardJob | undefined, o: PrepareOptions): Promise<TitleCardHooks | null> {
  const on = titleCardsActive(tc);
  if (!tc || (!on.title && !on.end)) return null;
  const { width: W, height: H, fps, canvas } = o;
  const look: ResolvedLook = resolveLook(tc.settings.look, tc.hint ?? { accent: o.visual.rightColor });
  const endText = endCardText(tc.settings.end, tc.text);
  const tl = cardTimeline(fps, on.title ? tc.settings.duration : 0, on.end ? tc.settings.end.duration : 0);
  const rollEnd = tl.intro + o.rollFrames / fps;
  const total = totalSeconds(tl, o.rollFrames);

  // fonts first, so frame 0 already uses them; never hangs (8 s timeout) and never fails the export
  try {
    const { ensureTitleFonts } = await import('./fonts');
    const r = await ensureTitleFonts(look, [on.title ? tc.text : endText, ...(on.end ? [endText] : [])]);
    if (!r.ok) tc.onWarning?.(FONT_WARNING);
  } catch {
    tc.onWarning?.(FONT_WARNING);
  }
  let images: TitleImages | null = await loadTitleImages(look, getMedia);
  const card: CardImages = { bgImage: images.bgImage, fillImage: images.fillImage, backdrop: null };
  let cache: TitleCardCache | null = new TitleCardCache();
  let layer: AnyCanvas | null = null;
  let rollFirst: AnyCanvas | null = null;
  let backdrop: AnyCanvas | null = null;
  const mainCtx = () => canvas.getContext('2d') as Ctx2D;

  const ensureBackdrop = () => {
    if (look.bg.kind !== 'video' || backdrop) return;
    backdrop = makeCanvas(W, H);
    o.renderer.drawBackdrop(backdrop.getContext('2d') as Ctx2D);
    card.backdrop = backdrop as CanvasImageSource;
  };

  // crossfade: the text fades into the title's own background first, then the roll comes in
  // under it (no double exposure of the letters and the keyboard)
  const drawIntro = (ctx: Ctx2D, t: number) => {
    const op = titleOpacity(t, tl.intro);
    if (op >= 1 || !rollFirst) {
      drawTitleCard(ctx, W, H, look, tc.text, card, t, cache!, { duration: tl.intro });
      return;
    }
    if (op >= 0.5) {
      drawTitleCard(ctx, W, H, look, tc.text, card, t, cache!, { duration: tl.intro, content: (op - 0.5) * 2 });
      return;
    }
    layer ??= makeCanvas(W, H);
    const lc = layer.getContext('2d') as Ctx2D;
    drawTitleCard(lc, W, H, look, tc.text, card, t, cache!, { duration: tl.intro, content: 0 });
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(rollFirst as CanvasImageSource, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = op * 2;
    ctx.drawImage(layer as CanvasImageSource, 0, 0);
    ctx.restore();
  };

  const drawOutro = (ctx: Ctx2D, t: number) => {
    drawTitleCard(ctx, W, H, look, endText, card, t, cache!, { duration: tl.outro, layout: END_LAYOUT });
    const op = endOpacity(t, tl.outro);
    if (op < 1) {
      ctx.save();
      ctx.fillStyle = `rgba(0,0,0,${1 - op})`;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  };

  /** keeps a copy of the first roll frame (the crossfade target); for real-time capture */
  const captureRollFirst = () => {
    rollFirst ??= makeCanvas(W, H);
    const c = rollFirst.getContext('2d') as Ctx2D;
    c.drawImage(canvas as CanvasImageSource, 0, 0);
  };

  const freeTitle = () => {
    layer = null;
    rollFirst = null;
    if (!on.end) {
      cache?.dispose();
      images?.dispose();
      images = null;
      card.bgImage = card.fillImage = card.backdrop = null;
      backdrop = null;
    }
  };

  let videoTrack: VideoTrackLike | null = null;
  let audioDone: Promise<void> | null = null;
  let audioError: unknown = null;

  let introMs = 0;

  return {
    timeline: tl,
    total,
    get introMs() {
      return introMs;
    },
    audio(track) {
      const sr = o.sampleRate ?? 48000;
      const w = shiftAudio(track, tl.intro, (timestamp, seconds) => {
        const frames = Math.round(seconds * sr);
        return new AudioSample({ data: new Float32Array(frames * 2), format: 'f32-planar', numberOfChannels: 2, sampleRate: sr, timestamp });
      });
      return {
        add: (s) => w.add(s),
        // the end card's silence is added right away, then the real track is closed (so the muxer
        // never waits for audio while the frames are rendered)
        close: () => {
          audioDone = w
            .finish(total)
            .then(() => track.close())
            .catch((e) => {
              audioError = e;
              try {
                track.close();
              } catch {
                /* already closed */
              }
            });
        },
      };
    },
    video(track) {
      videoTrack = track;
      const w = shiftVideo(track, tl.intro, async () => {
        ensureBackdrop();
        if (!tl.introFrames) return;
        const t0 = performance.now();
        // the canvas holds the first roll frame now: keep it for the crossfade, render the title
        captureRollFirst();
        const ctx = mainCtx();
        for (let i = 0; i < tl.introFrames; i++) {
          aborted(o.signal);
          drawIntro(ctx, i / fps);
          await track.add(i / fps, 1 / fps);
          o.onFrame?.(i + 1, tl.introFrames, 'title');
        }
        introMs = performance.now() - t0;
        ctx.save();
        ctx.globalCompositeOperation = 'copy';
        ctx.drawImage(rollFirst as CanvasImageSource, 0, 0);
        ctx.restore();
        freeTitle();
      });
      return { add: (t, d, opts) => w.add(t, d, opts), close: () => track.close() };
    },
    async finish() {
      if (audioDone) await audioDone;
      if (audioError) throw audioError;
      if (!tl.outroFrames) return;
      ensureBackdrop();
      const ctx = mainCtx();
      for (let i = 0; i < tl.outroFrames; i++) {
        aborted(o.signal);
        drawOutro(ctx, i / fps);
        await videoTrack?.add(rollEnd + i / fps, 1 / fps);
        o.onFrame?.(i + 1, tl.outroFrames, 'end');
      }
    },
    captureRollFirst() {
      ensureBackdrop();
      captureRollFirst();
    },
    drawIntro(ctx, t) {
      ensureBackdrop();
      drawIntro(ctx, t);
    },
    drawOutro(ctx, t) {
      ensureBackdrop();
      drawOutro(ctx, t);
    },
    dispose() {
      cache?.dispose();
      cache = null;
      images?.dispose();
      images = null;
      layer = rollFirst = backdrop = null;
    },
  };
}
