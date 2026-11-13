/** Keeps an export from waiting forever on an encoder that has stopped responding (pure, unit-tested). */

export const STALL_MESSAGE = 'Saving the video got stuck, so it was stopped. Try again, or choose WebM.';

export const abortError = () => new DOMException('Export canceled', 'AbortError');

/**
 * Waits for an encoder step, but gives up when the export is cancelled or the step takes longer
 * than `ms` (an encoder that stalls would otherwise leave the export waiting forever).
 */
export function guardStep<T>(p: Promise<T>, signal: AbortSignal | undefined, ms: number): Promise<T> {
  if (signal?.aborted) {
    p.catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      done();
      reject(abortError());
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error(STALL_MESSAGE));
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        done();
        resolve(v);
      },
      (e) => {
        done();
        reject(e);
      },
    );
  });
}

/** how long one block of audio or one video frame may take to encode before the export counts as stuck */
export const STEP_TIMEOUT_MS = 120_000;
/** how long writing the end of the file may take: a minute plus 6 s per minute of video */
export const finalizeTimeoutMs = (durationSeconds: number) => 60_000 + durationSeconds * 100;
