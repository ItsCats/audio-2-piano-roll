/** A creator's watermark / channel link in exported videos (saved as the user's default). */
import type { FontKey } from '../render/titleCard/presets';

export type WatermarkPosition = 'bc' | 'bl' | 'br' | 'tl' | 'tr';

export interface WatermarkLogo {
  /** the image in the 'media' store (a downscaled PNG) */
  mediaId: string;
  position: WatermarkPosition;
  /** height as a share of the frame height */
  size: number;
  opacity: number;
}

export interface WatermarkSettings {
  enabled: boolean;
  text: string;
  /** capitals with wide letter spacing (like YOUTUBE.COM/YOURNAME) */
  spaced: boolean;
  font: FontKey;
  /** the part after the last "/" is brighter */
  highlightName: boolean;
  /** 1 = 26 px at 1080p */
  size: number;
  color: string;
  opacity: number;
  position: WatermarkPosition;
  /** also on the title page and end card */
  onCards: boolean;
  logo: WatermarkLogo | null;
}

export const WATERMARK_PLACEHOLDER = 'YOUTUBE.COM/YOURNAME';

export const DEFAULT_WATERMARK: WatermarkSettings = {
  enabled: false,
  text: '',
  spaced: true,
  font: 'cormorant',
  highlightName: true,
  size: 1,
  color: '#e8e8ee',
  opacity: 0.6,
  position: 'bc',
  onCards: false,
  logo: null,
};

const POSITIONS: WatermarkPosition[] = ['bc', 'bl', 'br', 'tl', 'tr'];
const FONTS: FontKey[] = ['cinzel', 'playfair', 'cormorant', 'garamond', 'vibes', 'inter'];
const clamp = (x: unknown, a: number, b: number, d: number) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(a, Math.min(b, x)) : d);

/** Settings read from storage, every field checked. */
export function sanitizeWatermark(raw: unknown): WatermarkSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<WatermarkSettings>;
  const d = DEFAULT_WATERMARK;
  const logo = r.logo && typeof r.logo === 'object' && typeof r.logo.mediaId === 'string' && r.logo.mediaId
    ? {
        mediaId: r.logo.mediaId,
        position: POSITIONS.includes(r.logo.position) ? r.logo.position : 'br',
        size: clamp(r.logo.size, 0.03, 0.25, 0.07),
        opacity: clamp(r.logo.opacity, 0.05, 1, 0.8),
      }
    : null;
  return {
    enabled: r.enabled === true,
    text: typeof r.text === 'string' ? r.text.slice(0, 80) : d.text,
    spaced: r.spaced !== false,
    font: FONTS.includes(r.font as FontKey) ? (r.font as FontKey) : d.font,
    highlightName: r.highlightName !== false,
    size: clamp(r.size, 0.5, 3, 1),
    color: typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : d.color,
    opacity: clamp(r.opacity, 0.05, 1, d.opacity),
    position: POSITIONS.includes(r.position as WatermarkPosition) ? (r.position as WatermarkPosition) : d.position,
    onCards: r.onCards === true,
    logo,
  };
}

/** Whether the watermark draws anything. */
export const watermarkActive = (w: WatermarkSettings): boolean => w.enabled && (!!w.text.trim() || !!w.logo);
