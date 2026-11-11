import type { LabelStyle } from '../music/theory';

export type KeyboardRange = 'full' | 'auto' | '76' | '61' | '49';
export type ColorMode = 'hand' | 'pitch' | 'single';
export type BackgroundKind = 'preset' | 'color' | 'image' | 'video';

export interface LabelSettings {
  style: LabelStyle;
  accidentals: 'sharps' | 'flats' | 'auto';
  font: string;
  size: number; // px at 1080p-equivalent height
  color: string;
  position: 'bottom' | 'center' | 'top';
  opacity: number;
  /** hide labels on notes shorter than this many px (at 1080p-equivalent) */
  minNoteHeight: number;
  showOnKeys: boolean;
  bold: boolean;
  custom: string[]; // 12 custom labels by pitch class
}

export interface BackgroundSettings {
  kind: BackgroundKind;
  presetId: string;
  color: string;
  mediaId: string | null; // IndexedDB media key for user image/video
  blur: number; // px
  brightness: number; // 0..2
  contrast: number; // 0..2
  opacity: number; // 0..1
  overlayColor: string;
  overlayOpacity: number; // 0..1
  fit: 'cover' | 'contain';
  scale: number; // 1..3
  posX: number; // 0..1
  posY: number; // 0..1
}

export type DecalSource = 'none' | 'pattern' | 'image';

/** An image or pattern painted inside every note (like a texture/decal). */
export interface DecalSettings {
  source: DecalSource;
  /** id from DECAL_PATTERNS (src/lib/render/decals.ts) when source = 'pattern' */
  patternId: string;
  /** IndexedDB media id of a user-uploaded image when source = 'image' */
  mediaId: string | null;
  /** size of the decal relative to its natural tile size (0.25..3) */
  scale: number;
  /** 0..1 — how strongly the decal shows over the note colour */
  opacity: number;
  /** 0..1 — how much the note's colour (hand / pitch / single) tints the decal */
  tint: number;
  /** 'note': each note carries its own crop of the decal and it moves with the note.
   *  'screen': the decal is fixed to the screen and notes act as windows onto it. */
  anchor: 'note' | 'screen';
}

/** Hit and ambience effects. Every effect has an on/off switch and an intensity. */
export interface EffectSettings {
  /** bright starburst flare where a note meets the keyboard */
  bursts: boolean;
  burstIntensity: number; // 0..1
  /** glittering particles that float up and drift sideways after notes play */
  dust: boolean;
  dustAmount: number; // 0..1
  /** coloured light spilling onto the keys being played */
  keyLight: boolean;
  keyLightIntensity: number; // 0..1
  /** soft white halo around every note's outline */
  outlineGlow: number; // 0..1 (0 = off)
}

export interface VisualSettings {
  rightColor: string;
  leftColor: string;
  singleColor: string;
  colorMode: ColorMode;
  gradient: boolean;
  noteOpacity: number;
  cornerRadius: number;
  glow: number; // 0..1
  shadow: boolean;
  borderWidth: number;
  borderColor: string;
  trails: boolean;
  particles: boolean;
  noteWidth: number; // fraction of key width 0.4..1
  /** seconds of music visible above the keyboard (note speed) */
  lookahead: number;
  upcomingHighlight: boolean; // brighten notes about to be played
  keyboardTheme: 'classic' | 'ivory' | 'dark' | 'custom';
  whiteKeyColor: string;
  blackKeyColor: string;
  keyBorderColor: string;
  keyHighlight: 'hand' | 'custom';
  keyHighlightColor: string;
  keyboardHeight: number; // fraction of canvas height
  showKeyboard: boolean;
  range: KeyboardRange;
  guides: 'none' | 'octaves' | 'all';
  beatLines: boolean;
  showPedal: boolean;
  hitLine: boolean;
  labels: LabelSettings;
  background: BackgroundSettings;
  decal: DecalSettings;
  effects: EffectSettings;
  /** 'flat' = clean drawn keys, 'realistic' = photo-like shading, gloss and reflections */
  keyboardStyle: 'flat' | 'realistic';
  /** 0..1 — soft halo in each note's colour while it falls (stronger near the keys) */
  fallingGlow: number;
  /** 0..1 — lifts note colours so they stand out (e.g. in compressed YouTube video) */
  noteBrightness: number;
  /** set when a theme (e.g. Blossom) hid the labels, so the next theme can bring them back */
  labelsHiddenByTheme?: boolean;
}

export const KEYBOARD_THEMES = {
  classic: { white: '#f4f4f1', black: '#141418', border: '#1d1d22' },
  ivory: { white: '#fbf6e6', black: '#221d17', border: '#3b3328' },
  dark: { white: '#2b2c33', black: '#0b0b0e', border: '#0e0e12' },
} as const;

const DEFAULT_GLOW = 0.35;
const DEFAULT_BRIGHTNESS = 0.15;

export const DEFAULT_VISUAL: VisualSettings = {
  rightColor: '#4f9dff',
  leftColor: '#f5a524',
  singleColor: '#8b7cff',
  colorMode: 'hand',
  gradient: true,
  noteOpacity: 0.95,
  cornerRadius: 5,
  glow: 0.55,
  shadow: true,
  borderWidth: 1,
  borderColor: '#ffffff',
  trails: true,
  particles: true,
  noteWidth: 0.86,
  lookahead: 3,
  upcomingHighlight: true,
  keyboardTheme: 'classic',
  whiteKeyColor: KEYBOARD_THEMES.classic.white,
  blackKeyColor: KEYBOARD_THEMES.classic.black,
  keyBorderColor: KEYBOARD_THEMES.classic.border,
  keyHighlight: 'hand',
  keyHighlightColor: '#4f9dff',
  keyboardHeight: 0.16,
  showKeyboard: true,
  range: 'full',
  guides: 'octaves',
  beatLines: false,
  showPedal: true,
  hitLine: true,
  labels: {
    style: 'letter',
    accidentals: 'auto',
    font: 'Inter Variable, Inter, system-ui, sans-serif',
    size: 15,
    color: '#ffffff',
    position: 'bottom',
    opacity: 0.9,
    minNoteHeight: 18,
    showOnKeys: true,
    bold: true,
    custom: ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'],
  },
  decal: {
    source: 'none',
    patternId: 'meadow',
    mediaId: null,
    scale: 1,
    opacity: 1,
    tint: 0.15,
    anchor: 'note',
  },
  effects: {
    bursts: false,
    burstIntensity: 0.7,
    dust: false,
    dustAmount: 0.6,
    keyLight: false,
    keyLightIntensity: 0.7,
    outlineGlow: 0,
  },
  keyboardStyle: 'flat',
  fallingGlow: DEFAULT_GLOW,
  noteBrightness: DEFAULT_BRIGHTNESS,
  background: {
    kind: 'preset',
    presetId: 'midnight',
    color: '#0b0b10',
    mediaId: null,
    blur: 0,
    brightness: 1,
    contrast: 1,
    opacity: 1,
    overlayColor: '#000000',
    overlayOpacity: 0.35,
    fit: 'cover',
    scale: 1,
    posX: 0.5,
    posY: 0.5,
  },
};

/** Visual themes: one-click looks that set several options at once. */
export type ThemePatch = Omit<Partial<VisualSettings>, 'background' | 'decal' | 'effects' | 'labels'> & {
  labels?: Partial<LabelSettings>;
  background?: Partial<BackgroundSettings>;
  decal?: Partial<DecalSettings>;
  effects?: Partial<EffectSettings>;
};

/** Note-shape defaults the classic themes restore, so switching away from e.g. Blossom doesn't leak its look. */
const CLASSIC_NOTES: ThemePatch = {
  gradient: true,
  noteOpacity: 0.95,
  cornerRadius: 5,
  borderWidth: 1,
  trails: true,
  particles: true,
  fallingGlow: DEFAULT_GLOW,
  noteBrightness: DEFAULT_BRIGHTNESS,
  // base colours; each theme overrides the ones it uses
  rightColor: '#4f9dff',
  leftColor: '#f5a524',
  singleColor: '#8b7cff',
};

export const VISUAL_THEMES: { id: string; name: string; patch: ThemePatch }[] = [
  { id: 'studio', name: 'Studio Blue', patch: { ...CLASSIC_NOTES, rightColor: '#4f9dff', leftColor: '#f5a524', colorMode: 'hand', glow: 0.55, keyboardTheme: 'classic', background: { kind: 'preset', presetId: 'midnight' } } },
  { id: 'aurora', name: 'Aurora', patch: { ...CLASSIC_NOTES, rightColor: '#34d3a6', leftColor: '#a78bfa', colorMode: 'hand', glow: 0.8, keyboardTheme: 'classic', background: { kind: 'preset', presetId: 'aurora' } } },
  { id: 'sunset', name: 'Sunset', patch: { ...CLASSIC_NOTES, rightColor: '#ff7a59', leftColor: '#ffc857', colorMode: 'hand', glow: 0.6, keyboardTheme: 'ivory', background: { kind: 'preset', presetId: 'sunset' } } },
  { id: 'rainbow', name: 'Rainbow Keys', patch: { ...CLASSIC_NOTES, colorMode: 'pitch', glow: 0.7, keyboardTheme: 'dark', background: { kind: 'preset', presetId: 'nebula' } } },
  { id: 'mono', name: 'Minimal Mono', patch: { ...CLASSIC_NOTES, colorMode: 'single', singleColor: '#e8e8ea', glow: 0, fallingGlow: 0, noteBrightness: 0, particles: false, trails: false, gradient: false, keyboardTheme: 'classic', background: { kind: 'color', color: '#0d0d10' } } },
  {
    id: 'blossom',
    name: 'Blossom',
    patch: {
      rightColor: '#f4a6c6',
      leftColor: '#b7a4ff',
      colorMode: 'hand',
      gradient: false,
      glow: 0.35,
      noteOpacity: 1,
      cornerRadius: 8,
      borderWidth: 0,
      trails: false,
      particles: false,
      guides: 'octaves',
      // the floral decal is the star: no letters on the notes or keys
      labels: { style: 'none', showOnKeys: false },
      fallingGlow: 0.7,
      noteBrightness: 0.3,
      keyboardTheme: 'classic',
      keyboardStyle: 'realistic',
      background: { kind: 'color', color: '#08080b' },
      decal: { source: 'pattern', patternId: 'meadow', scale: 1, opacity: 1, tint: 0.12, anchor: 'note' },
      effects: { bursts: true, burstIntensity: 0.8, dust: true, dustAmount: 0.65, keyLight: true, keyLightIntensity: 0.75, outlineGlow: 0.7 },
    },
  },
  { id: 'neon', name: 'Night Drive', patch: { ...CLASSIC_NOTES, rightColor: '#ff4fd8', leftColor: '#3ee6ff', colorMode: 'hand', glow: 0.9, keyboardTheme: 'dark', background: { kind: 'preset', presetId: 'grid' } } },
];

export const PITCH_COLORS = [
  '#ff5a5f', '#ff8a4c', '#ffb547', '#ffd84d', '#c6e95b', '#6fdc7c', '#3fd2b5', '#3cb8f0', '#5b8cff', '#8c6cff', '#c35cf2', '#f25cb6',
];

export function applyTheme(v: VisualSettings, themeId: string): VisualSettings {
  const theme = VISUAL_THEMES.find((t) => t.id === themeId);
  if (!theme) return v;
  const { background, decal, effects, labels, ...rest } = theme.patch;
  const next: VisualSettings = {
    ...v,
    ...rest,
    labels: labels
      ? { ...v.labels, ...labels }
      : v.labelsHiddenByTheme
        ? { ...v.labels, style: 'letter', showOnKeys: true } // undo the previous theme's hiding
        : v.labels,
    labelsHiddenByTheme: labels ? labels.style === 'none' : false,
    background: { ...v.background, ...(background ?? {}) },
    // themes without a decal/effects patch switch those features off so looks don't leak
    decal: { ...v.decal, ...(decal ?? { source: 'none' as const }) },
    effects: effects ? { ...v.effects, ...effects } : { ...DEFAULT_VISUAL.effects },
    keyboardStyle: rest.keyboardStyle ?? 'flat',
  };
  if (rest.keyboardTheme && rest.keyboardTheme !== 'custom') {
    const k = KEYBOARD_THEMES[rest.keyboardTheme];
    next.whiteKeyColor = k.white;
    next.blackKeyColor = k.black;
    next.keyBorderColor = k.border;
  }
  return next;
}
