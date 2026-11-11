/** Messages between src/lib/pitch/index.ts and crepe.worker.ts. */

export interface TrackRequest {
  type: 'track';
  /** mono audio at `sampleRate` (transferred) */
  audio: Float32Array;
  sampleRate: number;
  modelUrl: string;
  /** hop in samples at 16 kHz (160 = 10 ms) */
  hop: number;
  fmin: number;
  fmax: number;
  /** frames quieter than this (dB below the 95th-percentile frame RMS) skip the network */
  skipDb: number;
  /** frames per network call */
  batch: number;
}

export type WorkerRequest = TrackRequest;

export interface TrackStats {
  loadMs: number;
  createMs: number;
  inferMs: number;
  decodeMs: number;
  frames: number;
  /** frames that went through the network (the rest were too quiet) */
  inferred: number;
  threads: number;
}

export type WorkerResponse =
  | { type: 'progress'; phase: 'load' | 'infer'; done: number; total: number }
  | {
      type: 'result';
      /** Hz per frame, 0 where the frame skipped the network */
      f0: Float32Array;
      /** activation at the decoded bin, 0 for skipped frames */
      periodicity: Float32Array;
      /** frame RMS of the 16 kHz audio (voicing gate) */
      rms: Float32Array;
      stats: TrackStats;
    }
  | { type: 'error'; message: string };
