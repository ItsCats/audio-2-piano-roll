import type { ReverbType } from './types';

export interface PianoPreset {
  id: string;
  name: string;
  description: string;
  library: 'salamander' | 'upright-kw';
  /** exponent applied to velocity before layer selection (>1 softer) */
  velocityCurve: number;
  /** shifts the velocity used for layer selection (-1..1 → ±40 MIDI velocity) */
  layerBias: number;
  /** velocity-tracking low-pass, for single-layer libraries or darker tones */
  velocityFilter?: { minHz: number; maxHz: number };
  eq: { lowShelfDb: number; highShelfDb: number; presenceDb: number };
  gainDb: number;
  /** damper release time constant (seconds) */
  damperTime: number;
  defaultReverb: ReverbType;
  defaultReverbMix: number;
}

export const PIANO_PRESETS: PianoPreset[] = [
  {
    id: 'concert-grand',
    name: 'Concert Grand',
    description: 'Salamander Yamaha C5, five velocity layers, natural hall.',
    library: 'salamander',
    velocityCurve: 1,
    layerBias: 0,
    eq: { lowShelfDb: 1, highShelfDb: 0, presenceDb: 0 },
    gainDb: 0,
    damperTime: 0.09,
    defaultReverb: 'hall',
    defaultReverbMix: 0.22,
  },
  {
    id: 'bright-grand',
    name: 'Bright Grand',
    description: 'Harder hammers and more presence — cuts through for pop and video.',
    library: 'salamander',
    velocityCurve: 0.85,
    layerBias: 0.25,
    eq: { lowShelfDb: -1, highShelfDb: 4, presenceDb: 2.5 },
    gainDb: -1,
    damperTime: 0.08,
    defaultReverb: 'room',
    defaultReverbMix: 0.16,
  },
  {
    id: 'upright',
    name: 'Upright Piano',
    description: 'Upright Piano KW — woody, intimate, a little honky.',
    library: 'upright-kw',
    velocityCurve: 1.1,
    layerBias: 0,
    velocityFilter: { minHz: 1400, maxHz: 14000 },
    eq: { lowShelfDb: -1.5, highShelfDb: 0, presenceDb: 1.5 },
    gainDb: 0,
    damperTime: 0.11,
    defaultReverb: 'room',
    defaultReverbMix: 0.14,
  },
  {
    id: 'soft',
    name: 'Soft Piano',
    description: 'Felted, dark and gentle — for lullabies and lo-fi.',
    library: 'salamander',
    velocityCurve: 1.35,
    layerBias: -0.35,
    velocityFilter: { minHz: 900, maxHz: 4200 },
    eq: { lowShelfDb: 2, highShelfDb: -5, presenceDb: -2 },
    gainDb: 3,
    damperTime: 0.14,
    defaultReverb: 'hall',
    defaultReverbMix: 0.3,
  },
];

export const getPreset = (id: string): PianoPreset => PIANO_PRESETS.find((p) => p.id === id) ?? PIANO_PRESETS[0];
