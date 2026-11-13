/**
 * The watermark logo: a PNG or SVG the user picks, downscaled to at most 512 px and stored as a PNG in
 * the 'media' store (marked as a logo so it isn't offered as a background). An SVG is drawn through an
 * <img>, which never runs its scripts.
 */
import { getMedia, newId, saveMedia, deleteMedia } from '../storage/db';

export const LOGO_MAX_PX = 512;
export const LOGO_MAX_BYTES = 10 * 1024 * 1024;

export async function storeLogo(file: File): Promise<string> {
  if (file.size > LOGO_MAX_BYTES) throw new Error('This image is too large (max 10 MB).');
  if (!/^image\/(png|svg\+xml|webp|jpeg)$/.test(file.type) && !/\.(png|svg|webp|jpe?g)$/i.test(file.name)) throw new Error('Choose a PNG or SVG image.');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    let w = img.naturalWidth || 512;
    let h = img.naturalHeight || 512;
    const k = Math.min(1, LOGO_MAX_PX / Math.max(w, h));
    w = Math.max(1, Math.round(w * k));
    h = Math.max(1, Math.round(h * k));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d')!.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Couldn’t read this image.'))), 'image/png'));
    const id = newId();
    // `purpose`: the Look panel's pickers only list their own uploads, so a logo never shows up there
    const item = { id, name: file.name, type: 'image/png', kind: 'image' as const, blob, createdAt: Date.now(), purpose: 'logo' };
    await saveMedia(item);
    return id;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The logo as an ImageBitmap (null if it is gone or broken). */
export async function loadLogo(mediaId: string | undefined | null): Promise<ImageBitmap | null> {
  if (!mediaId) return null;
  try {
    const m = await getMedia(mediaId);
    if (!m) return null;
    return await createImageBitmap(m.blob);
  } catch {
    return null;
  }
}

export async function removeLogo(mediaId: string): Promise<void> {
  await deleteMedia(mediaId).catch(() => {});
}
