/**
 * Keeps the title page readable on any background: on a light colour, gradient or photo the text
 * turns dark (unless the user picked a text colour), filled letters get a soft edge, and a busy
 * photo inside the letters is brightened so its dark parts don't vanish on a dark background.
 * Pure except `meanLuminance`, which samples an image through a tiny canvas.
 */
import { makeCanvas, type Ctx2D } from '../color';
import { sourceSize } from './background';
import type { LineSpec, ResolvedLook } from './presets';
import type { TextRole } from './types';

/** Lighter than this (relative luminance), dark text reads better than light text. */
export const LIGHT_BG = 0.2;

/** How the letter fill is toned for contrast: 'lift' brightens dark parts, 'deepen' darkens light ones. */
export type FillTone = 'none' | 'lift' | 'deepen';

export interface Halo {
  color: string;
  /** blur as a fraction of the output height */
  blur: number;
}

const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** WCAG relative luminance of a #rrggbb colour (0 for anything else). */
export function hexLuminance(hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return 0;
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * lin(((n >> 16) & 255) / 255) + 0.7152 * lin(((n >> 8) & 255) / 255) + 0.0722 * lin((n & 255) / 255);
}

export interface LumStats {
  median: number;
  /** darker / lighter parts (10th / 90th percentile) */
  lo: number;
  hi: number;
}

/**
 * Luminance spread of the part of an image that lies behind the text (`r` in the image's own
 * pixels), sampled through a tiny canvas. Busy photos are judged by their bright and dark parts,
 * not only their average.
 */
export function regionStats(src: CanvasImageSource, r: { x0: number; y0: number; x1: number; y1: number }): LumStats {
  try {
    const c = makeCanvas(32, 16);
    const g = c.getContext('2d', { willReadFrequently: true }) as Ctx2D | null;
    if (!g) return { median: 0, lo: 0, hi: 0 };
    g.drawImage(src, r.x0, r.y0, Math.max(1, r.x1 - r.x0), Math.max(1, r.y1 - r.y0), 0, 0, 32, 16);
    const d = g.getImageData(0, 0, 32, 16).data;
    const v: number[] = [];
    for (let i = 0; i < d.length; i += 4) v.push(0.2126 * lin(d[i] / 255) + 0.7152 * lin(d[i + 1] / 255) + 0.0722 * lin(d[i + 2] / 255));
    v.sort((a, b) => a - b);
    const q = (f: number) => v[Math.min(v.length - 1, Math.floor(f * v.length))];
    return { median: q(0.5), lo: q(0.1), hi: q(0.9) };
  } catch {
    return { median: 0, lo: 0, hi: 0 }; // not drawable yet: treat as dark (the style's light text)
  }
}

/** Where an output rect falls in a background picture drawn to cover (or stretched over) W×H. */
export function sourceRect(src: CanvasImageSource, W: number, H: number, r: { x0: number; y0: number; x1: number; y1: number }, cover: boolean) {
  const { w: sw, h: sh } = sourceSize(src);
  const clamp = (v: number, m: number) => Math.max(0, Math.min(m, v));
  if (!cover) return { x0: clamp((r.x0 / W) * sw, sw), x1: clamp((r.x1 / W) * sw, sw), y0: clamp((r.y0 / H) * sh, sh), y1: clamp((r.y1 / H) * sh, sh) };
  const s = Math.max(W / sw, H / sh);
  const ox = (W - sw * s) / 2;
  const oy = (H - sh * s) / 2;
  return { x0: clamp((r.x0 - ox) / s, sw), x1: clamp((r.x1 - ox) / s, sw), y0: clamp((r.y0 - oy) / s, sh), y1: clamp((r.y1 - oy) / s, sh) };
}

/** A soft dark (or light) patch behind the text on a busy picture. */
export interface Scrim {
  rgb: string;
  alpha: number;
}

/** white scrim that lifts the darkest parts behind dark text to ~0.45 */
const lightScrim = (p: LumStats) => Math.max(0, (0.45 - p.lo) / (1 - p.lo));
/** black scrim that brings the brightest parts behind light text down to ~0.12 */
const darkScrim = (p: LumStats) => Math.max(0, 1 - 0.12 / Math.max(0.12, p.hi));

const DARK: Record<TextRole, string> = { title: '#17151b', subtitle: '#25222b', composer: '#17151b', credit: '#4a4652', small: '#5b5763' };
const MAIN: TextRole[] = ['title', 'subtitle', 'composer'];

/**
 * The look adapted to a background of luminance `lum` (a flat colour / gradient), or to a picture
 * with the luminance spread `photo` behind the text: there the text colour follows the typical
 * brightness, every line gets a soft halo and a scrim evens out the bright (or dark) parts.
 */
export function adaptLook(look: ResolvedLook, lum: number, photo: LumStats | null = null): ResolvedLook {
  // on a picture: dark text only when it is mostly light behind the text
  const light = (photo ? photo.median : lum) > LIGHT_BG;
  const out: ResolvedLook = { ...look, lines: { ...look.lines } };
  if (light) {
    for (const r of Object.keys(out.lines) as TextRole[]) {
      const own = (MAIN.includes(r) && look.userText) || (look.userFill && look.fillRoles.includes(r));
      if (!own) out.lines[r] = { ...out.lines[r], color: DARK[r] } as LineSpec;
    }
    if (!(look.userFill && look.fillDividers)) out.dividerColor = /^#d9b766$/i.test(look.dividerColor) ? '#8a6a2c' : 'rgba(23,21,27,0.72)';
    out.glow = null;
    out.halo = { color: 'rgba(24,18,32,0.55)', blur: 0.004 };
    out.fillTone = 'deepen';
    out.textHalo = photo ? { color: 'rgba(255,255,255,0.6)', blur: 0.008 } : null;
    // dark text: lift the darkest parts behind it to at least ~0.45
    if (photo && lightScrim(photo) > 0) out.scrim = { rgb: '255,255,255', alpha: Math.min(0.5, lightScrim(photo)) };
  } else if (photo) {
    out.halo = { color: 'rgba(0,0,0,0.7)', blur: 0.009 };
    out.textHalo = { color: 'rgba(0,0,0,0.7)', blur: 0.009 };
    // light text: bring the brightest parts behind it down to ~0.12
    if (darkScrim(photo) > 0) out.scrim = { rgb: '0,0,0', alpha: Math.min(0.6, darkScrim(photo)) };
  }
  return out;
}
