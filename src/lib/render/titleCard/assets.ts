/**
 * The user's own images for the title page (background, letter fill). They live only in this
 * browser (IndexedDB media store) and are never uploaded. Big photos are downscaled when they are
 * added, and again when loaded for drawing, to keep memory small on phones.
 */
import { makeCanvas, type Ctx2D } from '../color';
import type { ResolvedLook } from './presets';

/** long edge in px */
export const MAX_BG_EDGE = 2048;
export const MAX_FILL_EDGE = 1600;

async function bitmapFromBlob(blob: Blob, maxEdge: number): Promise<ImageBitmap | null> {
  try {
    const bmp = await createImageBitmap(blob);
    const s = maxEdge / Math.max(bmp.width, bmp.height);
    if (s >= 1) return bmp;
    try {
      const small = await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * s), resizeHeight: Math.round(bmp.height * s), resizeQuality: 'high' });
      bmp.close();
      return small;
    } catch {
      return bmp;
    }
  } catch {
    return null;
  }
}

export interface TitleImages {
  bgImage: ImageBitmap | null;
  fillImage: ImageBitmap | null;
  dispose(): void;
}

type GetMedia = (id: string) => Promise<{ blob: Blob; kind: string } | undefined>;

/** Loads the images a look uses. A missing or broken image is simply left out (the style's own fill / background is drawn). */
export async function loadTitleImages(look: ResolvedLook, getMedia: GetMedia): Promise<TitleImages> {
  const load = async (id: string | null, max: number) => {
    if (!id) return null;
    try {
      const item = await getMedia(id);
      if (!item || item.kind !== 'image') return null;
      return await bitmapFromBlob(item.blob, max);
    } catch {
      return null;
    }
  };
  const [bgImage, fillImage] = await Promise.all([
    load(look.bg.kind === 'image' ? look.bg.mediaId : null, MAX_BG_EDGE),
    load(look.fill.kind === 'image' ? look.fill.mediaId : null, MAX_FILL_EDGE),
  ]);
  return {
    bgImage,
    fillImage,
    dispose() {
      bgImage?.close();
      fillImage?.close();
    },
  };
}

/**
 * Downscales an uploaded photo to at most `maxEdge` px (WebP, JPEG where WebP can't be encoded)
 * before it is stored. Small images are kept as they are.
 */
export async function downscaleUpload(file: Blob, maxEdge = MAX_BG_EDGE): Promise<{ blob: Blob; type: string }> {
  const bmp = await createImageBitmap(file);
  try {
    const s = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    if (s >= 1 && file.size < 3 * 1024 * 1024) return { blob: file, type: file.type };
    const w = Math.max(1, Math.round(bmp.width * s));
    const h = Math.max(1, Math.round(bmp.height * s));
    const c = makeCanvas(w, h);
    const ctx = c.getContext('2d') as Ctx2D;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    for (const type of ['image/webp', 'image/jpeg']) {
      const blob = await toBlob(c, type, 0.9);
      if (blob && blob.type === type) return { blob, type };
    }
    return { blob: file, type: file.type };
  } finally {
    bmp.close();
  }
}

function toBlob(c: OffscreenCanvas | HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  if ('convertToBlob' in c) return c.convertToBlob({ type, quality }).catch(() => null);
  return new Promise((resolve) => (c as HTMLCanvasElement).toBlob((b) => resolve(b), type, quality));
}
