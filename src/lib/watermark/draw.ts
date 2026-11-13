/** Draws the watermark (text and logo) onto a video frame. */
import { hexToRgb, rgba, type Ctx2D } from '../render/color';
import type { WatermarkSettings } from './types';
import { watermarkLayout, type Measure, type WatermarkLayout } from './layout';

/** text widths from a canvas context (cached per font and string) */
export function canvasMeasure(ctx: Ctx2D): Measure {
  const cache = new Map<string, number>();
  return (text, font) => {
    const k = `${font}|${text}`;
    let v = cache.get(k);
    if (v === undefined) {
      ctx.save();
      ctx.font = font;
      v = ctx.measureText(text).width;
      ctx.restore();
      cache.set(k, v);
    }
    return v;
  };
}

export interface WatermarkPainter {
  layout: WatermarkLayout;
  draw(ctx: Ctx2D, alpha?: number): void;
}

/**
 * Lays the watermark out once for a frame size; draw() then paints it on each frame. The text and logo
 * (with their soft shadow) are drawn once into a small picture of their own, so each video frame costs
 * one image copy instead of a blurred draw per letter.
 */
export function watermarkPainter(
  w: WatermarkSettings,
  W: number,
  H: number,
  ctx: Ctx2D,
  opts: { band?: number; avoidBottom?: number; logo?: CanvasImageSource | null; logoAspect?: number } = {},
): WatermarkPainter {
  const layout = watermarkLayout(w, W, H, canvasMeasure(ctx), { band: opts.band, avoidBottom: opts.avoidBottom, logoAspect: opts.logoAspect });
  const color = hexToRgb(w.color);
  const paint = (c: Ctx2D, alpha: number, dx = 0, dy = 0) => {
    c.save();
    c.setTransform(1, 0, 0, 1, dx, dy);
    c.shadowColor = 'rgba(0,0,0,0.5)';
    c.shadowBlur = 6 * layout.scale;
    c.shadowOffsetY = 1 * layout.scale;
    c.font = layout.font;
    c.textBaseline = 'alphabetic';
    c.textAlign = 'left';
    for (const g of layout.glyphs) {
      c.fillStyle = rgba(color, w.opacity * g.alpha * alpha);
      c.fillText(g.ch, g.x, layout.baseline);
    }
    for (const r of layout.runs) {
      c.fillStyle = rgba(color, w.opacity * r.alpha * alpha);
      c.fillText(r.text, r.x, layout.baseline);
    }
    if (layout.logo && opts.logo && w.logo) {
      c.shadowBlur = 4 * layout.scale;
      c.globalAlpha = w.logo.opacity * alpha;
      try {
        c.drawImage(opts.logo, layout.logo.x, layout.logo.y, layout.logo.w, layout.logo.h);
      } catch {
        /* image not ready */
      }
    }
    c.restore();
  };
  const area = watermarkArea(layout, !!(opts.logo && w.logo), W, H);
  let cache: { canvas: OffscreenCanvas | HTMLCanvasElement } | null | undefined;
  const makeCache = () => {
    if (!area) return null;
    try {
      const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(area.w, area.h) : typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: area.w, height: area.h }) : null;
      const c = canvas?.getContext('2d') as Ctx2D | null | undefined;
      if (!canvas || !c) return null;
      paint(c, 1, -area.x, -area.y);
      return { canvas };
    } catch {
      return null;
    }
  };
  return {
    layout,
    draw(c, alpha = 1) {
      if (alpha <= 0) return;
      if (cache === undefined) cache = makeCache();
      if (!cache || !area) return paint(c, alpha);
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.globalAlpha = alpha;
      c.drawImage(cache.canvas as CanvasImageSource, area.x, area.y);
      c.restore();
    },
  };
}

/** The part of the frame the watermark covers (text, logo and shadow), in whole pixels; null when empty. */
export function watermarkArea(layout: WatermarkLayout, withLogo: boolean, W: number, H: number): { x: number; y: number; w: number; h: number } | null {
  const boxes = [layout.bbox, withLogo ? layout.logo : null].filter((b): b is NonNullable<typeof b> => !!b && b.w > 0 && b.h > 0);
  if (!boxes.length) return null;
  // room for the shadow (blur 6, 1 down) and for letters that reach past their measured box
  const pad = Math.ceil(14 * layout.scale + layout.px * 0.35);
  const x0 = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.x)) - pad));
  const y0 = Math.max(0, Math.floor(Math.min(...boxes.map((b) => b.y)) - pad));
  const x1 = Math.min(W, Math.ceil(Math.max(...boxes.map((b) => b.x + b.w)) + pad));
  const y1 = Math.min(H, Math.ceil(Math.max(...boxes.map((b) => b.y + b.h)) + pad));
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}
