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
      void frames.frameAt(t).then((c) => {
        if (my !== seq.current || !c) return;
        // copy: the sink may reuse its canvases
        const copy = document.createElement('canvas');
        copy.width = c.width;
        copy.height = c.height;
        copy.getContext('2d')!.drawImage(c as CanvasImageSource, 0, 0);
        setImg({ canvas: copy, w: c.width, h: c.height, t });
      });
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
