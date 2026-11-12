import type { NoteExtractionOptions, RawNoteEvent } from './noteExtraction';
import type { DeviceInfo } from './backendChoice';

export type TranscriptionStage =
  | 'validating'
  | 'decoding'
  | 'separating'
  | 'loading-model'
  | 'analyzing'
  | 'extracting'
  | 'arranging'
  | 'saving';

export type WorkerRequest =
  | {
      type: 'transcribe';
      jobId: number;
      audio: Float32Array;
      modelUrl: string;
      options: NoteExtractionOptions;
      preferredBackend?: string;
      /** the page's device facts for the backend choice (backendChoice.ts) */
      device?: DeviceInfo;
    }
  | {
      type: 'extract';
      jobId: number;
      frames: Uint8Array;
      onsets: Uint8Array;
      nFrames: number;
      options: NoteExtractionOptions;
    }
  | { type: 'cancel'; jobId: number };

export type WorkerResponse =
  | { type: 'progress'; jobId: number; stage: TranscriptionStage; progress: number; backend?: string }
  | {
      type: 'transcribed';
      jobId: number;
      notes: RawNoteEvent[];
      nFrames: number;
      frames: Uint8Array;
      onsets: Uint8Array;
      rms: Float32Array;
      backend: string;
      ms: number;
    }
  | { type: 'extracted'; jobId: number; notes: RawNoteEvent[] }
  | { type: 'error'; jobId: number; message: string };
