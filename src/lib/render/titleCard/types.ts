/**
 * Title page / end card for exported videos: shared types and defaults.
 *
 * The look is a style preset plus optional tweaks. Every tweak is `null` when it follows the
 * preset, so picking another preset clears them and old saved settings stay valid when presets
 * change. Settings are saved in their own localStorage key (src/state/titleCardStore.ts).
 */

export type TitlePresetId = 'classic' | 'ornate' | 'floral' | 'script' | 'modern' | 'gala';
/** Font choice for the title and composer lines. */
export type TitleFontId = 'playfair' | 'cinzel' | 'cormorant' | 'garamond' | 'script' | 'modern';
export type FillKind = 'solid' | 'gradient' | 'pattern' | 'image';
export type FillPatternId = 'bouquet' | 'gold' | 'silver' | 'marble' | 'galaxy' | 'watercolor' | 'aurora' | 'sakura' | 'stained-glass';
/** Which lines the letter fill is used on: the title, title + composer (+ dividers), or all main lines (+ dividers). */
export type FillScope = 'title' | 'main' | 'all';
export type DividerId = 'none' | 'rules' | 'diamond' | 'vine' | 'scroll';
/** 'style' = the preset's own background; 'video' = the Studio background (same as the video). */
export type TitleBgKind = 'style' | 'color' | 'gradient' | 'video' | 'image';
export type TextRole = 'title' | 'subtitle' | 'composer' | 'credit' | 'small';

export const TEXT_ROLES: TextRole[] = ['title', 'subtitle', 'composer', 'credit', 'small'];

export interface TitleText {
  title: string;
  subtitle: string;
  composer: string;
  credit: string;
  small: string;
}

export const EMPTY_TEXT: TitleText = { title: '', subtitle: '', composer: '', credit: '', small: '' };

export interface TitleLook {
  preset: TitlePresetId;
  font: TitleFontId | null;
  fill: FillKind | null;
  /** letter colour when fill = 'solid' */
  fillColor: string | null;
  gradient: [string, string] | null;
  /** degrees, 0 = left → right, 90 = top → bottom */
  gradientAngle: number | null;
  pattern: FillPatternId | null;
  /** media id of the user's own image used inside the letters */
  fillImageId: string | null;
  fillScope: FillScope | null;
  divider: DividerId | null;
  bg: TitleBgKind | null;
  bgColor: string | null;
  bgGradient: [string, string] | null;
  bgImageId: string | null;
  /** darkening over an image / video background, 0..0.8 */
  dim: number | null;
  /** colour of the lines that are not pattern-filled */
  textColor: string | null;
  streaks: boolean | null;
  sparkles: boolean | null;
  zoom: boolean | null;
  shine: boolean | null;
}

export const DEFAULT_LOOK: TitleLook = {
  preset: 'floral',
  font: null,
  fill: null,
  fillColor: null,
  gradient: null,
  gradientAngle: null,
  pattern: null,
  fillImageId: null,
  fillScope: null,
  divider: null,
  bg: null,
  bgColor: null,
  bgGradient: null,
  bgImageId: null,
  dim: null,
  textColor: null,
  streaks: null,
  sparkles: null,
  zoom: null,
  shine: null,
};

export interface EndCardSettings {
  enabled: boolean;
  /** seconds */
  duration: number;
  main: string;
  /** null = same credit as the title page */
  credit: string | null;
  small: string;
}

export interface SongTitleText {
  /** only the fields the user changed for this song */
  text: Partial<TitleText>;
  /** last change (ms), for trimming old songs */
  at: number;
}

export interface TitleCardSettings {
  enabled: boolean;
  /** seconds, 2..10 in steps of 0.5 */
  duration: number;
  look: TitleLook;
  /** last credit / small line typed, used as the default for new songs */
  remembered: { credit: string; small: string };
  /** per-song text overrides by song id (at most MAX_SONGS, newest kept) */
  songs: Record<string, SongTitleText>;
  end: EndCardSettings;
}

export const DEFAULT_END_MAIN = 'Thank you for listening';

export const DEFAULT_TITLE_CARD: TitleCardSettings = {
  enabled: false,
  duration: 4,
  look: DEFAULT_LOOK,
  remembered: { credit: '', small: '' },
  songs: {},
  end: { enabled: false, duration: 4, main: DEFAULT_END_MAIN, credit: null, small: '' },
};

export const MIN_DURATION = 2;
export const MAX_DURATION = 10;
export const MAX_SONGS = 30;
/** the export crossfades from the title page into the piano roll over this many seconds */
export const CROSSFADE_SECONDS = 0.8;
