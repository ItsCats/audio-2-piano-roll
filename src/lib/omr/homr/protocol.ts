// SPDX-License-Identifier: AGPL-3.0-or-later
// Part of the homr sheet-music reader (see README.md here); written for Piano2Vision, 2026.
/**
 * Messages between src/lib/omr/homr/index.ts (page) and worker.ts (the homr reader's worker). Pure
 * types and constants: no DOM, no onnxruntime. The shapes follow the Sheet Music Transformer reader
 * (src/lib/omr/protocol.ts on its branch) so both engines plug into the same import screen.
 */

/** One model file as shipped: consecutive pieces (each under Netlify's 10 MB per file) joined in the worker. */
export interface ModelFile {
  /** cache key (and the URL when there are no parts) */
  url: string;
  /** piece URLs, in order (absent: fetch `url` itself) */
  parts?: string[];
  /** sha256 of the joined file (absent: not checked, test harnesses only) */
  sha256?: string;
  bytes: number;
}

export interface HomrModelSpec {
  name: string;
  segnet: ModelFile;
  encoder: ModelFile;
  decoder: ModelFile;
}

/** Four page corners in image pixels (top-left, top-right, bottom-right, bottom-left), from the corner screen. */
export type Quad = [[number, number], [number, number], [number, number], [number, number]];

export interface PageInput {
  w: number;
  h: number;
  /** 1 = gray, 3 = RGB, 4 = RGBA (color helps homr find the paper in a photo) */
  channels: 1 | 3 | 4;
  /** row-major pixels (transferred) */
  data: Uint8Array;
  quad?: Quad | null;
}

/**
 * A job. The worker then asks for the pages one by one (NeedPageMessage → PageMessage), so only one
 * page's pixels are in its memory at a time.
 */
export interface RunRequest {
  type: 'run';
  jobId: number;
  pageCount: number;
  model: HomrModelSpec;
  threads: number;
  /** release the sessions after the job (phones: the page also terminates the worker) */
  release: boolean;
  /**
   * phones / small-memory devices: one window per segmentation run, and only the networks of the
   * current step in memory (segmentation, then encoder + decoder; see ort.ts stagedInfer)
   */
  lowMemory?: boolean;
  title?: string;
}

export interface PageMessage {
  type: 'page';
  jobId: number;
  index: number;
  page: PageInput;
}

export type WorkerRequest = RunRequest | PageMessage;

/** The same stage names as the Sheet Music Transformer reader. */
export type Stage = 'loading-model' | 'finding-lines' | 'reading';

export interface ProgressMessage {
  type: 'progress';
  jobId: number;
  stage: Stage;
  /** 0..1 within the stage (finding-lines / reading: within the current page) */
  progress: number;
  /** loading-model: bytes */
  loaded?: number;
  total?: number;
  /** page index (0-based) / pages */
  page?: number;
  pages?: number;
  /** reading: the staff image being read (1-based) / staff images of the page (a piano grand staff is normally one image) */
  line?: number;
  lines?: number;
}

export interface HomrPageResult {
  /** staffs found (a grand staff counts as two) */
  staves: number;
  /** systems (lines of music) */
  systems: number;
  /** the page could not be read (no staffs or notes): the message; the other pages still count */
  error?: string;
  /** why: no music found, or an image far taller than a page */
  errorKind?: PageErrorKind;
  /** the page was read turned by this many degrees (it was sideways) */
  rotated?: number;
  ms: number;
}

export type PageErrorKind = 'no-music' | 'too-tall';

export interface RunStats {
  fromCache: boolean;
  reusedSession: boolean;
  loadMs: number;
  createMs: number;
  segmentMs: number;
  encodeMs: number;
  decodeMs: number;
  steps: number;
  threads: number;
  /** the models could not be stored in the browser's Cache Storage (private mode, no space): downloaded again next time */
  notStored?: boolean;
  lowMemory?: boolean;
}

export interface ResultMessage {
  type: 'result';
  jobId: number;
  /** MusicXML of all pages (empty when no page could be read) */
  musicXml: string;
  pages: HomrPageResult[];
  stats: RunStats;
}

export interface ErrorMessage {
  type: 'error';
  jobId: number;
  message: string;
  /**
   * the message is written for the user (download failed, files corrupted); otherwise it is a raw
   * technical error (onnxruntime, WASM out of memory) that the page logs and replaces with a plain one
   * (the same contract as the Sheet Music Transformer reader)
   */
  plain?: boolean;
}

/** An error whose message is meant for the user (the worker passes it on as it is). */
export class PlainError extends Error {
  readonly plain = true;
}

/** What the user sees for any technical failure of the reader (its raw text goes to the console). */
export const READER_STOPPED_MESSAGE =
  'The sheet-music reader stopped, most likely because it ran out of memory. Close other tabs and apps, or read fewer pages, and try again.';

export interface NeedPageMessage {
  type: 'need-page';
  jobId: number;
  index: number;
}

export type WorkerResponse = ProgressMessage | ResultMessage | ErrorMessage | NeedPageMessage;

/**
 * Plain-language error for a download that failed on the network (offline, a dropped mobile
 * connection): the browsers' own texts tell a non-expert nothing.
 */
export function downloadFailedMessage(expectedBytes: number): string {
  const mb = expectedBytes > 0 ? ` (${Math.round(expectedBytes / 1e6)} MB)` : '';
  return `Could not download the sheet-music reader${mb}. Check your internet connection and try again.`;
}
