/** UI-level playback options (not the clock): speed, loop, hands, metronome, practice. */
import { create } from 'zustand';
import type { Hand } from '../lib/music/types';
import type { PracticeStats } from '../lib/midiInput/practice';

interface TransportState {
  playing: boolean;
  rate: number;
  loop: { start: number; end: number } | null;
  loopEnabled: boolean;
  hands: Record<Hand, boolean>;
  practiceActive: boolean;
  practiceHands: Record<Hand, boolean>;
  stats: PracticeStats | null;
  snap: boolean;
  gridDivision: number; // per beat
  set: (p: Partial<Omit<TransportState, 'set'>>) => void;
}

export const useTransport = create<TransportState>((set) => ({
  playing: false,
  rate: 1,
  loop: null,
  loopEnabled: false,
  hands: { L: true, R: true },
  practiceActive: false,
  practiceHands: { L: true, R: true },
  stats: null,
  snap: true,
  gridDivision: 4,
  set: (p) => set(p),
}));
