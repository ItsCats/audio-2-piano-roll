import { useEffect, useRef, type CSSProperties } from 'react';
import { drawOriented, type FrameImage, type Orient } from './hooks';

/**
 * A video frame on the page, drawn straight into a canvas (turned / mirrored if asked). No image is
 * encoded and no pixels are read back, so showing a frame never waits for the decoders or the sync.
 */
export function FrameCanvas({
  img,
  orient,
  maxW = 960,
  className,
  style,
  label,
}: {
  img: FrameImage;
  orient?: Orient | null;
  /** at most this many pixels wide (the canvas is scaled by CSS) */
  maxW?: number;
  className?: string;
  style?: CSSProperties;
  /** what the picture shows (for screen readers); none: decorative */
  label?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const turn = orient?.turn;
  const mirror = orient?.mirror;
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const k = Math.min(1, maxW / Math.max(1, img.w));
    const w = Math.max(1, Math.round(img.w * k));
    const h = Math.max(1, Math.round(img.h * k));
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    drawOriented(ctx, img.canvas, { turn, mirror }, 0, 0, w, h);
  }, [img, turn, mirror, maxW]);
  return <canvas ref={ref} className={className} style={style} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}
