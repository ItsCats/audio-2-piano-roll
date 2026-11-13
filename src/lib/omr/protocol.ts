/**
 * Messages between src/lib/omr/index.ts (page) and worker.ts (sheet-music reader worker). Pure types
 * and constants: no DOM, no onnxruntime.
 */
import type { Quad } from './image';

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

export interface ModelSpec {
  /** model name, e.g. 'smt-grandstaff' */
  name: string;
  encoder: ModelFile;
  decoder: ModelFile;
  /** JSON array: token id → bekern token */
  vocab: ModelFile;
}

export interface PageInput {
  w: number;
  h: number;
  /** 8-bit gray, row-major (transferred) */
  data: Uint8Array;
  /** page corners in this image's pixels (photos, from the corner screen) */
  quad?: Quad | null;
}

export interface RunRequest {
  type: 'run';
  jobId: number;
  kind: 'pdf' | 'photo';
  pages: PageInput[];
  model: ModelSpec;
  threads: number;
  /** release the session after the job (phones: the page also terminates the worker) */
  release: boolean;
  /** look for the page outline in photos without corners */
  findPage: boolean;
}

export type WorkerRequest = RunRequest;

export type Stage = 'loading-model' | 'finding-lines' | 'reading';

export interface ProgressMessage {
  type: 'progress';
  jobId: number;
  stage: Stage;
  /** 0..1 within the stage */
  progress: number;
  /** loading-model: bytes */
  loaded?: number;
  total?: number;
  /** finding-lines: page index (0-based) / pages; reading: the page of the line being read (0-based) */
  page?: number;
  pages?: number;
  /** reading: lines done / total */
  line?: number;
  lines?: number;
  /** reading: the line being read on its page (1-based) / lines on that page */
  pageLine?: number;
  pageLines?: number;
}

export interface SystemResult {
  page: number;
  /** **kern text (bekern decoded) */
  kern: string;
  /** model steps (tokens) */
  steps: number;
  /** the model stopped on its own (false: cut at the length limit or by the bar-count guard) */
  finished: boolean;
  /** crop in the straightened page's pixels */
  box: { x0: number; y0: number; x1: number; y1: number };
  /** bar lines the image analysis saw across the system (-1: unknown) */
  barlines: number;
  ms: number;
}

export interface PageResult {
  /** staves found / systems (lines of music) read */
  staves: number;
  systems: number;
  /** straightened page size */
  w: number;
  h: number;
  quad: Quad | null;
}

export interface ResultMessage {
  type: 'result';
  jobId: number;
  systems: SystemResult[];
  pages: PageResult[];
  stats: RunStats;
}

export interface RunStats {
  fromCache: boolean;
  reusedSession: boolean;
  loadMs: number;
  createMs: number;
  prepareMs: number;
  encodeMs: number;
  decodeMs: number;
  steps: number;
  threads: number;
}

export interface ErrorMessage {
  type: 'error';
  jobId: number;
  message: string;
}

export type WorkerResponse = ProgressMessage | ResultMessage | ErrorMessage;

/** The model's maximum output length (tokens per system, from its config). */
export const MAX_STEPS = 1280;

/**
 * Plain-language error for a download that failed on the network (offline, a dropped mobile
 * connection): the browsers' own texts tell a non-expert nothing.
 */
export function downloadFailedMessage(expectedBytes: number): string {
  const mb = expectedBytes > 0 ? ` (${Math.round(expectedBytes / 1e6)} MB)` : '';
  return `Could not download the sheet-music reader${mb}. Check your internet connection and try again.`;
}
