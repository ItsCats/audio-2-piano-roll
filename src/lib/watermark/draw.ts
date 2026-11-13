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

/** Lays the watermark out once for a frame size; draw() then paints it on each frame. */
export function watermarkPainter(
  w: WatermarkSettings,
  W: number,
  H: number,
  ctx: Ctx2D,
  opts: { band?: number; avoidBottom?: number; logo?: CanvasImageSource | null; logoAspect?: number } = {},
): WatermarkPainter {
  const layout = watermarkLayout(w, W, H, canvasMeasure(ctx), { band: opts.band, avoidBottom: opts.avoidBottom, logoAspect: opts.logoAspect });
  const color = hexToRgb(w.color);
  return {
    layout,
    draw(c, alpha = 1) {
      if (alpha <= 0) return;
      c.save();
      c.setTransform(1, 0, 0, 1, 0, 0);
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
    },
  };
}
