/**
 * The single live PlaybackController for the app, plus a tiny store describing whether the
 * piano samples are loaded. Created lazily (browsers require a user gesture before audio
 * can start; the AudioContext is resumed on the first play).
 */
import { create } from 'zustand';
import { PlaybackController } from '../lib/audio/player';
import { useSettings } from './settingsStore';
import { getPreset } from '../lib/audio/presets';
import { SampleLibrary, lightPiano } from '../lib/audio/sampleLibrary';

interface AudioStatus {
  loading: boolean;
  progress: number;
  error: string | null;
  ready: boolean;
}

export const useAudioStatus = create<AudioStatus>(() => ({ loading: false, progress: 0, error: null, ready: false }));

let player: PlaybackController | null = null;
let applying: Promise<void> | null = null;
/** bumped by releasePianoSamplesIfLight: a load chain started before stops there */
let releaseGen = 0;

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
  const libraryId = getPreset(s.presetId).library;
  const gen = releaseGen;
  const run = p
    .applyAudioSettings(s, (loaded, total) => gen === releaseGen && useAudioStatus.setState({ progress: loaded / total }))
    .then(() => {
      if (gen !== releaseGen) return;
      // playable now; the remaining velocity layers keep streaming in the background
      useAudioStatus.setState({ ready: true });
      return SampleLibrary.load(libraryId, undefined, { complete: true });
    })
    .then(() => {
      if (gen !== releaseGen) return;
      if (getPreset(useSettings.getState().audio.presetId).library === libraryId) useAudioStatus.setState({ loading: false, progress: 1 });
    })
    .catch((err: unknown) => {
      if (gen !== releaseGen) return;
      // released on purpose (leaving the Studio on a light-piano device): not an error
      if (err instanceof DOMException && err.name === 'AbortError') return;
      useAudioStatus.setState({ loading: false, error: err instanceof Error ? err.message : String(err) });
    });
  applying = run;
  await run;
}

export function audioReady(): Promise<void> {
  getPlayer();
  return applying ?? Promise.resolve();
}

/**
 * Make sure the piano samples are (being) loaded: after releasePianoSamples() the Studio calls this
 * when it opens again.
 */
export function ensurePianoSamples(): void {
  const p = getPlayer();
  if (!p.engine.loaded && !useAudioStatus.getState().loading) void applyAudioSettings();
}

/**
 * On light-piano devices (phones, small memory: sampleLibrary.ts lightPiano), free the decoded piano
 * samples when the Studio closes, so they don't sit in memory under the next import. Desktop keeps
 * them for instant playback.
 */
export function releasePianoSamplesIfLight(): boolean {
  if (!lightPiano()) return false;
  player?.pause();
  releaseGen++;
  player?.engine.unload();
  SampleLibrary.releaseAll();
  applying = null;
  useAudioStatus.setState({ loading: false, progress: 0, ready: false, error: null });
  return true;
}
