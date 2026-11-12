import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { DEFAULT_VISUAL, type VisualSettings } from '../lib/render/settings';
import { DEFAULT_AUDIO_SETTINGS, type AudioSettings } from '../lib/audio/types';
import type { Difficulty, ExtractionParams } from '../lib/music/types';
import { EXTRACTION_PRESETS } from '../lib/transcription/pipeline';
import type { ExportSettings } from '../lib/export/types';
import { DEFAULT_EXPORT } from '../lib/export/types';

export interface PracticeSettings {
  countIn: boolean;
  metronome: boolean;
  metronomeVolume: number;
  waitMode: boolean;
  timingWindowMs: number;
}

export interface SavedExportPreset {
  id: string;
  name: string;
  settings: ExportSettings;
}

interface SettingsState {
  visual: VisualSettings;
  audio: AudioSettings;
  practice: PracticeSettings;
  defaultDifficulty: Difficulty;
  detectionPreset: keyof typeof EXTRACTION_PRESETS | 'custom';
  customDetection: ExtractionParams;
  backendUrl: string;
  exportSettings: ExportSettings;
  exportPresets: SavedExportPreset[];
  reducedMotion: boolean;
  setVisual: (patch: Partial<VisualSettings>) => void;
  replaceVisual: (v: VisualSettings) => void;
  setLabels: (patch: Partial<VisualSettings['labels']>) => void;
  setBackground: (patch: Partial<VisualSettings['background']>) => void;
  setDecal: (patch: Partial<VisualSettings['decal']>) => void;
  setEffects: (patch: Partial<VisualSettings['effects']>) => void;
  setAudio: (patch: Partial<AudioSettings>) => void;
  setPractice: (patch: Partial<PracticeSettings>) => void;
  set: (patch: Partial<Omit<SettingsState, 'set'>>) => void;
  setExport: (patch: Partial<ExportSettings>) => void;
  resetVisual: () => void;
  resetAudio: () => void;
}

/**
 * Saved settings from older versions. v2 (2026-11-12): the default level became Hard (the closest to
 * the original), so a saved default that is still the old default, Medium, moves to Hard; Easy, picked
 * on purpose, is kept.
 */
export function migrateSettings(persisted: unknown, version: number): unknown {
  const p = (persisted && typeof persisted === 'object' ? { ...(persisted as Record<string, unknown>) } : {}) as Record<string, unknown>;
  if (version < 2 && (p.defaultDifficulty === 'medium' || p.defaultDifficulty === undefined)) p.defaultDifficulty = 'hard';
  return p;
}

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      visual: DEFAULT_VISUAL,
      audio: DEFAULT_AUDIO_SETTINGS,
      practice: { countIn: false, metronome: false, metronomeVolume: 0.6, waitMode: false, timingWindowMs: 150 },
      defaultDifficulty: 'hard',
      detectionPreset: 'piano',
      customDetection: EXTRACTION_PRESETS.piano,
      backendUrl: '',
      exportSettings: DEFAULT_EXPORT,
      exportPresets: [],
      reducedMotion: false,
      setVisual: (patch) => set((s) => ({ visual: { ...s.visual, ...patch } })),
      replaceVisual: (v) => set({ visual: v }),
      setLabels: (patch) => set((s) => ({ visual: { ...s.visual, labels: { ...s.visual.labels, ...patch }, labelsHiddenByTheme: false } })),
      setBackground: (patch) => set((s) => ({ visual: { ...s.visual, background: { ...s.visual.background, ...patch } } })),
      setDecal: (patch) => set((s) => ({ visual: { ...s.visual, decal: { ...s.visual.decal, ...patch } } })),
      setEffects: (patch) => set((s) => ({ visual: { ...s.visual, effects: { ...s.visual.effects, ...patch } } })),
      setAudio: (patch) => set((s) => ({ audio: { ...s.audio, ...patch } })),
      setPractice: (patch) => set((s) => ({ practice: { ...s.practice, ...patch } })),
      set: (patch) => set(patch),
      setExport: (patch) => set((s) => ({ exportSettings: { ...s.exportSettings, ...patch } })),
      resetVisual: () => set({ visual: DEFAULT_VISUAL }),
      resetAudio: () => set({ audio: DEFAULT_AUDIO_SETTINGS }),
    }),
    {
      name: 'pianovision-settings', // storage key predates the rename; keep so saved settings survive
      version: 2,
      migrate: migrateSettings,
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SettingsState>;
        return {
          ...current,
          ...p,
          visual: {
            ...current.visual,
            ...(p.visual ?? {}),
            labels: { ...current.visual.labels, ...(p.visual?.labels ?? {}) },
            background: { ...current.visual.background, ...(p.visual?.background ?? {}) },
            decal: { ...current.visual.decal, ...(p.visual?.decal ?? {}) },
            effects: { ...current.visual.effects, ...(p.visual?.effects ?? {}) },
          },
          audio: { ...current.audio, ...(p.audio ?? {}) },
          practice: { ...current.practice, ...(p.practice ?? {}) },
          exportSettings: { ...current.exportSettings, ...(p.exportSettings ?? {}) },
        };
      },
    },
  ),
);

/** Extraction parameters of a detection preset (default: the current one). */
export function detectionParams(preset: string = useSettings.getState().detectionPreset): ExtractionParams {
  const s = useSettings.getState();
  if (preset === 'custom') return s.customDetection;
  return EXTRACTION_PRESETS[preset as keyof typeof EXTRACTION_PRESETS] ?? EXTRACTION_PRESETS[s.detectionPreset === 'custom' ? 'piano' : s.detectionPreset];
}
