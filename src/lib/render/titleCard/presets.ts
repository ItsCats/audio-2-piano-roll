/**
 * Title page style presets (data only) and resolving a look (preset + user tweaks) into what the
 * layout and the renderer draw. Pure: no DOM, safe in unit tests and workers.
 */
import type { DividerId, FillPatternId, FillScope, TextRole, TitleFontId, TitleLook, TitlePresetId } from './types';
import { adaptLook, hexLuminance, type FillTone, type Halo, type Scrim } from './contrast';

/** Font families shipped for the title page (see fonts.ts). */
export type FontKey = 'cinzel' | 'playfair' | 'cormorant' | 'garamond' | 'vibes' | 'inter';

/**
 * CSS family names. The private "P2V" prefix keeps an installed system font of the same name from
 * being used instead of ours. CJK, emoji and other scripts fall back to the system fonts.
 */
export const FAMILY: Record<FontKey, string> = {
  cinzel: "'P2V Cinzel'",
  playfair: "'P2V Playfair'",
  cormorant: "'P2V Cormorant'",
  garamond: "'P2V Garamond'",
  vibes: "'P2V Vibes'",
  inter: "'P2V Inter'",
};
const SERIF_FALLBACK = "'Noto Serif JP', 'Noto Serif CJK JP', 'Source Han Serif', 'Hiragino Mincho ProN', 'Yu Mincho', 'Songti SC', 'SimSun', 'Noto Serif', Georgia, serif";
const SANS_FALLBACK = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/** Weights each family ships with (Inter is variable). */
export const FONT_WEIGHTS: Record<FontKey, number[]> = {
  cinzel: [400, 700, 900],
  playfair: [400, 700, 900],
  cormorant: [500, 600, 700],
  garamond: [500, 700],
  vibes: [400],
  inter: [],
};

export function nearestWeight(font: FontKey, w: number): number {
  const list = FONT_WEIGHTS[font];
  if (!list.length) return Math.max(100, Math.min(900, w));
  return list.reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a));
}

export function familyCss(font: FontKey): string {
  return `${FAMILY[font]}, ${font === 'inter' ? SANS_FALLBACK : SERIF_FALLBACK}`;
}

export interface LineSpec {
  font: FontKey;
  weight: number;
  /** cap size as a fraction of the base unit B (see layout.ts) */
  size: number;
  /** letter spacing in em */
  track: number;
  upper: boolean;
  color: string;
  /**
   * Playfair, Cormorant and EB Garamond draw old-style figures and Canvas 2D cannot switch font
   * features, so digits on caps lines are drawn in this family (Cinzel) instead.
   */
  digits?: FontKey;
  /** extra space between words in em (the script font's own word space is very narrow) */
  wordSpace?: number;
}

export function fontCss(spec: Pick<LineSpec, 'font' | 'weight'>, px: number): string {
  return `${spec.weight} ${Math.max(0.5, Math.round(px * 100) / 100)}px ${familyCss(spec.font)}`;
}

export type BgSpec =
  | { kind: 'radial'; c0: string; c1: string }
  | { kind: 'linear'; c0: string; c1: string }
  | { kind: 'color'; color: string }
  | { kind: 'video'; dim: number; fallback: BgSpec }
  | { kind: 'image'; mediaId: string; dim: number; fallback: BgSpec };

export type FillSpec =
  /** each line keeps its own colour, or `color` when set */
  | { kind: 'solid'; color: string | null }
  | { kind: 'gradient'; c0: string; c1: string; angle: number }
  | { kind: 'pattern'; id: FillPatternId }
  | { kind: 'image'; mediaId: string; fallback: FillSpec };

export interface PresetDef {
  id: TitlePresetId;
  name: string;
  bg: BgSpec;
  lines: Record<TextRole, LineSpec>;
  fill: FillSpec;
  fillScope: FillScope;
  divider: DividerId;
  /** colour of solid dividers */
  dividerColor: string;
  /** short accent rules that fade outwards (Modern) instead of long hairlines */
  ruleStyle: 'hair' | 'accent';
  glow: { color: string; blur: number } | null;
  streaks: boolean;
  stars: boolean;
  sparkles: boolean;
  zoom: boolean;
  shine: boolean;
  /** the title's letter spacing eases in from wider (Modern) */
  trackEase: boolean;
}

const caps = (font: FontKey, weight: number, size: number, track: number, color: string): LineSpec => ({ font, weight, size, track, upper: true, color });

const FLORAL_FOOTER = {
  credit: caps('cinzel', 400, 0.038, 0.5, '#a9a5b0'),
  small: caps('cormorant', 600, 0.026, 0.34, '#8f8b96'),
};

export const TITLE_PRESETS: PresetDef[] = [
  {
    id: 'classic',
    name: 'Classic',
    bg: { kind: 'radial', c0: '#0c0c0e', c1: '#000000' },
    lines: {
      title: caps('playfair', 700, 0.105, 0.42, '#f6f4ef'),
      subtitle: caps('cinzel', 400, 0.032, 0.4, '#e9e6df'),
      composer: caps('playfair', 700, 0.05, 0.3, '#f6f4ef'),
      credit: caps('cinzel', 400, 0.04, 0.5, '#8e8c88'),
      small: caps('cormorant', 600, 0.026, 0.34, '#7b7975'),
    },
    fill: { kind: 'solid', color: null },
    fillScope: 'main',
    divider: 'rules',
    dividerColor: 'rgba(255,255,255,0.78)',
    ruleStyle: 'hair',
    glow: null,
    streaks: false,
    stars: false,
    sparkles: false,
    zoom: false,
    shine: false,
    trackEase: false,
  },
  {
    id: 'ornate',
    name: 'Gold',
    bg: { kind: 'radial', c0: '#17130e', c1: '#030201' },
    lines: {
      title: caps('cormorant', 700, 0.115, 0.32, '#efe3c6'),
      subtitle: caps('cinzel', 400, 0.034, 0.4, '#d9ccb0'),
      composer: caps('cormorant', 700, 0.054, 0.32, '#efe3c6'),
      credit: caps('cinzel', 400, 0.036, 0.5, '#8f8574'),
      small: caps('cormorant', 600, 0.026, 0.34, '#7c7364'),
    },
    fill: { kind: 'pattern', id: 'gold' },
    fillScope: 'main',
    divider: 'scroll',
    dividerColor: '#d9b766',
    ruleStyle: 'hair',
    glow: { color: 'rgba(255,214,140,0.18)', blur: 0.01 },
    streaks: false,
    stars: false,
    sparkles: true,
    zoom: false,
    shine: true,
    trackEase: false,
  },
  {
    id: 'floral',
    name: 'Floral',
    bg: { kind: 'radial', c0: '#141118', c1: '#040305' },
    lines: {
      title: caps('playfair', 900, 0.1, 0.3, '#ffffff'),
      subtitle: caps('cinzel', 700, 0.034, 0.34, '#ffffff'),
      composer: caps('playfair', 900, 0.052, 0.28, '#ffffff'),
      ...FLORAL_FOOTER,
    },
    fill: { kind: 'pattern', id: 'bouquet' },
    fillScope: 'all',
    divider: 'vine',
    dividerColor: 'rgba(255,255,255,0.78)',
    ruleStyle: 'hair',
    glow: { color: 'rgba(236,190,255,0.22)', blur: 0.012 },
    streaks: true,
    stars: false,
    sparkles: false,
    zoom: true,
    shine: false,
    trackEase: false,
  },
  {
    id: 'script',
    name: 'Romance',
    bg: { kind: 'radial', c0: '#1b1220', c1: '#06040a' },
    lines: {
      title: { font: 'vibes', weight: 400, size: 0.16, track: 0, upper: false, color: '#ffffff', wordSpace: 0.2 },
      subtitle: caps('cinzel', 400, 0.034, 0.38, '#e6dcef'),
      composer: caps('cinzel', 700, 0.046, 0.32, '#f1e9f6'),
      ...FLORAL_FOOTER,
    },
    fill: { kind: 'pattern', id: 'bouquet' },
    fillScope: 'title',
    divider: 'vine',
    dividerColor: 'rgba(255,255,255,0.78)',
    ruleStyle: 'hair',
    glow: { color: 'rgba(236,190,255,0.22)', blur: 0.012 },
    streaks: true,
    stars: false,
    sparkles: false,
    zoom: true,
    shine: false,
    trackEase: false,
  },
  {
    id: 'modern',
    name: 'Modern',
    bg: { kind: 'linear', c0: '#14161c', c1: '#08090c' },
    lines: {
      title: caps('inter', 250, 0.09, 0.5, '#f4f5f7'),
      subtitle: caps('inter', 500, 0.028, 0.45, '#9aa0ab'),
      // colour replaced by the Studio's right-hand note colour (resolveLook)
      composer: caps('inter', 600, 0.04, 0.35, '#4f9dff'),
      credit: caps('inter', 500, 0.03, 0.5, '#7d828c'),
      small: caps('inter', 400, 0.022, 0.4, '#6b7079'),
    },
    fill: { kind: 'solid', color: null },
    fillScope: 'title',
    divider: 'rules',
    dividerColor: '#4f9dff',
    ruleStyle: 'accent',
    glow: null,
    streaks: false,
    stars: false,
    sparkles: false,
    zoom: false,
    shine: false,
    trackEase: true,
  },
  {
    id: 'gala',
    name: 'Gala',
    bg: { kind: 'radial', c0: '#0d1430', c1: '#03050d' },
    lines: {
      title: caps('cinzel', 700, 0.1, 0.3, '#efe3c6'),
      subtitle: caps('cinzel', 400, 0.032, 0.4, '#c9cde0'),
      composer: caps('cinzel', 700, 0.05, 0.3, '#efe3c6'),
      credit: caps('cinzel', 400, 0.036, 0.5, '#8a90a8'),
      small: caps('cormorant', 600, 0.026, 0.34, '#767c94'),
    },
    fill: { kind: 'pattern', id: 'gold' },
    fillScope: 'main',
    divider: 'diamond',
    dividerColor: '#d9b766',
    ruleStyle: 'hair',
    glow: { color: 'rgba(255,214,140,0.16)', blur: 0.01 },
    streaks: false,
    stars: true,
    sparkles: true,
    zoom: true,
    shine: false,
    trackEase: false,
  },
];

export function getPreset(id: string): PresetDef {
  return TITLE_PRESETS.find((p) => p.id === id) ?? TITLE_PRESETS[0];
}

/** Title and composer specs for each font choice (colour comes from the preset). */
const FONT_CHOICES: Record<TitleFontId, { title: Omit<LineSpec, 'color'>; composer: Omit<LineSpec, 'color'> | null }> = {
  playfair: { title: { font: 'playfair', weight: 700, size: 0.105, track: 0.4, upper: true }, composer: { font: 'playfair', weight: 700, size: 0.05, track: 0.3, upper: true } },
  cinzel: { title: { font: 'cinzel', weight: 700, size: 0.1, track: 0.3, upper: true }, composer: { font: 'cinzel', weight: 700, size: 0.05, track: 0.3, upper: true } },
  cormorant: { title: { font: 'cormorant', weight: 700, size: 0.115, track: 0.32, upper: true }, composer: { font: 'cormorant', weight: 700, size: 0.054, track: 0.32, upper: true } },
  garamond: { title: { font: 'garamond', weight: 500, size: 0.108, track: 0.3, upper: true }, composer: { font: 'garamond', weight: 500, size: 0.05, track: 0.3, upper: true } },
  // the script font is only used for the title; the composer keeps the style's font
  script: { title: { font: 'vibes', weight: 400, size: 0.16, track: 0, upper: false, wordSpace: 0.2 }, composer: null },
  modern: { title: { font: 'inter', weight: 250, size: 0.09, track: 0.5, upper: true }, composer: { font: 'inter', weight: 600, size: 0.04, track: 0.35, upper: true } },
};

export const FONT_LABELS: Record<TitleFontId, string> = {
  playfair: 'Playfair',
  cinzel: 'Cinzel',
  cormorant: 'Cormorant',
  garamond: 'Garamond',
  script: 'Script',
  modern: 'Modern',
};

/** Which font choice a preset's title uses (for the Font menu's "style default" label). */
export function presetFontId(p: PresetDef): TitleFontId {
  const f = p.lines.title.font;
  return f === 'vibes' ? 'script' : f === 'inter' ? 'modern' : (f as TitleFontId);
}

export interface ResolvedLook {
  preset: TitlePresetId;
  lines: Record<TextRole, LineSpec>;
  bg: BgSpec;
  fill: FillSpec;
  /** roles drawn with the letter fill (for a solid fill: in its colour, else into the mask) */
  fillRoles: TextRole[];
  /** dividers use the letter fill too */
  fillDividers: boolean;
  divider: DividerId;
  dividerColor: string;
  ruleStyle: 'hair' | 'accent';
  glow: { color: string; blur: number } | null;
  streaks: boolean;
  stars: boolean;
  sparkles: boolean;
  zoom: boolean;
  shine: boolean;
  trackEase: boolean;
  /** the user picked the text colour / the letter colour (kept on light backgrounds) */
  userText: boolean;
  userFill: boolean;
  /** the style's own background (its vignette is drawn; not over the user's colour or picture) */
  styleBg: boolean;
  /** soft edge around the filled letters / around the plain lines (light or busy backgrounds) */
  halo: Halo | null;
  textHalo: Halo | null;
  /** contrast toning of the letter fill */
  fillTone: FillTone;
  /** soft patch behind the text on a busy picture */
  scrim: Scrim | null;
}

const OLD_STYLE_DIGITS: FontKey[] = ['playfair', 'cormorant', 'garamond'];

/** Data from the Studio look that a title page can follow. */
export interface StudioLookHint {
  /** right-hand note colour, used as the Modern style's accent */
  accent?: string;
}

export function scopeRoles(scope: FillScope): TextRole[] {
  return scope === 'title' ? ['title'] : scope === 'main' ? ['title', 'composer'] : ['title', 'subtitle', 'composer'];
}

const isHex = (s: unknown): s is string => typeof s === 'string' && /^#[0-9a-f]{6}$/i.test(s);

export function resolveLook(look: TitleLook, hint: StudioLookHint = {}): ResolvedLook {
  const p = getPreset(look.preset);
  const lines = { ...p.lines } as Record<TextRole, LineSpec>;
  let dividerColor = p.dividerColor;
  if (p.id === 'modern' && isHex(hint.accent)) {
    lines.composer = { ...lines.composer, color: hint.accent };
    dividerColor = hint.accent;
  }

  if (look.font) {
    const choice = FONT_CHOICES[look.font];
    const heavy = p.lines.title.weight >= 800;
    const t = choice.title;
    lines.title = { ...t, weight: heavy && t.upper ? nearestWeight(t.font, 900) : t.weight, color: p.lines.title.color };
    if (choice.composer) {
      const c = choice.composer;
      lines.composer = { ...c, weight: heavy ? nearestWeight(c.font, 900) : c.weight, color: lines.composer.color };
    }
  }

  // solid text colour for main lines
  if (isHex(look.textColor)) {
    for (const r of ['title', 'subtitle', 'composer'] as TextRole[]) lines[r] = { ...lines[r], color: look.textColor };
  }

  for (const r of Object.keys(lines) as TextRole[]) {
    const l = lines[r];
    if (l.upper && OLD_STYLE_DIGITS.includes(l.font)) lines[r] = { ...l, digits: 'cinzel' };
  }

  // letters
  let fill: FillSpec = p.fill;
  const kind = look.fill;
  if (kind === 'solid') fill = { kind: 'solid', color: isHex(look.fillColor) ? look.fillColor : '#ffffff' };
  else if (kind === 'gradient') {
    const g = look.gradient && isHex(look.gradient[0]) && isHex(look.gradient[1]) ? look.gradient : (['#f6d8ff', '#8fb4ff'] as [string, string]);
    fill = { kind: 'gradient', c0: g[0], c1: g[1], angle: Number.isFinite(look.gradientAngle) ? (look.gradientAngle as number) : 0 };
  } else if (kind === 'pattern') fill = { kind: 'pattern', id: look.pattern ?? (p.fill.kind === 'pattern' ? p.fill.id : 'bouquet') };
  else if (kind === 'image') {
    const fallback: FillSpec = p.fill.kind === 'image' ? { kind: 'solid', color: null } : p.fill;
    fill = look.fillImageId ? { kind: 'image', mediaId: look.fillImageId, fallback } : fallback;
  } else if (look.pattern && p.fill.kind === 'pattern') fill = { kind: 'pattern', id: look.pattern };

  const scope = look.fillScope ?? p.fillScope;
  const fillRoles = scopeRoles(scope);
  // a solid fill with no colour of its own leaves every line in its preset colour
  const fillDividers = scope !== 'title';

  // background
  let bg: BgSpec = p.bg;
  const dim = typeof look.dim === 'number' ? Math.max(0, Math.min(0.8, look.dim)) : DEFAULT_DIM;
  switch (look.bg) {
    case 'color':
      bg = { kind: 'color', color: isHex(look.bgColor) ? look.bgColor : '#000000' };
      break;
    case 'gradient': {
      const g = look.bgGradient && isHex(look.bgGradient[0]) && isHex(look.bgGradient[1]) ? look.bgGradient : (['#1b1430', '#05040a'] as [string, string]);
      bg = { kind: 'linear', c0: g[0], c1: g[1] };
      break;
    }
    case 'video':
      bg = { kind: 'video', dim, fallback: p.bg };
      break;
    case 'image':
      if (look.bgImageId) bg = { kind: 'image', mediaId: look.bgImageId, dim, fallback: p.bg };
      break;
  }

  if (fill.kind === 'solid' && fill.color) {
    for (const r of fillRoles) lines[r] = { ...lines[r], color: fill.color };
    if (fillDividers) dividerColor = fill.color;
  }

  const resolved: ResolvedLook = {
    preset: p.id,
    lines,
    bg,
    fill,
    fillRoles,
    fillDividers,
    divider: look.divider ?? p.divider,
    dividerColor,
    ruleStyle: look.divider && look.divider !== p.divider ? 'hair' : p.ruleStyle,
    glow: p.glow,
    streaks: look.streaks ?? p.streaks,
    stars: p.stars,
    sparkles: look.sparkles ?? p.sparkles,
    zoom: look.zoom ?? p.zoom,
    shine: look.shine ?? p.shine,
    trackEase: p.trackEase && !look.font,
    userText: isHex(look.textColor),
    userFill: kind === 'solid' && isHex(look.fillColor),
    styleBg: !look.bg || bg === p.bg,
    halo: null,
    textHalo: null,
    fillTone: fill.kind === 'image' ? 'lift' : 'none',
    scrim: null,
  };
  // a light colour / gradient: dark text (a picture is measured when it is drawn, see draw.ts)
  if (bg.kind === 'color') return adaptLook(resolved, hexLuminance(bg.color));
  if (bg.kind === 'linear' && !resolved.styleBg) return adaptLook(resolved, (hexLuminance(bg.c0) + hexLuminance(bg.c1)) / 2);
  return resolved;
}

/** Darkening over a picture background unless the user sets it. */
export const DEFAULT_DIM = 0.5;

/** Whether a resolved fill is drawn through the mask layer (anything but a plain colour). */
export function usesMask(r: ResolvedLook): boolean {
  return r.fill.kind !== 'solid';
}
