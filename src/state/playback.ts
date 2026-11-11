/**
 * The single live PlaybackController for the app, plus a tiny store describing whether the
 * piano samples are loaded. Created lazily (browsers require a user gesture before audio
 * can start; the AudioContext is resumed on the first play).
 */
import { create } from 'zustand';
import { PlaybackController } from '../lib/audio/player';
import { useSettings } from './settingsStore';

interface AudioStatus {
  loading: boolean;
  progress: number;
  error: string | null;
  ready: boolean;
}

export const useAudioStatus = create<AudioStatus>(() => ({ loading: false, progress: 0, error: null, ready: false }));

let player: PlaybackController | null = null;
let applying: Promise<void> | null = null;

export function getPlayer(): PlaybackController {
  if (!player) {
    player = new PlaybackController();
    void applyAudioSettings();
    useSettings.subscribe((s, prev) => {
      if (s.audio !== prev.audio) void applyAudioSettings();
    });
  }
  return player;
}

export function peekPlayer(): PlaybackController | null {
  return player;
}

async function applyAudioSettings(): Promise<void> {
  const p = player;
  if (!p) return;
  const s = useSettings.getState().audio;
  useAudioStatus.setState({ loading: true, error: null });
  const run = p
    .applyAudioSettings(s, (loaded, total) => useAudioStatus.setState({ progress: loaded / total }))
    .then(() => useAudioStatus.setState({ loading: false, ready: true, progress: 1 }))
    .catch((err: unknown) =>
      useAudioStatus.setState({ loading: false, error: err instanceof Error ? err.message : String(err) }),
    );
  applying = run;
  await run;
}

export function audioReady(): Promise<void> {
  getPlayer();
  return applying ?? Promise.resolve();
}
