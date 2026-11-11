import { useEffect, useState } from 'react';
import type { DecalSettings } from '../../lib/render/settings';
import { getMedia } from '../../lib/storage/db';

export interface DecalImage {
  source: CanvasImageSource;
  width: number;
  height: number;
}

/**
 * Loads the user's uploaded decal image (decal.source === 'image') from IndexedDB.
 * Returns null while loading, when no image is chosen, or when the decal uses a pattern.
 * The object URL is revoked as soon as the image has decoded (or the hook unmounts).
 */
export function useDecalImage(decal: DecalSettings): DecalImage | null {
  const [state, setState] = useState<DecalImage | null>(null);
  const mediaId = decal.source === 'image' ? decal.mediaId : null;
  useEffect(() => {
    if (!mediaId) {
      setState(null);
      return;
    }
    let alive = true;
    let url: string | null = null;
    const revoke = () => {
      if (url) URL.revokeObjectURL(url);
      url = null;
    };
    void getMedia(mediaId).then((item) => {
      if (!alive) return;
      if (!item || item.kind !== 'image') {
        setState(null);
        return;
      }
      url = URL.createObjectURL(item.blob);
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        revoke();
        if (alive) setState({ source: img, width: img.naturalWidth, height: img.naturalHeight });
      };
      img.onerror = () => {
        revoke();
        if (alive) setState(null);
      };
      img.src = url;
    });
    return () => {
      alive = false;
      revoke();
    };
  }, [mediaId]);
  return state;
}
