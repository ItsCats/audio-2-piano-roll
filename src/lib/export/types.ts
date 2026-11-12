export type Orientation = 'landscape' | 'portrait' | 'square';
export type Resolution = 720 | 1080 | 1440;

export interface ExportSettings {
  resolution: Resolution;
  fps: 30 | 60;
  format: 'mp4' | 'webm';
  orientation: Orientation;
  range: 'full' | 'loop' | 'custom';
  customStart: number;
  customEnd: number;
  rate: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  showKeyboard: boolean;
  /** seconds of lead-in before the first note reaches the keys */
  leadIn: number;
  quality: 'standard' | 'high';
  keyboardRange: 'match' | 'auto' | 'full';
  /** what the video's sound track holds: the app's piano, the song's original recording, or both */
  sound: ExportSound;
  /** volume of the original recording (undefined = follow the Studio's "Original" setting) */
  originalVolume?: number;
}

export type ExportSound = 'piano' | 'original' | 'both';

export const DEFAULT_EXPORT: ExportSettings = {
  resolution: 1080,
  fps: 60,
  format: 'mp4',
  orientation: 'landscape',
  range: 'full',
  customStart: 0,
  customEnd: 30,
  rate: 1,
  volume: 1,
  fadeIn: 0.5,
  fadeOut: 2,
  showKeyboard: true,
  leadIn: 2,
  quality: 'high',
  keyboardRange: 'match',
  sound: 'piano',
};

export function outputSize(s: Pick<ExportSettings, 'resolution' | 'orientation'>): { width: number; height: number } {
  const short = s.resolution;
  const long = Math.round((short * 16) / 9);
  const even = (n: number) => n - (n % 2);
  switch (s.orientation) {
    case 'landscape':
      return { width: even(long), height: even(short) };
    case 'portrait':
      return { width: even(short), height: even(long) };
    case 'square':
      return { width: even(short), height: even(short) };
  }
}

export const EXPORT_PRESETS: { id: string; name: string; description: string; patch: Partial<ExportSettings> }[] = [
  {
    id: 'youtube',
    name: 'YouTube Ready',
    description: '16:9 · 1080p · 60 FPS · MP4',
    patch: { orientation: 'landscape', resolution: 1080, fps: 60, format: 'mp4', showKeyboard: true, quality: 'high', keyboardRange: 'match' },
  },
  {
    id: 'shorts',
    name: 'Shorts / Reels / TikTok',
    description: '9:16 · 1080×1920 · 60 FPS · fitted keyboard',
    patch: { orientation: 'portrait', resolution: 1080, fps: 60, format: 'mp4', showKeyboard: true, keyboardRange: 'auto' },
  },
  {
    id: 'square',
    name: 'Instagram Square',
    description: '1:1 · 1080×1080 · 30 FPS',
    patch: { orientation: 'square', resolution: 1080, fps: 30, format: 'mp4', keyboardRange: 'auto' },
  },
  {
    id: 'quick',
    name: 'Quick Preview',
    description: '720p · 30 FPS · fast render',
    patch: { orientation: 'landscape', resolution: 720, fps: 30, quality: 'standard' },
  },
];
