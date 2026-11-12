/**
 * Title page backgrounds: gradients, the user's image or the video's own background (dimmed),
 * plus soft diagonal light streaks, a star field and a vignette. Canvas 2D only: no ctx.filter
 * (missing in Safari), softness comes from gradients.
 */
import { hash, type Ctx2D } from '../color';
import type { BgSpec } from './presets';

const TAU = Math.PI * 2;

export interface CardImages {
  /** user image for the background (already downscaled) */
  bgImage?: CanvasImageSource | null;
  /** the Studio background (backdrop of the piano roll) for "Same as video" */
  backdrop?: CanvasImageSource | null;
  /** user image used inside the letters */
  fillImage?: CanvasImageSource | null;
}

export function sourceSize(src: CanvasImageSource): { w: number; h: number } {
  const s = src as unknown as { videoWidth?: number; naturalWidth?: number; displayWidth?: number; width?: number; videoHeight?: number; naturalHeight?: number; displayHeight?: number; height?: number };
  const w = s.videoWidth || s.naturalWidth || s.displayWidth || (typeof s.width === 'number' ? s.width : 0) || 1;
  const h = s.videoHeight || s.naturalHeight || s.displayHeight || (typeof s.height === 'number' ? s.height : 0) || 1;
  return { w, h };
}

/** Draws `src` covering the rect (centre crop). */
export function drawCover(ctx: Ctx2D, src: CanvasImageSource, x: number, y: number, w: number, h: number): void {
  const { w: sw, h: sh } = sourceSize(src);
  const s = Math.max(w / sw, h / sh);
  const dw = sw * s;
  const dh = sh * s;
  try {
    ctx.drawImage(src, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  } catch {
    /* not decodable (closed bitmap, video not ready) */
  }
}

function paintBase(ctx: Ctx2D, W: number, H: number, bg: BgSpec, img: CardImages): void {
  switch (bg.kind) {
    case 'color':
      ctx.fillStyle = bg.color;
      ctx.fillRect(0, 0, W, H);
      return;
    case 'linear': {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, bg.c0);
      g.addColorStop(1, bg.c1);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      return;
    }
    case 'radial': {
      const g = ctx.createRadialGradient(W / 2, H * 0.45, 0, W / 2, H * 0.45, Math.hypot(W, H) * 0.6);
      g.addColorStop(0, bg.c0);
      g.addColorStop(1, bg.c1);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      return;
    }
    case 'image':
    case 'video': {
      const src = bg.kind === 'image' ? img.bgImage : img.backdrop;
      if (!src) {
        paintBase(ctx, W, H, bg.fallback, img);
        return;
      }
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      if (bg.kind === 'video') ctx.drawImage(src, 0, 0, W, H);
      else drawCover(ctx, src, 0, 0, W, H);
      if (bg.dim > 0) {
        ctx.fillStyle = `rgba(0,0,0,${bg.dim})`;
        ctx.fillRect(0, 0, W, H);
      }
      return;
    }
  }
}

export interface BgExtras {
  streaks: boolean;
  stars: boolean;
}

export function drawCardBackground(ctx: Ctx2D, W: number, H: number, bg: BgSpec, img: CardImages, extras: BgExtras, t: number): void {
  paintBase(ctx, W, H, bg, img);
  if (extras.stars) drawStars(ctx, W, H, t);
  if (extras.streaks) drawStreaks(ctx, W, H, t);
  if (extras.streaks || extras.stars) drawVignette(ctx, W, H);
}

export function drawVignette(ctx: Ctx2D, W: number, H: number): void {
  const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.hypot(W, H) * 0.62);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
}

/** Soft diagonal light streaks (elongated radial gradients), drifting slowly and twinkling. */
export function drawStreaks(ctx: Ctx2D, W: number, H: number, t: number): void {
  const ang = (-68 * Math.PI) / 180;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 46; i++) {
    const R = (j: number) => hash(9901 + i, j);
    const broad = R(0) < 0.3;
    const w = H * (broad ? 0.03 + R(1) * 0.06 : 0.0025 + R(1) * 0.0075);
    const len = H * (0.5 + R(2) * 1.1);
    const a = (broad ? 0.025 : 0.045) * (0.4 + R(3) * 0.6);
    const drift = t * 0.012 * H;
    const px = -0.2 * W + R(4) * 1.4 * W;
    const py = H / 2 + (R(5) - 0.5) * 0.6 * H;
    const tw = 0.6 + 0.4 * Math.sin(t * (0.6 + R(6)) + R(7) * TAU);
    const col = R(8) < 0.5 ? '220,214,255' : '255,232,246';
    ctx.save();
    ctx.translate(px + Math.cos(ang) * drift, py + Math.sin(ang) * drift);
    ctx.rotate(ang);
    ctx.scale(len / 2, w / 2);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, `rgba(${col},${a * tw})`);
    g.addColorStop(0.5, `rgba(${col},${a * tw * 0.45})`);
    g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, TAU);
    ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

/** A four-point star: two thin diamonds and a soft glow. */
export function drawStar(ctx: Ctx2D, x: number, y: number, r: number, alpha: number, color = '255,248,230'): void {
  if (alpha <= 0.003 || r <= 0) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r * 1.2);
  g.addColorStop(0, `rgba(${color},${0.55 * alpha})`);
  g.addColorStop(1, `rgba(${color},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r * 1.2, 0, TAU);
  ctx.fill();
  ctx.fillStyle = `rgba(${color},${alpha})`;
  const t = r * 0.09;
  ctx.beginPath();
  ctx.moveTo(x - r, y);
  ctx.lineTo(x, y - t);
  ctx.lineTo(x + r, y);
  ctx.lineTo(x, y + t);
  ctx.closePath();
  ctx.moveTo(x, y - r);
  ctx.lineTo(x + t, y);
  ctx.lineTo(x, y + r);
  ctx.lineTo(x - t, y);
  ctx.closePath();
  ctx.fill();
}

/** Procedural star field: many faint dots plus a few twinkling four-point stars. */
export function drawStars(ctx: Ctx2D, W: number, H: number, t: number): void {
  const n = Math.round(160 * Math.sqrt((W * H) / (1920 * 1080)));
  ctx.save();
  for (let i = 0; i < n; i++) {
    const x = hash(7001, i) * W;
    const y = hash(7002, i) * H;
    const r = H * (0.0006 + hash(7003, i) ** 3 * 0.0022);
    const a = (0.25 + 0.6 * hash(7004, i)) * (0.75 + 0.25 * Math.sin(t * (0.5 + hash(7005, i)) + hash(7006, i) * TAU));
    ctx.fillStyle = `rgba(230,236,255,${a})`;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, TAU);
    ctx.fill();
  }
  for (let i = 0; i < 9; i++) {
    const x = hash(7101, i) * W;
    const y = hash(7102, i) * H;
    const tw = Math.max(0, Math.sin(t * 0.9 + hash(7103, i) * TAU)) ** 2;
    drawStar(ctx, x, y, H * (0.006 + hash(7104, i) * 0.006), 0.35 + 0.5 * tw, '230,236,255');
  }
  ctx.restore();
}
