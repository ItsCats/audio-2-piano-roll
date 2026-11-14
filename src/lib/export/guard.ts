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

/**
 * Waits for `p`, but rejects with an AbortError as soon as the export is cancelled, for steps that
 * can't be stopped part-way (decoding a recording, loading fonts or the piano samples, opening a
 * video). The step keeps going in the background; what it gives back after the cancel is handed
 * to `late` so it can be released (a decoder, an image), and its error is ignored.
 */
export function untilAborted<T>(p: Promise<T>, signal: AbortSignal | undefined, late?: (value: T) => void): Promise<T> {
  if (!signal) return p;
  const lost = () =>
    void p.then(
      (v) => {
        try {
          late?.(v);
        } catch {
          /* best effort */
        }
      },
      () => {},
    );
  if (signal.aborted) {
    lost();
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      lost();
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/** Whether `p` settles (resolves or rejects) within `ms`; never rejects. */
export function settleWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((r) => (timer = setTimeout(() => r(false), ms))),
  ]).finally(() => clearTimeout(timer));
}

/** one trip through the event loop, without a timer (timers are slowed down to once a second in a background tab) */
function nextTask(): Promise<void> {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(null);
  });
}

/**
 * Lets the page handle taps and repaint during a long run of frames. Drawing and encoding a frame often
 * ends without a real break for the page (the encoder answers at once), so a run of title page frames
 * could keep a tap on Cancel waiting for seconds on a phone. The returned function gives the page one
 * turn when `everyMs` have passed since the last one; it never changes what is encoded.
 */
export function pageBreather(everyMs = 40): () => Promise<void> {
  let last = performance.now();
  return async () => {
    if (performance.now() - last < everyMs) return;
    await nextTask();
    last = performance.now();
  };
}
