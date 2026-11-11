export type ReverbType = 'off' | 'studio' | 'room' | 'hall' | 'cathedral';

export interface AudioSettings {
  presetId: string;
  /** master volume 0..1 */
  volume: number;
  /** original-audio volume when playing back alongside the piano (0 = muted) */
  originalVolume: number;
  reverbType: ReverbType;
  reverbMix: number; // 0..1
  chorus: number; // 0..1
  brightness: number; // -1..1 tone tilt on top of the preset
  /** 0 = every note at the same loudness, 1 = full dynamics from the arrangement */
  velocitySensitivity: number;
  pedalEnabled: boolean;
  mechanicalNoise: boolean;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  presetId: 'concert-grand',
  volume: 0.85,
  originalVolume: 0,
  reverbType: 'hall',
  reverbMix: 0.22,
  chorus: 0,
  brightness: 0,
  velocitySensitivity: 0.9,
  pedalEnabled: true,
  mechanicalNoise: true,
};
