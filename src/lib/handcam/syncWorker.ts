/// <reference lib="webworker" />
// Runs the auto-sync math (lib/handcam/sync.ts) off the main thread: a few seconds for a long song.
import { findOffset, type SyncInput } from './sync';

self.onmessage = (e: MessageEvent<SyncInput>) => {
  try {
    (self as unknown as Worker).postMessage({ ok: true, result: findOffset(e.data) });
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
