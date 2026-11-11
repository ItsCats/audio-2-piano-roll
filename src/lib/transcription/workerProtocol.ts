import type { NoteExtractionOptions, RawNoteEvent } from './noteExtraction';

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
