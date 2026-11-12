/** Whether the Studio's piano roll is full screen (src/components/studio/FullscreenStage.tsx). */
import { create } from 'zustand';
import type { FullscreenMode } from '../lib/fullscreen';
export { isFullscreenKey } from '../lib/fullscreen';

interface StageControls {
  toggle(): void;
  exit(): void;
}

interface FullscreenState {
  mode: FullscreenMode;
  /** set by the mounted stage; null when no stage is on screen */
  controls: StageControls | null;
  setMode: (mode: FullscreenMode) => void;
  setControls: (controls: StageControls | null) => void;
}

export const useStageFullscreen = create<FullscreenState>((set) => ({
  mode: 'off',
  controls: null,
  setMode: (mode) => set({ mode }),
  setControls: (controls) => set({ controls }),
}));

export const isStageFullscreen = () => useStageFullscreen.getState().mode !== 'off';

/** Enter or leave full screen (the F key). Call straight from the key or click handler. */
export function toggleStageFullscreen(): void {
  useStageFullscreen.getState().controls?.toggle();
}
