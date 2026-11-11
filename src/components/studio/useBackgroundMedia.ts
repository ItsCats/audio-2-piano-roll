import { useEffect, useState } from 'react';
import type { BackgroundSettings } from '../../lib/render/settings';
import { getMedia } from '../../lib/storage/db';
import { getPlayer } from '../../state/playback';

/** Loads the user's background image/video from IndexedDB for the live view. */
export function useBackgroundMedia(bg: BackgroundSettings): { source: CanvasImageSource | null; kind: 'image' | 'video' | null } {
  const [state, setState] = useState<{ source: CanvasImageSource | null; kind: 'image' | 'video' | null }>({ source: null, kind: null });
  const wantMedia = (bg.kind === 'image' || bg.kind === 'video') && bg.mediaId;
  useEffect(() => {
    if (!wantMedia) {
      setState({ source: null, kind: null });
      return;
    }
    let url: string | null = null;
    let alive = true;
    let video: HTMLVideoElement | null = null;
    let unsub: (() => void) | null = null;
    void getMedia(bg.mediaId!)
      .catch(() => undefined)
      .then((item) => {
      if (!alive || !item) return;
      url = URL.createObjectURL(item.blob);
      if (item.kind === 'image') {
        const img = new Image();
        img.onload = () => alive && setState({ source: img, kind: 'image' });
        img.src = url;
      } else {
        video = document.createElement('video');
        video.src = url;
        video.muted = true;
        video.loop = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.onloadeddata = () => alive && setState({ source: video, kind: 'video' });
        const player = getPlayer();
        const sync = () => {
          if (!video) return;
          if (player.isPlaying) void video.play().catch(() => {});
          else video.pause();
        };
        unsub = player.subscribe(sync);
        void video.play().catch(() => {});
      }
    });
    return () => {
      alive = false;
      unsub?.();
      video?.pause();
      if (url) URL.revokeObjectURL(url);
    };
  }, [wantMedia, bg.mediaId]);
  return state;
}
