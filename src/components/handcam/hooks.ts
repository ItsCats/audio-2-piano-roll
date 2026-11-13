import { useEffect, useRef, useState } from 'react';
import type { Song } from '../../lib/music/types';
import { getHandVideoBlob } from '../../lib/storage/db';
import { PreviewFrames } from '../../lib/handcam/frames';
import { loadLogo } from '../../lib/watermark/logo';

interface OpenVideo {
  refs: number;
  ready: Promise<{ frames: PreviewFrames; blob: Blob }>;
  closeTimer?: ReturnType<typeof setTimeout>;
}
/** one open file per song for all previews (thumbnail, export preview, setup): one decoder at a time */
const openVideos = new Map<string, OpenVideo>();

function acquireVideo(key: string, song: Pick<Song, 'id' | 'handVideo'>): Promise<{ frames: PreviewFrames; blob: Blob }> {
  let v = openVideos.get(key);
  if (!v) {
    const ready = (async () => {
      const blob = await getHandVideoBlob(song);
      if (!blob) throw new Error('The video for this song is no longer saved. Add it again.');
      return { frames: await PreviewFrames.open(blob, 960), blob };
    })();
    v = { refs: 0, ready };
    openVideos.set(key, v);
    // a failed open is not kept (the next screen tries again)
    ready.catch(() => {
      if (openVideos.get(key) === v) openVideos.delete(key);
    });
  }
  if (v.closeTimer) clearTimeout(v.closeTimer);
  v.closeTimer = undefined;
  v.refs++;
  return v.ready;
}

function releaseVideo(key: string): void {
  const v = openVideos.get(key);
  if (!v) return;
  v.refs = Math.max(0, v.refs - 1);
  if (v.refs > 0) return;
  // kept a moment: moving from the dialog to the setup screen doesn't reopen the file
  v.closeTimer = setTimeout(() => {
    if (openVideos.get(key) !== v || v.refs > 0) return;
    openVideos.delete(key);
    void v.ready.then(({ frames }) => frames.dispose()).catch(() => {});
  }, 1500);
}

/**
 * The song's hands video, opened for previews. All previews of a song share one open file, and it
 * decodes one frame at a time (PreviewFrames), so the setup screen, the thumbnail and the export
 * preview never run decoders side by side. `enabled` false lets go of it (a hidden preview).
 */
export function useHandFrames(song: Pick<Song, 'id' | 'handVideo'> | null, enabled = true): { frames: PreviewFrames | null; blob: Blob | null; error: string | null; loading: boolean } {
  const hv = song?.handVideo;
  const key = song && hv && enabled ? `${song.id}|${hv.store}|${hv.addedAt}` : '';
  const [state, setState] = useState<{ key: string; frames: PreviewFrames | null; blob: Blob | null; error: string | null }>({ key: '', frames: null, blob: null, error: null });
  useEffect(() => {
    if (!key || !song) return;
    let alive = true;
    acquireVideo(key, song).then(
      ({ frames, blob }) => alive && setState({ key, frames, blob, error: null }),
      (e: Error) => alive && setState({ key, frames: null, blob: null, error: e.message }),
    );
    return () => {
      alive = false;
      releaseVideo(key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!key) return { frames: null, blob: null, error: null, loading: false };
  if (state.key !== key) return { frames: null, blob: null, error: null, loading: true };
  return { frames: state.frames, blob: state.blob, error: state.error, loading: false };
}

export interface FrameImage {
  canvas: CanvasImageSource;
  w: number;
  h: number;
  t: number;
}

/** The frame at video time t (debounced while scrubbing; the last one stays shown). */
export function useVideoFrame(frames: PreviewFrames | null, t: number | null, delay = 90): FrameImage | null {
  const [img, setImg] = useState<FrameImage | null>(null);
  const seq = useRef(0);
  useEffect(() => {
    if (!frames || t === null) return;
    const my = ++seq.current;
    const timer = setTimeout(() => {
      frames
        .frameAt(t)
        .then((c) => {
          // the sink draws every frame into a new canvas (poolSize 0), so it can be kept as is; it stays
          // on the graphics side (no copy into ordinary memory, no image encoding)
          if (my !== seq.current || !c) return;
          setImg({ canvas: c as CanvasImageSource, w: c.width, h: c.height, t });
        })
        // the file was closed meanwhile (the screen was left): nothing to show
        .catch(() => {});
    }, delay);
    return () => clearTimeout(timer);
  }, [frames, t, delay]);
  return frames ? img : null;
}

/** The last frame shown, kept while the preview is paused (it lets go of the file); `key` names the video. */
export function useHeldFrame(live: FrameImage | null, key: string): FrameImage | null {
  const kept = useRef<{ key: string; img: FrameImage } | null>(null);
  if (live) kept.current = { key, img: live };
  return live ?? (kept.current?.key === key ? kept.current.img : null);
}

/** The watermark logo image (null when none). */
export function useLogo(mediaId: string | null | undefined): ImageBitmap | null {
  const [bmp, setBmp] = useState<{ id: string; bmp: ImageBitmap | null } | null>(null);
  useEffect(() => {
    if (!mediaId) return;
    let alive = true;
    let got: ImageBitmap | null = null;
    void loadLogo(mediaId).then((b) => {
      got = b;
      if (alive) setBmp({ id: mediaId, bmp: b });
      else b?.close();
    });
    return () => {
      alive = false;
      got?.close();
    };
  }, [mediaId]);
  return mediaId && bmp?.id === mediaId ? bmp.bmp : null;
}

/** A canvas in ordinary memory (pixels read back cheaply: toBlob, getImageData). */
export function cpuCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true })! };
}

/** How a frame is shown: turned 180° and/or mirrored (the setup's Turn and Mirror). */
export interface Orient {
  turn?: 0 | 180;
  mirror?: boolean;
}

/**
 * Draws `src` (w × h) into `ctx` over (x, y, dw, dh), turned / mirrored. A canvas to canvas copy stays on
 * the graphics side: nothing is read back or encoded, so it never waits for the decoders.
 */
export function drawOriented(ctx: CanvasRenderingContext2D, src: CanvasImageSource, o: Orient | null | undefined, dx: number, dy: number, dw: number, dh: number, sx = 0, sy = 0, sw?: number, sh?: number): void {
  ctx.save();
  ctx.translate(dx + dw / 2, dy + dh / 2);
  if (o?.turn === 180) ctx.rotate(Math.PI);
  if (o?.mirror) ctx.scale(-1, 1);
  if (sw !== undefined && sh !== undefined) ctx.drawImage(src, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
  else ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}
