import { useEffect, useRef, useState } from 'react';
import type { Song } from '../../lib/music/types';
import { getHandVideoBlob } from '../../lib/storage/db';
import { PreviewFrames } from '../../lib/handcam/frames';
import { loadLogo } from '../../lib/watermark/logo';

/** The song's hands video, opened for previews (one file handle while mounted). */
export function useHandFrames(song: Pick<Song, 'id' | 'handVideo'> | null, enabled = true): { frames: PreviewFrames | null; blob: Blob | null; error: string | null; loading: boolean } {
  const hv = song?.handVideo;
  const key = song && hv && enabled ? `${song.id}|${hv.store}|${hv.addedAt}` : '';
  const [state, setState] = useState<{ key: string; frames: PreviewFrames | null; blob: Blob | null; error: string | null }>({ key: '', frames: null, blob: null, error: null });
  useEffect(() => {
    if (!key || !song) return;
    let alive = true;
    let opened: PreviewFrames | null = null;
    void (async () => {
      try {
        const blob = await getHandVideoBlob(song);
        if (!blob) throw new Error('The video for this song is no longer saved. Add it again.');
        const frames = await PreviewFrames.open(blob, 960);
        if (!alive) {
          frames.dispose();
          return;
        }
        opened = frames;
        setState({ key, frames, blob, error: null });
      } catch (e) {
        if (alive) setState({ key, frames: null, blob: null, error: (e as Error).message });
      }
    })();
    return () => {
      alive = false;
      opened?.dispose();
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
          if (my !== seq.current || !c) return;
          // copy: the sink may reuse its canvases
          const { canvas: copy, ctx } = cpuCanvas(c.width, c.height);
          ctx.drawImage(c as CanvasImageSource, 0, 0);
          setImg({ canvas: copy, w: c.width, h: c.height, t });
        })
        // the file was closed meanwhile (the screen was left): nothing to show
        .catch(() => {});
    }, delay);
    return () => clearTimeout(timer);
  }, [frames, t, delay]);
  return frames ? img : null;
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

/**
 * An image URL (blob:) of a canvas `make` draws, encoded in the background with toBlob: encoding a
 * frame synchronously (toDataURL) while rendering blocks the page, for seconds when the graphics
 * process is busy. The previous URL stays shown until the new one is ready, and is then released.
 */
export function useCanvasUrl(make: () => HTMLCanvasElement | null, deps: unknown[], quality = 0.85): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const c = make();
    if (!c) {
      setUrl(null);
      return;
    }
    let alive = true;
    c.toBlob(
      (b) => {
        if (!alive || !b) return;
        setUrl(URL.createObjectURL(b));
      },
      'image/jpeg',
      quality,
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  // release each URL once a newer one replaces it (and on unmount)
  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);
  return url;
}

/** A canvas in ordinary memory (pixels read back cheaply: toBlob, getImageData). */
export function cpuCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true })! };
}

/** A frame as an image URL, at most `maxW` wide (made in the background). */
export function useFrameUrl(img: FrameImage | null, maxW = 960, quality = 0.8): string | null {
  return useCanvasUrl(
    () => {
      if (!img) return null;
      const k = Math.min(1, maxW / Math.max(1, img.w));
      const { canvas, ctx } = cpuCanvas(img.w * k, img.h * k);
      ctx.drawImage(img.canvas, 0, 0, canvas.width, canvas.height);
      return canvas;
    },
    [img, maxW],
    quality,
  );
}
