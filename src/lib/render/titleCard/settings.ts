/**
 * Validation of saved title page settings (never throws; unknown or broken values fall back to
 * the defaults) and the default text for a song.
 */
import { TITLE_PRESETS } from './presets';
import { FILL_PATTERNS } from './patterns';
import {
  DEFAULT_END_MAIN,
  DEFAULT_LOOK,
  DEFAULT_TITLE_CARD,
  MAX_DURATION,
  MAX_SONGS,
  MIN_DURATION,
  TEXT_ROLES,
  type EndCardSettings,
  type SongTitleText,
  type TitleCardSettings,
  type TitleLook,
  type TitleText,
} from './types';

const FONTS = ['playfair', 'cinzel', 'cormorant', 'garamond', 'script', 'modern'] as const;
const FILLS = ['solid', 'gradient', 'pattern', 'image'] as const;
const SCOPES = ['title', 'main', 'all'] as const;
const DIVIDERS = ['none', 'rules', 'diamond', 'vine', 'scroll'] as const;
const BGS = ['style', 'color', 'gradient', 'video', 'image'] as const;
const MAX_TEXT = 200;

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | null => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null);
const hex = (v: unknown): string | null => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null);
const hexPair = (v: unknown): [string, string] | null => {
  if (!Array.isArray(v) || v.length !== 2) return null;
  const a = hex(v[0]);
  const b = hex(v[1]);
  return a && b ? [a, b] : null;
};
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const id = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 && v.length < 200 ? v : null);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v.slice(0, MAX_TEXT) : fallback);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** 2..10 s, rounded to 0.5 s. */
export function clampDuration(v: unknown, fallback = 4): number {
  const n = num(v) ?? fallback;
  return Math.min(MAX_DURATION, Math.max(MIN_DURATION, Math.round(n * 2) / 2));
}

export function sanitizeLook(raw: unknown): TitleLook {
  const r = obj(raw);
  const angle = num(r.gradientAngle);
  const dim = num(r.dim);
  return {
    preset: oneOf(r.preset, TITLE_PRESETS.map((p) => p.id)) ?? DEFAULT_LOOK.preset,
    font: oneOf(r.font, FONTS),
    fill: oneOf(r.fill, FILLS),
    fillColor: hex(r.fillColor),
    gradient: hexPair(r.gradient),
    gradientAngle: angle === null ? null : ((Math.round(angle) % 360) + 360) % 360,
    pattern: oneOf(r.pattern, FILL_PATTERNS.map((p) => p.id)),
    fillImageId: id(r.fillImageId),
    fillScope: oneOf(r.fillScope, SCOPES),
    divider: oneOf(r.divider, DIVIDERS),
    bg: oneOf(r.bg, BGS),
    bgColor: hex(r.bgColor),
    bgGradient: hexPair(r.bgGradient),
    bgImageId: id(r.bgImageId),
    dim: dim === null ? null : Math.min(0.8, Math.max(0, dim)),
    textColor: hex(r.textColor),
    streaks: bool(r.streaks),
    sparkles: bool(r.sparkles),
    zoom: bool(r.zoom),
    shine: bool(r.shine),
  };
}

function sanitizeText(raw: unknown): Partial<TitleText> {
  const r = obj(raw);
  const out: Partial<TitleText> = {};
  for (const k of TEXT_ROLES) if (typeof r[k] === 'string') out[k] = str(r[k]);
  return out;
}

/** Keeps the `max` most recently changed songs. */
export function trimSongs(songs: Record<string, SongTitleText>, max = MAX_SONGS): Record<string, SongTitleText> {
  const entries = Object.entries(songs);
  if (entries.length <= max) return songs;
  return Object.fromEntries(entries.sort((a, b) => b[1].at - a[1].at).slice(0, max));
}

export function sanitizeEnd(raw: unknown): EndCardSettings {
  const r = obj(raw);
  const d = DEFAULT_TITLE_CARD.end;
  return {
    enabled: bool(r.enabled) ?? d.enabled,
    duration: clampDuration(r.duration, d.duration),
    main: typeof r.main === 'string' ? str(r.main) : DEFAULT_END_MAIN,
    credit: typeof r.credit === 'string' ? str(r.credit) : null,
    small: str(r.small),
  };
}

export function sanitizeTitleCard(raw: unknown): TitleCardSettings {
  const r = obj(raw);
  const rem = obj(r.remembered);
  const songs: Record<string, SongTitleText> = {};
  for (const [k, v] of Object.entries(obj(r.songs))) {
    const e = obj(v);
    if (!id(k)) continue;
    songs[k] = { text: sanitizeText(e.text), at: num(e.at) ?? 0 };
  }
  return {
    enabled: bool(r.enabled) ?? DEFAULT_TITLE_CARD.enabled,
    duration: clampDuration(r.duration, DEFAULT_TITLE_CARD.duration),
    look: sanitizeLook(r.look),
    remembered: { credit: str(rem.credit), small: str(rem.small) },
    songs: trimSongs(songs),
    end: sanitizeEnd(r.end),
  };
}

/** "Chopin - Ballade No. 1" → composer "Chopin", title "Ballade No. 1" (only when the song has no artist). */
export function splitTitle(title: string): { title: string; composer: string } | null {
  const m = /^(.+?)\s[-–—]\s(.+)$/.exec(title.trim());
  return m ? { composer: m[1].trim(), title: m[2].trim() } : null;
}

export function defaultTextForSong(song: { title: string; artist?: string }, remembered: TitleCardSettings['remembered']): TitleText {
  let title = song.title?.trim() ?? '';
  let composer = song.artist?.trim() ?? '';
  if (!composer) {
    const s = splitTitle(title);
    if (s) {
      title = s.title;
      composer = s.composer;
    }
  }
  return { title, subtitle: '', composer, credit: remembered.credit, small: remembered.small };
}

/** The title page text for a song: defaults from the song, then the user's changes for it. */
export function textForSong(song: { id: string; title: string; artist?: string }, settings: TitleCardSettings): TitleText {
  return { ...defaultTextForSong(song, settings.remembered), ...(settings.songs[song.id]?.text ?? {}) };
}

/** End card text in title page roles: main line → title, credit, small line. */
export function endCardText(end: EndCardSettings, titleText: TitleText): TitleText {
  return { title: end.main, subtitle: '', composer: '', credit: end.credit ?? titleText.credit, small: end.small };
}
