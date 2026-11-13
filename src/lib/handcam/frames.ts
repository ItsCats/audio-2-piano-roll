/**
 * Hands video frames in step with the export timeline (mediabunny / WebCodecs).
 *
 * For each output frame the caller asks for one video time; VideoSampleSink.samplesAtTimestamps
 * decodes each packet at most once and returns the last frame starting at or before that time, which
 * is the exact frame even for variable frame rate phone videos. Times are clamped to the video, so a
 * lead-in or a video that starts late holds the first frame, and the end holds the last frame (the
 * caller fades it out). Only the decoder's small queue is in memory; every sample is closed right after
 * its pixels are uploaded.
 */
import { ALL_FORMATS, BlobSource, CanvasSink, Input, VideoSampleSink, type InputVideoTrack, type VideoSample } from 'mediabunny';
import { HEVC_MESSAGE, NO_VIDEO_MESSAGE, VIDEO_READ_MESSAGE } from './media';

/** seconds over which the picture fades out after the video ends */
export const END_FADE = 0.5;

/** Clamps a video time to the frames that exist (a hair inside the end, so the last frame is found). */
export const clampVideoTime = (t: number, first: number, end: number): number => Math.max(first, Math.min(end - 1e-4, t));

/** Opacity of the video band at video time t (1 while there are frames, then fades out over END_FADE). */
export const endFade = (t: number, end: number): number => (t <= end ? 1 : Math.max(0, 1 - (t - end) / END_FADE));

async function openTrack(blob: Blob): Promise<{ input: Input; track: InputVideoTrack; first: number; end: number }> {
  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    let track: InputVideoTrack | null;
    try {
      track = await input.getPrimaryVideoTrack();
    } catch (e) {
      throw new Error(VIDEO_READ_MESSAGE, { cause: e });
    }
    if (!track) throw new Error(NO_VIDEO_MESSAGE);
    if (!(await track.canDecode())) throw new Error(HEVC_MESSAGE);
    const [first, end] = await Promise.all([track.getFirstTimestamp(), track.computeDuration()]);
    return { input, track, first, end };
  } catch (e) {
    input.dispose();
    throw e;
  }
}

export interface FrameStream {
  /** the frame for the next requested time (null when the video has none) */
  next(): Promise<VideoSample | null>;
  /** stops decoding; resolves once the decoder has let go of the file (dispose the file after it) */
  close(): Promise<void>;
}

/** Frames for an export. */
export class HandFrames {
  private constructor(
    private input: Input,
    readonly track: InputVideoTrack,
    /** first frame's timestamp */
    readonly first: number,
    /** end of the video (s) */
    readonly end: number,
  ) {}
  static async open(blob: Blob): Promise<HandFrames> {
    const { input, track, first, end } = await openTrack(blob);
    return new HandFrames(input, track, first, end);
  }
  get rotation(): number {
    return this.track.rotation;
  }
  /** One sample per time `times` yields (driven in lockstep: call next() once per output frame). */
  stream(times: Iterable<number>): FrameStream {
    const sink = new VideoSampleSink(this.track);
    const { first, end } = this;
    const gen = sink.samplesAtTimestamps(
      (function* () {
        for (const t of times) yield clampVideoTime(t, first, end);
      })(),
    );
    let done = false;
    let closed = false;
    /** a request whose answer has not reached the caller yet (the caller gave up waiting: abort, time limit) */
    let inflight: Promise<IteratorResult<VideoSample | null> | null> | null = null;
    return {
      async next() {
        if (done) return null;
        const p = gen.next();
        // a request still running when the export stops must not end as an unhandled error
        inflight = p.catch(() => null);
        const r = await p;
        inflight = null;
        if (r.done) {
          done = true;
          return null;
        }
        return r.value;
      },
      async close() {
        if (closed) return;
        closed = done = true;
        const wait = <T,>(p: Promise<T>) => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), 2000))]);
        // let an abandoned request finish and close its frame, then end the decoder
        if (inflight) (await wait(inflight))?.value?.close();
        await wait(gen.return(undefined).catch(() => null));
      },
    };
  }
  dispose(): void {
    try {
      this.input.dispose();
    } catch {
      /* already */
    }
  }
}

/**
 * Small frames for previews and the setup screen (rotation applied: the frame as the user sees it).
 * One file stays open while it is used.
 */
export class PreviewFrames {
  private sink: CanvasSink;
  private constructor(
    private input: Input,
    readonly track: InputVideoTrack,
    readonly first: number,
    readonly end: number,
    readonly width: number,
    readonly height: number,
  ) {
    this.sink = new CanvasSink(track, { width, height, fit: 'fill', poolSize: 0 });
  }
  static async open(blob: Blob, maxW = 960): Promise<PreviewFrames> {
    const { input, track, first, end } = await openTrack(blob);
    const k = Math.min(1, maxW / Math.max(1, track.displayWidth));
    const w = Math.max(2, Math.round(track.displayWidth * k));
    const h = Math.max(2, Math.round(track.displayHeight * k));
    return new PreviewFrames(input, track, first, end, w, h);
  }
  /** the frame shown at video time t (clamped to the video) */
  async frameAt(t: number): Promise<HTMLCanvasElement | OffscreenCanvas | null> {
    const r = await this.sink.getCanvas(clampVideoTime(t, this.first, this.end));
    return r ? r.canvas : null;
  }
  /**
   * A frame with the hands removed: the per-pixel median of `n` frames spread over the video (the keys
   * are still while the hands move).
   */
  async cleanFrame(n = 9, signal?: AbortSignal): Promise<HTMLCanvasElement> {
    const w = this.width;
    const h = this.height;
    const stack: Uint8ClampedArray[] = [];
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true })!;
    for (let i = 0; i < n; i++) {
      if (signal?.aborted) throw new DOMException('Canceled', 'AbortError');
      const t = this.first + (this.end - this.first) * (0.1 + (0.8 * i) / Math.max(1, n - 1));
      const f = await this.frameAt(t);
      if (!f) continue;
      ctx.drawImage(f as CanvasImageSource, 0, 0, w, h);
      stack.push(ctx.getImageData(0, 0, w, h).data);
    }
    const out = ctx.createImageData(w, h);
    const vals = new Uint8Array(stack.length);
    for (let p = 0; p < w * h * 4; p++) {
      if ((p & 3) === 3) {
        out.data[p] = 255;
        continue;
      }
      for (let k = 0; k < stack.length; k++) vals[k] = stack[k][p];
      vals.sort();
      out.data[p] = vals[vals.length >> 1] ?? 0;
    }
    ctx.putImageData(out, 0, 0);
    return c;
  }
  dispose(): void {
    try {
      this.input.dispose();
    } catch {
      /* already */
    }
  }
}
