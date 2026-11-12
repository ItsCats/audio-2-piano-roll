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

/** Pixel size of an image file without decoding all its pixels (null where that can't be done). */
async function imageSize(blob: Blob): Promise<{ w: number; h: number } | null> {
  if (typeof Image === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) return null;
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('not an image'));
      img.src = url;
    });
    return img.naturalWidth && img.naturalHeight ? { w: img.naturalWidth, h: img.naturalHeight } : null;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Decodes an image file straight to at most `maxEdge` px where the browser can (a 48 MP phone
 * photo would otherwise take ~190 MB while it is decoded at full size), else decodes and resizes.
 */
export async function decodeSmall(blob: Blob, maxEdge: number): Promise<ImageBitmap> {
  const size = await imageSize(blob);
  if (size) {
    const s = maxEdge / Math.max(size.w, size.h);
    if (s < 1) {
      try {
        return await createImageBitmap(blob, { resizeWidth: Math.max(1, Math.round(size.w * s)), resizeHeight: Math.max(1, Math.round(size.h * s)), resizeQuality: 'high' });
      } catch {
        /* resize options not supported: decode first */
      }
    }
  }
  return createImageBitmap(blob);
}

async function bitmapFromBlob(blob: Blob, maxEdge: number): Promise<ImageBitmap | null> {
  try {
    const bmp = await decodeSmall(blob, maxEdge);
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
  const bmp = await decodeSmall(file, maxEdge);
  try {
    const s = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
    if (s >= 1 && bmp.width < maxEdge && bmp.height < maxEdge && file.size < 3 * 1024 * 1024) return { blob: file, type: file.type };
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
