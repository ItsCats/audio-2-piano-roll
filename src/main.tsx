import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (import.meta.env.DEV) {
  // handy for debugging and used by the E2E tests
  void import('./state/playback').then((m) => Object.assign(window, { __pv: { getPlayer: m.getPlayer, peekPlayer: m.peekPlayer, audioStatus: m.useAudioStatus } }));
  void import('./state/studioStore').then((m) => Object.assign(window, { __studio: m.useStudio }));
}
if (import.meta.env.DEV) void import('./state/settingsStore').then((m) => Object.assign(window, { __settings: m.useSettings }));
