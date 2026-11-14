/** The real-time recorder's file format (the export fallback without WebCodecs; pure, unit-tested). */
import { isAppleMobile } from '../transcription/backendChoice';

/** Safari (iPhone, iPad, Mac): Apple's own browser engine, whose Photos app and players want MP4. */
export function isAppleWebKit(ua: string, maxTouchPoints = 0): boolean {
  if (isAppleMobile(ua, maxTouchPoints)) return true; // every iPhone browser is Safari's engine
  return /Macintosh/.test(ua) && /Version\/[\d.]+.*Safari/.test(ua) && !/Chrome|Chromium|Edg|Firefox|OPR/.test(ua);
}

/**
 * The formats the real-time recorder tries, best first. On Apple devices MP4 (H.264 + AAC) comes first:
 * Safari 18.4 and later can record WebM too, but an iPhone can't save a WebM video to Photos.
 */
export function recorderMimeOrder(apple: boolean): string[] {
  const webm = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const mp4 = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'];
  return apple ? [...mp4, ...webm] : [...webm, ...mp4];
}

/** The video codec of a recording, named as the WebCodecs path names it ('avc', 'vp9', 'vp8'). */
export function recorderVideoCodec(type: string, isMp4: boolean): string {
  if (/vp0?9/i.test(type)) return 'vp9';
  if (/vp0?8/i.test(type)) return 'vp8';
  if (/avc|h264/i.test(type) || isMp4) return 'avc';
  return 'vp8'; // a WebM recording without a named codec
}
