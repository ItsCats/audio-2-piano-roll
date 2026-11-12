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
  /** also return the 44.1 kHz mono stems, drums included (tests) */
  keep44?: boolean;
  /**
   * Separate the drums stem too and return its onset envelope (only while the drum-hit filter,
   * music/cleanup.ts DRUM_HIT_RULE, is enabled). Otherwise drumOnsets comes back empty and the
   * stems are overlap-added at 22.05 kHz, which needs far less memory.
   */
  wantDrums?: boolean;
}

export type WorkerRequest = SeparateRequest;

export interface WorkerStats {
  fromCache: boolean;
  loadMs: number;
  createMs: number;
  separateMs: number;
  resampleMs: number;
  /** time spent on the drum onset envelope */
  drumsMs: number;
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
      /** onset strength of the drums stem, 8-bit at DRUM_ENV_FPS (dsp.drumOnsetEnvelope); empty unless wantDrums */
      drumOnsets: Uint8Array;
      vocals44?: Float32Array;
      accomp44?: Float32Array;
      drums44?: Float32Array;
      stats: WorkerStats;
    }
  | { type: 'error'; message: string };
