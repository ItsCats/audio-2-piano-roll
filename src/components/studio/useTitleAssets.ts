import { useEffect, useState } from 'react';
import type { ResolvedLook } from '../../lib/render/titleCard/presets';
import type { CardImages } from '../../lib/render/titleCard/background';
import { loadTitleImages } from '../../lib/render/titleCard/assets';
import { fontEpoch, onFontEpoch } from '../../lib/render/titleCard/fontEpoch';
import type { TitleText } from '../../lib/render/titleCard/types';
import { getMedia } from '../../lib/storage/db';
import { PianoRollRenderer } from '../../lib/render/renderer';
import type { VisualSettings } from '../../lib/render/settings';
import { useBackgroundMedia } from './useBackgroundMedia';

/** The user's images a title page look uses (local only), loaded and downscaled for the preview. */
export function useTitleImages(look: ResolvedLook): CardImages {
  const bgId = look.bg.kind === 'image' ? look.bg.mediaId : null;
  const fillId = look.fill.kind === 'image' ? look.fill.mediaId : null;
  const [imgs, setImgs] = useState<{ key: string; bgImage: ImageBitmap | null; fillImage: ImageBitmap | null }>({ key: '', bgImage: null, fillImage: null });
  useEffect(() => {
    if (!bgId && !fillId) return;
    let alive = true;
    let dispose: (() => void) | null = null;
    void loadTitleImages(look, getMedia).then((r) => {
      if (!alive) return r.dispose();
      dispose = r.dispose;
      setImgs({ key: `${bgId}|${fillId}`, bgImage: r.bgImage, fillImage: r.fillImage });
    });
    return () => {
      alive = false;
      dispose?.();
    };
    // only the image ids matter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgId, fillId]);
  const fresh = imgs.key === `${bgId}|${fillId}`;
  return { bgImage: fresh && bgId ? imgs.bgImage : null, fillImage: fresh && fillId ? imgs.fillImage : null };
}

/** The Studio background as a picture, for "Same as video" (null unless that background is used). */
export function useStudioBackdrop(want: boolean, visual: VisualSettings, width: number, height: number): CanvasImageSource | null {
  const media = useBackgroundMedia(want ? visual.background : { ...visual.background, kind: 'preset', mediaId: null });
  const [backdrop, setBackdrop] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    if (!want) {
      setBackdrop(null);
      return;
    }
    const c = document.createElement('canvas');
    const r = new PianoRollRenderer(c, visual);
    r.resize(width, height);
    if (media.source) r.setBackgroundMedia(media.source, media.kind);
    const draw = () => {
      try {
        r.drawBackdrop(c.getContext('2d')!);
      } catch {
        /* media not ready */
      }
      // a new canvas each time, so the previews redraw (and measure its brightness again)
      const copy = document.createElement('canvas');
      copy.width = c.width;
      copy.height = c.height;
      copy.getContext('2d')?.drawImage(c, 0, 0);
      setBackdrop(copy);
    };
    draw();
    // a video's first frame may arrive a little later
    const id = window.setTimeout(draw, 300);
    return () => window.clearTimeout(id);
  }, [want, visual, width, height, media.source, media.kind]);
  return backdrop;
}

/** Loads the title fonts a card needs (lazily). Redraws come from `useFontEpoch`. */
export function useTitleFonts(look: ResolvedLook, texts: TitleText[]): void {
  const key = JSON.stringify([look.lines, texts]);
  useEffect(() => {
    if (!texts.length) return;
    void import('../../lib/render/titleCard/fonts').then(({ ensureTitleFonts }) => ensureTitleFonts(look, texts));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

/** A counter that changes when title fonts arrive (or fail), so canvases redraw with them. */
export function useFontEpoch(): number {
  const [n, setN] = useState(fontEpoch);
  useEffect(() => onFontEpoch(() => setN(fontEpoch())), []);
  return n;
}
