/**
 * The export dialog's runs (src/components/studio/ExportVideoDialog.tsx), kept free of React so it
 * can be unit-tested.
 *
 * Only the current run may update the dialog. A cancelled run is given a moment to let go of the
 * encoders (so two exports don't hold them at once), but never more than `stopWaitMs`: a step that
 * can't be stopped part-way (decoding a recording, a stalled decoder) goes on in the background and
 * can no longer touch the dialog, and Render comes back anyway.
 */
export const STOP_WAIT_MS = 2000;

interface Run {
  ac: AbortController;
  done: Promise<void>;
}

export type ExportTask = (signal: AbortSignal, current: () => boolean) => Promise<void>;

export class ExportRunner {
  private active: Run | null = null;
  private stopWait: Promise<void> | null = null;
  constructor(private readonly stopWaitMs = STOP_WAIT_MS) {}

  /** a run is going (not cancelled) */
  get running(): boolean {
    return this.active !== null;
  }

  /** a cancelled run is still being waited for (at most `stopWaitMs`) */
  get stopping(): boolean {
    return this.stopWait !== null;
  }

  /**
   * Starts a run unless one is going or still stopping (then null). `current()` is true while this
   * run is the dialog's; the task's errors are its own business (they are swallowed here).
   */
  start(task: ExportTask): Promise<void> | null {
    if (this.active || this.stopWait) return null;
    const ac = new AbortController();
    const run: Run = { ac, done: Promise.resolve() };
    this.active = run;
    const current = () => this.active === run && !ac.signal.aborted;
    run.done = (async () => {
      try {
        await task(ac.signal, current);
      } catch {
        /* the task reports its own errors */
      } finally {
        if (this.active === run) this.active = null;
      }
    })();
    return run.done;
  }

  /** Cancels the current run; resolves once it has ended, or after `stopWaitMs` at the latest. */
  stop(): Promise<void> {
    const run = this.active;
    if (!run) return this.stopWait ?? Promise.resolve();
    this.active = null;
    run.ac.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wait: Promise<void> = Promise.race([run.done, new Promise<void>((r) => (timer = setTimeout(r, this.stopWaitMs)))]).then(() => {
      clearTimeout(timer);
      if (this.stopWait === wait) this.stopWait = null;
    });
    this.stopWait = wait;
    return wait;
  }
}
