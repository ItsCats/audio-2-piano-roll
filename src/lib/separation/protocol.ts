/** Messages between src/lib/separation/index.ts and scnet.worker.ts. */

export interface SeparateRequest {
  type: 'separate';
  /** 44.1 kHz stereo (transferred) */
  left: Float32Array;
  right: Float32Array;
  modelUrl: string;
  modelSha256: string;
  /** segment hop as a fraction of the 11 s segment */
  step?: number;
  /** also return the 44.1 kHz mono stems (tests) */
  keep44?: boolean;
}

export type WorkerRequest = SeparateRequest;

export interface WorkerStats {
  fromCache: boolean;
  loadMs: number;
  createMs: number;
  separateMs: number;
  resampleMs: number;
  threads: number;
  sampleRate: number;
}

export type WorkerResponse =
  | { type: 'progress'; phase: 'download' | 'init' | 'separate'; done: number; total: number }
  | {
      type: 'result';
      /** mono 22.05 kHz */
      vocals: Float32Array;
      accomp: Float32Array;
      mix: Float32Array;
      vocals44?: Float32Array;
      accomp44?: Float32Array;
      stats: WorkerStats;
    }
  | { type: 'error'; message: string };
