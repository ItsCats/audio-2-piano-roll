/**
 * Import jobs (one at a time). Lives outside React components so an import keeps running
 * while the user navigates around the app.
 */
import { create } from 'zustand';
import { transcribeAudio, type ProgressEvent, type TranscribeOptions, type TranscriptionEngine } from '../lib/transcription/pipeline';
import type { TranscriptionStage } from '../lib/transcription/workerProtocol';
import { classifyFile } from '../lib/transcription/decode';
import { parseMidi } from '../lib/music/midi';
import { buildSong, demoSong, songFromMidi, songFromScore, titleFromFileName } from '../lib/songs';
import { deletePending, newId, saveAudio, savePending, savePosteriors, saveSong, type PendingImport, type PendingSheet } from '../lib/storage/db';
import { createScreenWakeLock } from '../lib/wakeLock';
import { detectionParams, useSettings } from './settingsStore';
import { useLibrary } from './libraryStore';
import {
  configuredBackendUrl,
  createSeparationJob,
  createYouTubeJob,
  getJobAudio,
  health,
  waitForJob,
  type BackendHealth,
} from '../lib/backend/client';
// namespace import: fetchStems is read at call time, so this module still loads against an older client
import * as backendApi from '../lib/backend/client';
import { separationSupport, type SeparationSupport } from '../lib/separation';
import { pianoSpecialistSupport } from '../lib/pianoSpecialist';
import { isMemoryConstrained, pageDeviceInfo } from '../lib/transcription/backendChoice';
import type { Song, SongSource } from '../lib/music/types';
import type { ParsedScore, ScoreMeta } from '../lib/score';
import type { Gray, Quad, ReadProgress } from '../lib/omr';
import { toast } from './toastStore';
import { holdReload } from '../lib/newVersion';

export type ImportStage = TranscriptionStage | 'downloading' | 'uploading' | 'done' | 'error';

/** Where vocals/drums separation runs for an import. */
export type SeparationEngine = 'server' | 'browser';

export interface ImportJob {
  id: number;
  title: string;
  kind: SongSource['kind'];
  stage: ImportStage;
  progress: number | null;
  detail?: string;
  error?: string;
  songId?: string;
  warnings: string[];
  startedAt: number;
  finishedAt?: number;
  /** stages seen so far, in order (for the progress timeline) */
  history: ImportStage[];
  /** the stages this import is expected to go through, in order (for the progress timeline) */
  plan: ImportStage[];
  /** separation engine chosen for this import, if any */
  separation?: SeparationEngine;
  /** transcription model of this import (absent: Basic Pitch) */
  transcriber?: TranscriptionEngine;
  /** a PDF or photos read by the sheet-music reader (beta) */
  sheet?: 'pdf' | 'photo';
  /**
   * Speed measurement for the current phase (same stage and same kind of detail message): where
   * progress was when the phase started, and the time remaining extrapolated from the measured
   * rate at the last update. Only set once there is real progress to extrapolate from.
   */
  rate?: { key: string; t0: number; p0: number; etaSec?: number; at?: number };
}

/**
 * What the error card offers after a failed import, while the page stays open: the same import
 * again, and the recording itself (microphone / tab captures) so a failure never loses it.
 */
export interface FailedImport {
  jobId: number;
  /** the same import again (a failed high-accuracy piano model run follows the model selected now) */
  retry: () => Promise<string | null>;
  /** a failed high-accuracy piano model run: the same import with the normal model (and that choice selected) */
  retryFast?: () => Promise<string | null>;
  recording?: { blob: Blob; fileName: string };
}

/** One photo for the sheet-music reader: the file, its decoded image (when already loaded) and the page corners. */
export interface SheetPhoto {
  blob: Blob;
  name: string;
  /** decoded by lib/omr loadPhoto (absent: decoded again, e.g. after a crash) */
  image?: Gray;
  /** page corners in the decoded image's pixels (null: the whole photo) */
  quad: Quad | null;
}

/** What the sheet-music reader (beta) reads: chosen pages of a PDF, or photos in page order (one page each). */
export type SheetInput =
  | { kind: 'pdf'; file: Blob; fileName: string; pages: number[]; title?: string }
  | { kind: 'photo'; photos: SheetPhoto[]; fileName: string; title?: string };

/** Options shared by the audio imports (a resumed import passes the ones it was started with). */
export interface ImportRunOptions {
  /** detection preset to use (default: the current one) */
  presetId?: PresetId;
  /** reuse this interrupted-import record instead of writing a new one */
  pendingId?: string;
  /** transcription model (default: the user's high-accuracy piano model choice, see transcriberChoice) */
  transcriber?: TranscriptionEngine;
}

/** An interrupted-import record with the transcription model it was started with (absent in older records: Basic Pitch). */
export type PendingWithTranscriber = PendingImport & { transcriber?: TranscriptionEngine };

/** Detection preset ids (mirrors settings.detectionPreset). */
export type PresetId = 'piano' | 'mix' | 'sensitive' | 'custom';

export interface ImportPrefs {
  /** the user's last explicit "Separate vocals & drums" choice, per detection preset */
  separate: Partial<Record<PresetId, boolean>>;
  /** where separation would have run when that choice was made (a "yes" for the server is not a "yes" for a phone's browser) */
  engine?: Partial<Record<PresetId, SeparationEngine>>;
  /** "High-accuracy piano model" picked (used with the "Piano solo" preset only; off unless ticked) */
  pianoModel?: boolean;
}

interface ImportState {
  job: ImportJob | null;
  controller: AbortController | null;
  prefs: ImportPrefs;
  /** remember the user's separation choice for a detection preset (and where it would have run) */
  setSeparatePref: (preset: PresetId, value: boolean, engine?: SeparationEngine | null) => void;
  /** remember the high-accuracy piano model choice */
  setPianoModelPref: (value: boolean) => void;
  /** the last failed import's retry and recording (cleared by the next import, Dismiss or Cancel) */
  failed: FailedImport | null;
  /** `separate` defaults to the user's choice for the current detection preset */
  importFile: (file: File, opts?: { separate?: boolean; title?: string } & ImportRunOptions) => Promise<string | null>;
  /**
   * Sheet music as MusicXML text (the hook for PDF / photo recognition, which produces MusicXML):
   * same as importing a .musicxml file. `source` defaults to a sheet-music file named `fileName`.
   */
  importMusicXml: (xml: string, meta?: ScoreMeta & { title?: string; source?: SongSource & { kind: 'score' } }) => Promise<string | null>;
  /** Read printed piano music from a PDF or photos (beta, lib/omr) and import it like a sheet-music file. */
  importSheet: (input: SheetInput, opts?: { pendingId?: string; lowMemory?: boolean }) => Promise<string | null>;
  importAudioBlob: (
    blob: Blob,
    meta: { title: string; artist?: string; source: SongSource; separate?: boolean } & ImportRunOptions,
  ) => Promise<string | null>;
  /** run an import that a killed tab left behind (see lib/storage/db.ts PendingImport) again */
  resumePending: (rec: PendingImport) => Promise<string | null>;
  /**
   * A YouTube link fetched by the processing server. Nothing in the app calls this since the
   * YouTube tab was replaced by "Computer sound" (2026-11), and the server has YouTube off by
   * default (ENABLE_YOUTUBE=0); kept until the server's YouTube job is removed too.
   */
  importYouTubeViaServer: (
    videoUrl: string,
    videoId: string,
    separate: boolean,
    meta?: { title?: string; artist?: string; transcriber?: TranscriptionEngine },
  ) => Promise<string | null>;
  importDemo: () => Promise<string>;
  cancel: () => void;
  clear: () => void;
}

// ---------------------------------------------------------------- preferences (own key; the settings key is untouched)

const PREFS_KEY = 'piano2vision-import-prefs';

function loadPrefs(): ImportPrefs {
  try {
    return parsePrefs(localStorage.getItem(PREFS_KEY));
  } catch {
    return { separate: {} };
  }
}

/** The stored prefs (older records lack `engine` and `pianoModel`; anything unexpected is dropped). */
export function parsePrefs(raw: string | null): ImportPrefs {
  try {
    if (!raw) return { separate: {} };
    const p = JSON.parse(raw) as Partial<ImportPrefs>;
    const sep: ImportPrefs['separate'] = {};
    const engine: NonNullable<ImportPrefs['engine']> = {};
    for (const k of ['piano', 'mix', 'sensitive', 'custom'] as PresetId[]) {
      if (typeof p.separate?.[k] === 'boolean') sep[k] = p.separate[k];
      const e = p.engine?.[k];
      if (e === 'server' || e === 'browser') engine[k] = e;
    }
    return { separate: sep, engine, ...(p.pianoModel === true ? { pianoModel: true } : {}) };
  } catch {
    return { separate: {} };
  }
}

function savePrefs(p: ImportPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* private mode / storage full: the choice just isn't remembered */
  }
}

// ---------------------------------------------------------------- processing-server capabilities

/**
 * Whether a processing server can return separated stems (SCNet: vocals + drum-less accompaniment).
 * Old servers (Demucs) only return a single "piano part" file, which is not usable as stems.
 */
export function serverHasStems(h: BackendHealth | null | undefined): boolean {
  if (!h?.features.separation) return false;
  const f = h.features as BackendHealth['features'] & { stems?: boolean };
  return f.stems === true;
}

const healthCache = new Map<string, { at: number; value: Promise<BackendHealth | null> }>();

/**
 * Health of the processing server (null when unreachable). A reachable server is cached for a
 * minute; an unreachable one is not cached at all, so a server that just came up is used at once.
 */
export function serverHealth(url: string): Promise<BackendHealth | null> {
  const hit = healthCache.get(url);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const value = health(url).catch(() => {
    if (healthCache.get(url)?.value === value) healthCache.delete(url);
    return null;
  });
  healthCache.set(url, { at: Date.now(), value });
  return value;
}

/** Record a health check made elsewhere (Settings, the YouTube tab), so the import uses the same answer. */
export function rememberServerHealth(url: string, h: BackendHealth | null): void {
  if (h) healthCache.set(url, { at: Date.now(), value: Promise.resolve(h) });
  else healthCache.delete(url);
}

export interface SeparationAvailability {
  /** the checkbox can be ticked */
  available: boolean;
  /** where it would run */
  engine: SeparationEngine | null;
  /** default for the "Full song" preset: on unless this device is not recommended and there is no server */
  recommended: boolean;
  /** why it is disabled or not recommended (human readable) */
  reason?: string;
  browser: SeparationSupport;
}

export function separationAvailability(serverStems: boolean, browser: SeparationSupport = separationSupport()): SeparationAvailability {
  if (serverStems) return { available: true, engine: 'server', recommended: true, browser };
  if (!browser.ok) return { available: false, engine: null, recommended: false, reason: browser.reason, browser };
  return { available: true, engine: 'browser', recommended: browser.recommended, reason: browser.recommended ? undefined : browser.reason, browser };
}

/**
 * The separation default for a preset: the user's last choice, else on for "Full song" (when
 * recommended). A "yes" given while the server would have separated does not carry over to this
 * browser when separating here is not recommended (phones, low memory).
 */
export function separationChoice(prefs: ImportPrefs, preset: PresetId, avail: SeparationAvailability): boolean {
  if (!avail.available) return false;
  const remembered = prefs.separate[preset];
  if (remembered === true && avail.engine === 'browser' && !avail.recommended && prefs.engine?.[preset] === 'server') return false;
  if (remembered !== undefined) return remembered;
  return preset === 'mix' && avail.recommended;
}

/** Whether a failed server separation may fall back to separating in this browser: only where that is recommended. */
export function browserFallback(browser: SeparationSupport = separationSupport()): { ok: boolean; why?: string } {
  if (browser.ok && browser.recommended) return { ok: true };
  return { ok: false, why: browser.ok ? `separating in this browser is not recommended on this device: ${browser.reason ?? 'not enough memory'}` : browser.reason };
}

// ---------------------------------------------------------------- transcription model

/**
 * The transcription model for an import: the piano specialist only when the user picked
 * "High-accuracy piano model", the preset is "Piano solo" and this browser can run it; Basic Pitch
 * otherwise. Off by default everywhere (phones included: there it can still be ticked).
 */
export function transcriberChoice(prefs: ImportPrefs, preset: PresetId, available: boolean = pianoSpecialistSupport().available): TranscriptionEngine {
  return prefs.pianoModel === true && preset === 'piano' && available ? 'piano-specialist' : 'basic-pitch';
}

/**
 * The model "Try again" uses for an interrupted-import record: the one it was started with (older
 * records: Basic Pitch), except that a high-accuracy piano model run falls back to the normal
 * model when this browser can no longer run it, when its tab was seen dying of it (the crash marker),
 * and on memory-constrained devices (phones, ≤ 4 GB), where a killed tab almost always means the model
 * ran out of memory and running it again would crash the same way.
 */
export function resumeTranscriber(
  rec: Pick<PendingWithTranscriber, 'id' | 'transcriber'>,
  env: { available?: boolean; constrained?: boolean; crashed?: boolean } = {},
): TranscriptionEngine {
  if (rec.transcriber !== 'piano-specialist') return 'basic-pitch';
  const available = env.available ?? pianoSpecialistSupport().available;
  const device = env.constrained === undefined ? pageDeviceInfo() : undefined;
  const constrained = env.constrained ?? (!!device && isMemoryConstrained(device));
  const crashed = env.crashed ?? crashedSpecialistRecords.has(rec.id);
  return available && !constrained && !crashed ? 'piano-specialist' : 'basic-pitch';
}

// ---------------------------------------------------------------- crash markers (in-browser separation, piano specialist)

/**
 * Set while this browser runs one of the memory-hungry models (own keys; the settings and prefs keys
 * are untouched), together with a Web Lock held for as long as that tab lives. A marker left behind
 * without its lock means that tab died mid-run (almost always out of memory): the next load says so
 * and turns the option off. A normal unload (reload, close, navigation) removes it.
 */
const SEPARATING_KEY = 'piano2vision-separating';
const SEPARATING_LOCK = 'piano2vision-separating';
/** the piano specialist's marker: { pendingId?, at } */
export const SPECIALIST_RUNNING_KEY = 'piano2vision-piano-specialist-running';
const SPECIALIST_RUNNING_LOCK = 'piano2vision-piano-specialist-running';
/** markers this tab set and has not removed yet (the pagehide handler removes them) */
const ownedMarkers = new Set<string>();

function setCrashMarker(key: string, lock: string, payload: Record<string, unknown>): () => void {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks) return () => {};
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  void locks.request(lock, () => held).catch(() => undefined);
  try {
    localStorage.setItem(key, JSON.stringify({ ...payload, at: Date.now() }));
    ownedMarkers.add(key);
  } catch {
    /* storage blocked: no crash detection */
  }
  return () => {
    if (ownedMarkers.delete(key)) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }
    release();
  };
}

/** The payload of a marker a dead tab left behind (removed here), or null. Markers older than 6 h are dropped silently. */
async function takeCrashMarker(key: string, lock: string): Promise<Record<string, unknown> | null> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
  } catch {
    return null;
  }
  if (!raw || typeof navigator === 'undefined' || !navigator.locks) return null;
  const state = await navigator.locks.query().catch(() => null);
  // another tab is running it right now
  if (!state || state.held?.some((l) => l.name === lock)) return null;
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
  let m: Record<string, unknown>;
  try {
    m = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof m?.at !== 'number' || Date.now() - m.at > 6 * 3600_000) return null;
  return m;
}

function markSeparating(preset: PresetId): () => void {
  return setCrashMarker(SEPARATING_KEY, SEPARATING_LOCK, { preset });
}

async function checkCrashedSeparation(turnOff: (preset: PresetId) => void): Promise<void> {
  const m = await takeCrashMarker(SEPARATING_KEY, SEPARATING_LOCK);
  const preset = m?.preset as PresetId | undefined;
  if (!preset || !['piano', 'mix', 'sensitive', 'custom'].includes(preset)) return;
  turnOff(preset);
  toast.warn(
    'The last import stopped while separating vocals & drums',
    'The page most likely ran out of memory. "Separate vocals & drums" is now off for this detection preset. Close other tabs and tick it again to retry, or use a processing server with separation.',
  );
}

function markSpecialist(pendingId: string | undefined): () => void {
  return setCrashMarker(SPECIALIST_RUNNING_KEY, SPECIALIST_RUNNING_LOCK, pendingId ? { pendingId } : {});
}

/** interrupted-import records whose high-accuracy piano model run took the tab down (resumed with the normal model) */
const crashedSpecialistRecords = new Set<string>();

/**
 * A tab that died while the piano specialist ran: the normal model is selected again, the record
 * it left is resumed with it (resumeTranscriber), and a toast says why.
 */
export async function checkCrashedSpecialist(turnOff: () => void): Promise<boolean> {
  const m = await takeCrashMarker(SPECIALIST_RUNNING_KEY, SPECIALIST_RUNNING_LOCK);
  if (!m) return false;
  if (typeof m.pendingId === 'string') crashedSpecialistRecords.add(m.pendingId);
  turnOff();
  toast.warn(
    'The high-accuracy piano model stopped the page',
    'The page most likely ran out of memory while the high-accuracy piano model was running, so the normal model is selected again. Close other tabs and tick “High-accuracy piano model” again to retry it.',
  );
  return true;
}

let crashChecks: Promise<void> = Promise.resolve();
/** Resolves once this page load has looked for crash markers (the interrupted-import notice waits for it). */
export function crashChecksDone(): Promise<void> {
  return crashChecks;
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    for (const key of ownedMarkers) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    }
    ownedMarkers.clear();
  });
}

// ---------------------------------------------------------------- interrupted-import records

/**
 * Files above this size are not copied into the interrupted-import record (writing a 300 MB video
 * to IndexedDB first would slow every import down); the notice then asks to choose the file again.
 */
export const PENDING_COPY_MAX_BYTES = 200 * 1024 * 1024;
/** Web Lock held by the tab running an import: a record whose lock is held is not interrupted. */
export const PENDING_LOCK_PREFIX = 'piano2vision-import:';

/**
 * Write the record before any decoding and hold its lock for as long as this import runs. Never
 * throws and never holds the import up for long (a stuck IndexedDB must not block the import).
 * Returns the cleanup that deletes the record (after the write settled) and releases the lock.
 */
function persistPending(rec: PendingImport): () => Promise<void> {
  let release: () => void = () => {};
  try {
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (locks) {
      const held = new Promise<void>((r) => (release = r));
      void locks.request(PENDING_LOCK_PREFIX + rec.id, () => held).catch(() => undefined);
    }
  } catch {
    /* no Web Locks: the record is still written */
  }
  const written = savePending(rec).catch((err: unknown) => console.warn('[import] could not keep a copy for crash recovery', err));
  let cleaned: Promise<void> | null = null;
  const cleanup = () =>
    (cleaned ??= written
      // only this run's record: an import resumed under the same id may have rewritten it since
      .then(() => deletePending(rec.id, rec.startedAt))
      .catch((err: unknown) => console.warn('[import] could not delete the crash-recovery copy', err))
      .finally(() => release()));
  // the caller waits for the write, but at most a few seconds
  (cleanup as unknown as { written: Promise<void> }).written = Promise.race([written, new Promise<void>((r) => setTimeout(r, 3000))]);
  return cleanup;
}

// ---------------------------------------------------------------- timeline plans

const TRANSCRIBE: ImportStage[] = ['decoding', 'loading-model', 'analyzing', 'arranging', 'saving'];
/** the sheet-music reader: preparing the pages, the reader (download once), reading, then as a score */
export const SHEET_PLAN: ImportStage[] = ['validating', 'loading-model', 'analyzing', 'arranging', 'saving'];
const BROWSER_SEP: ImportStage[] = ['decoding', 'separating', 'loading-model', 'analyzing', 'arranging', 'saving'];
const SERVER_SEP: ImportStage[] = ['uploading', 'separating', 'downloading', ...TRANSCRIBE];

function planFor(kind: SongSource['kind'], sep: SeparationEngine | undefined, youtubeServer = false): ImportStage[] {
  if (kind === 'midi' || kind === 'demo' || kind === 'score') return ['validating', 'arranging', 'saving'];
  const rest = sep === 'server' ? SERVER_SEP : sep === 'browser' ? BROWSER_SEP : TRANSCRIBE;
  // unique: a YouTube import via the server downloads twice (the video's audio, then the stems)
  return [...new Set<ImportStage>(['validating', ...(youtubeServer ? (['downloading'] as ImportStage[]) : []), ...rest])];
}

/** "Separating vocals & drums: part 3 of 12" and "… part 4 of 12" are the same phase; numbers are dropped. */
/** Human-readable text for a processing-server job stage (server 2.0: queued → decoding → separating → encoding → done). */
function serverStageDetail(stage: string): string {
  switch (stage) {
    case 'queued':
      return 'Waiting for your processing server';
    case 'downloading':
      return 'Fetching audio on your processing server';
    case 'decoding':
      return 'Preparing the audio on your processing server';
    case 'separating':
      return 'Separating vocals & drums on your server';
    case 'encoding':
      return 'Saving the separated stems on your server';
    default:
      return `Processing on your server (${stage})`;
  }
}

/** File extension for a recording's MIME type ("audio/webm;codecs=opus" → "webm", "audio/mp4" → "m4a"). */
export function extFor(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('mp4') || m.includes('aac') || m.includes('m4a')) return 'm4a';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  return 'webm';
}

const phaseKey = (stage: ImportStage, detail?: string) => `${stage}|${(detail ?? '').replace(/[\d.,]+/g, '#')}`;

let seq = 1;

/** One import's handle: its updates are dropped once it was cancelled or replaced by a newer import. */
interface Ctx {
  id: number;
  /** detection preset when the import started */
  preset: PresetId;
  /** transcription model of this import */
  transcriber: TranscriptionEngine;
  /** warnings from before transcription (kept in the song's warnings) */
  early: string[];
  signal: AbortSignal;
  update: (patch: Partial<ImportJob>) => void;
  onProgress: (e: ProgressEvent) => void;
  /** deletes this import's interrupted-import record (set once it was written) */
  unpend?: () => Promise<void>;
  /** that record's id (saveSong deletes it in the transaction that saves the song) */
  pendingId?: string;
}

export const useImport = create<ImportState>((set, get) => {
  const apply = (id: number, patch: Partial<ImportJob>) => {
    const job = get().job;
    if (!job || job.id !== id) return;
    const history = patch.stage && job.history[job.history.length - 1] !== patch.stage ? [...job.history, patch.stage] : job.history;
    const next: ImportJob = { ...job, ...patch, history };
    // speed measurement: reset at every phase change, extrapolate from real progress only
    if ('progress' in patch || patch.stage || 'detail' in patch) {
      const key = phaseKey(next.stage, next.detail);
      const p = next.progress;
      const now = Date.now();
      if (p === null || p === undefined) next.rate = undefined;
      else if (!job.rate || job.rate.key !== key || p < job.rate.p0) next.rate = { key, t0: now, p0: p };
      else {
        const dp = p - job.rate.p0;
        const dt = (now - job.rate.t0) / 1000;
        const etaSec = dp >= 0.02 && dt >= 2 ? (dt / dp) * Math.max(0, 1 - p) : undefined;
        next.rate = { ...job.rate, etaSec, at: now };
      }
    }
    set({ job: next });
  };

  /** the running import's handle (to delete its record on Cancel) */
  let current: Ctx | null = null;

  const start = (
    title: string,
    kind: SongSource['kind'],
    plan: ImportStage[],
    separation?: SeparationEngine,
    preset?: PresetId,
    transcriber?: TranscriptionEngine,
  ): Ctx => {
    get().controller?.abort();
    void current?.unpend?.();
    const controller = new AbortController();
    const id = seq++;
    const presetId = preset ?? (useSettings.getState().detectionPreset as PresetId);
    // audio imports only (MIDI, sheet music and the demo have no model)
    const model = kind === 'midi' || kind === 'demo' || kind === 'score' ? 'basic-pitch' : (transcriber ?? transcriberChoice(get().prefs, presetId));
    set({
      failed: null,
      controller,
      job: {
        id,
        title,
        kind,
        stage: 'validating',
        progress: null,
        warnings: [],
        startedAt: Date.now(),
        history: ['validating'],
        plan,
        separation,
        ...(model === 'piano-specialist' ? { transcriber: model } : {}),
      },
    });
    const update = (patch: Partial<ImportJob>) => {
      if (!controller.signal.aborted) apply(id, patch);
    };
    const ctx: Ctx = {
      id,
      preset: presetId,
      transcriber: model,
      early: [],
      signal: controller.signal,
      update,
      onProgress: (e) => update({ stage: e.stage, progress: e.progress, detail: e.detail }),
    };
    current = ctx;
    return ctx;
  };

  /** The piano specialist is for solo piano: a ticked "Separate vocals & drums" is not used with it. */
  const skipSeparation = (ctx: Ctx) => {
    ctx.early.push('"Separate vocals & drums" is not used with the high-accuracy piano model.');
    ctx.update({ warnings: [...ctx.early] });
  };

  /** Keep a copy of the audio and the options until this import ends (see persistPending). */
  const pend = async (ctx: Ctx, rec: Omit<PendingImport, 'id' | 'startedAt' | 'presetId'> & { id?: string }) => {
    const id = rec.id ?? newId();
    const full: PendingWithTranscriber = { ...rec, id, startedAt: Date.now(), presetId: ctx.preset };
    // Try again after a killed tab uses the same model (older records have no field: Basic Pitch)
    if (ctx.transcriber === 'piano-specialist') full.transcriber = ctx.transcriber;
    const unpend = persistPending(full);
    ctx.unpend = unpend;
    ctx.pendingId = id;
    await (unpend as unknown as { written: Promise<void> }).written;
  };

  const finish = async ({ update, unpend, pendingId }: Ctx, song: Song) => {
    update({ stage: 'saving', progress: null, detail: 'Saving to your library' });
    // the record goes in the same transaction: a tab killed now never leaves both (see saveSong)
    await saveSong(song, pendingId ? { pendingId } : undefined);
    void unpend?.();
    void useLibrary.getState().refresh();
    update({ stage: 'done', progress: 1, songId: song.id, finishedAt: Date.now(), detail: undefined });
    return song.id;
  };

  /** A sheet-music import's Song (the file's warnings are shown on the import card too). */
  const finishScore = async (ctx: Ctx, parsed: ParsedScore, source: SongSource & { kind: 'score' }, title?: string, extra?: (song: Song) => void) => {
    if (ctx.signal.aborted) return null;
    const song = songFromScore(parsed, source);
    if (title) song.title = title;
    extra?.(song);
    const warnings = song.transcription.warnings;
    if (warnings.length) ctx.update({ warnings });
    return await finish(ctx, song);
  };

  const isQuotaError = (err: unknown) => {
    const e = err as { name?: string; message?: string } | null;
    return /quota/i.test(`${e?.name ?? ''} ${e?.message ?? ''}`);
  };

  const isAbort = (err: unknown) => (err instanceof DOMException || err instanceof Error) && err.name === 'AbortError';

  /**
   * `again` (audio imports): what the error card's "Try again" runs while the page is open. The
   * interrupted-import record is deleted either way: it is only for a tab that gets killed.
   */
  const fail = (ctx: Ctx, err: unknown, again?: Omit<FailedImport, 'jobId'>) => {
    void ctx.unpend?.();
    if (isAbort(err) || ctx.signal.aborted) {
      if (get().job?.id === ctx.id) set({ job: null, controller: null });
      return null;
    }
    const msg = err instanceof Error ? err.message : String(err);
    ctx.update({ stage: 'error', error: msg, finishedAt: Date.now() });
    if (again && get().job?.id === ctx.id) set({ failed: { jobId: ctx.id, ...again } });
    return null;
  };

  /**
   * The model "Try again" on the error card runs: the import's own, except that a failed "Solo piano –
   * high accuracy" run follows the choice shown on the page now (the user may have switched to fast).
   */
  const retryModel = (ctx: Ctx): TranscriptionEngine =>
    ctx.transcriber === 'piano-specialist' ? transcriberChoice(get().prefs, ctx.preset) : ctx.transcriber;
  /** "Try with the normal model": select it (so the page shows what runs) and run the import with it */
  const withFast = (ctx: Ctx, run: () => Promise<string | null>) =>
    ctx.transcriber === 'piano-specialist'
      ? () => {
          get().setPianoModelPref(false);
          return run();
        }
      : undefined;

  const isRecording = (kind: SongSource['kind']) => kind === 'capture' || kind === 'youtube';
  const recordingName = (title: string, mime: string) => `${title.replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Recording'}.${extFor(mime)}`;

  const backendUrl = () => configuredBackendUrl(useSettings.getState().backendUrl);

  /** Which engine to use when the user asked for separation (server with stems first, else this browser). */
  const pickEngine = async (separate: boolean): Promise<SeparationEngine | undefined> => {
    if (!separate) return undefined;
    const url = backendUrl();
    const serverStems = url ? serverHasStems(await serverHealth(url)) : false;
    const avail = separationAvailability(serverStems);
    return avail.engine ?? undefined;
  };

  const defaultSeparate = async (): Promise<boolean> => {
    const preset = useSettings.getState().detectionPreset as PresetId;
    const url = backendUrl();
    const serverStems = url ? serverHasStems(await serverHealth(url)) : false;
    return separationChoice(get().prefs, preset, separationAvailability(serverStems));
  };

  /** Separate on the processing server and download both stems. */
  const serverStems = async ({ update, signal }: Ctx, blob: Blob, name: string) => {
    const url = backendUrl();
    if (!url) throw new Error('No processing server is configured.');
    update({ stage: 'uploading', progress: null, detail: 'Uploading to your processing server' });
    const job = await createSeparationJob(url, blob, name);
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    const done = await waitForJob(
      url,
      job.id,
      (j) =>
        update({
          stage: 'separating',
          progress: j.progress,
          detail: serverStageDetail(j.stage),
        }),
      signal,
    );
    update({ stage: 'downloading', progress: null, detail: 'Downloading the separated vocals and accompaniment' });
    const stems = await backendApi.fetchStems(url, job.id, signal);
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    return { ...stems, serverMs: done.separationMs ?? undefined };
  };

  /**
   * Transcribe (optionally separating first) and save. `engine` decides where separation runs;
   * a failing server falls back to separating in this browser, so the user still gets what they ticked.
   */
  const transcribeAndSave = async (
    ctx: Ctx,
    original: Blob,
    meta: { title: string; artist?: string; source: SongSource; fileName: string },
    engine: SeparationEngine | undefined,
    /** stems the server already produced (a separated YouTube job): used as they are */
    prefetched?: { vocals: Blob; accomp: Blob; serverMs?: number },
    /** warnings from earlier steps of this import */
    earlier: string[] = [],
  ) => {
    const { update, onProgress, signal } = ctx;
    const params = detectionParams(ctx.preset);
    const extraWarnings: string[] = [...ctx.early, ...earlier];
    let opts: TranscribeOptions = {};
    let progress = onProgress;
    if (engine === 'server') {
      try {
        opts = { stems: prefetched ?? (await serverStems(ctx, original, meta.fileName)) };
        // the pipeline's "separating" step for ready-made stems is only decoding them
        progress = (e) => onProgress(e.stage === 'separating' ? { ...e, stage: 'decoding', progress: null } : e);
      } catch (err) {
        if (isAbort(err) || signal.aborted) throw err;
        // fall back to this browser only where that is recommended (not on phones / low memory)
        const fb = browserFallback();
        const why = (err as Error)?.message ?? String(err);
        if (fb.ok) {
          extraWarnings.push(`The processing server could not separate this song (${why}); it was separated in the browser instead.`);
          opts = { separate: true };
          const job = get().job;
          if (job) update({ plan: planFor(job.kind, 'browser', job.plan[1] === 'downloading'), separation: 'browser' });
        } else {
          extraWarnings.push(`The processing server could not separate this song (${why}); the full mix was transcribed${fb.why ? ` (${fb.why})` : ''}.`);
          const job = get().job;
          if (job) update({ plan: planFor(job.kind, undefined, job.plan[1] === 'downloading'), separation: undefined });
        }
        update({ warnings: [...(get().job?.warnings ?? []), ...extraWarnings] });
      }
    } else if (engine === 'browser') {
      opts = { separate: true };
    }
    if (ctx.transcriber === 'piano-specialist') opts = { ...opts, engine: 'piano-specialist' };
    // in-browser separation and the piano specialist: leave a marker in case the tab dies of it (setCrashMarker)
    const unmark =
      opts.engine === 'piano-specialist' ? markSpecialist(ctx.pendingId) : opts.separate ? markSeparating(ctx.preset) : () => {};
    let result: Awaited<ReturnType<typeof transcribeAudio>>;
    try {
      result = await transcribeAudio(original, params, progress, signal, opts);
    } finally {
      unmark();
    }
    if (result.separationFailure === 'memory' && opts.separate) {
      // the next import of this preset would fail the same way
      get().setSeparatePref(ctx.preset, false, 'browser');
      result.info.warnings.push('"Separate vocals & drums" is now off for this detection preset; tick it again to retry.');
    }
    result.info.warnings = [...extraWarnings, ...result.info.warnings];
    const song = buildSong({
      title: meta.title,
      artist: meta.artist,
      source: meta.source,
      notes: result.notes,
      pedal: [],
      tempo: result.tempo,
      duration: result.duration,
      key: result.key,
      transcription: result.info,
      hasAudio: true,
      hasPosteriors: true,
      // Medium and Hard: sustain pedal derived from the notes (switch in the Sound panel)
      autoPedal: true,
    });
    update({ warnings: result.info.warnings, stage: 'saving', progress: null, detail: 'Saving to your library' });
    // the piano specialist's outputs are not stored: re-detection works on Basic Pitch posteriors only
    song.hasPosteriors = !!result.posteriors;
    const posteriors = result.posteriors;
    const storeOriginal = async () => {
      await saveAudio(song.id, original, meta.source.fileName ?? meta.title);
      // (separated songs: includes the drums stem's onset envelope)
      if (posteriors) await savePosteriors(song.id, posteriors);
    };
    try {
      try {
        await storeOriginal();
      } catch (err) {
        // the crash-recovery copy of the same audio may be what filled the storage: drop it, try once more
        if (!ctx.unpend || !isQuotaError(err)) throw err;
        await ctx.unpend();
        await storeOriginal();
      }
    } catch (err) {
      song.hasAudio = false;
      song.hasPosteriors = false;
      toast.warn('Original audio not stored', `Browser storage is full or unavailable (${(err as Error).message}). The arrangement is still saved.`);
    }
    return finish(ctx, song);
  };

  return {
    job: null,
    controller: null,
    failed: null,
    prefs: loadPrefs(),

    setPianoModelPref: (value) => {
      const { pianoModel: _old, ...rest } = get().prefs;
      const prefs: ImportPrefs = value ? { ...rest, pianoModel: true } : rest;
      set({ prefs });
      savePrefs(prefs);
    },

    setSeparatePref: (preset, value, engine) => {
      const cur = get().prefs;
      const eng = { ...cur.engine };
      if (engine) eng[preset] = engine;
      else delete eng[preset];
      const prefs = { ...cur, separate: { ...cur.separate, [preset]: value }, engine: eng };
      set({ prefs });
      savePrefs(prefs);
    },

    importFile: async (file, opts = {}) => {
      const kind = classifyFile(file);
      const title = opts.title ?? titleFromFileName(file.name);
      if (kind === 'score') {
        const ctx = start(title, 'score', planFor('score', undefined));
        try {
          ctx.update({ stage: 'arranging', detail: 'Reading sheet music' });
          const { readScoreFile, MAX_SCORE_BYTES } = await import('../lib/score');
          if (file.size > MAX_SCORE_BYTES) throw new Error('This sheet-music file is too large (max 30 MB).');
          const parsed = readScoreFile(file.name, new Uint8Array(await file.arrayBuffer()));
          return await finishScore(ctx, parsed, { kind: 'score', fileName: file.name, fileSize: file.size, ...(file.type ? { mimeType: file.type } : {}) }, opts.title);
        } catch (err) {
          return fail(ctx, err);
        }
      }
      if (kind === 'midi' || kind === 'unsupported') {
        const ctx = start(title, kind === 'midi' ? 'midi' : 'audio', planFor('midi', undefined));
        const { update } = ctx;
        try {
          if (kind === 'unsupported') {
            const sheet = /\.(pdf|jpe?g|png|heic|heif|webp)$/i.test(file.name) || /^image\/|pdf/.test(file.type);
            throw new Error(
              sheet
                ? `To read a PDF or photo of sheet music, use the “MIDI / Sheet music” tab.`
                : `"${file.name}" is not a supported audio, video, MIDI or sheet-music file.`,
            );
          }
          update({ kind: 'midi', stage: 'arranging', detail: 'Reading MIDI file' });
          if (file.size > 20 * 1024 * 1024) throw new Error('MIDI file is unusually large (max 20 MB).');
          const parsed = parseMidi(await file.arrayBuffer());
          const song = songFromMidi(parsed, file.name, file.size);
          if (opts.title) song.title = opts.title;
          return await finish(ctx, song);
        } catch (err) {
          return fail(ctx, err);
        }
      }
      // start the job right away (the page shows it), then decide where separation runs
      const ctx = start(title, 'audio', planFor('audio', undefined), undefined, opts.presetId, opts.transcriber);
      let separate = opts.separate;
      try {
        separate ??= await defaultSeparate();
        // the piano specialist is for solo piano: no separation (the pipeline would ignore it)
        if (ctx.transcriber === 'piano-specialist' && separate) {
          skipSeparation(ctx);
          separate = false;
        }
        const source: SongSource = { kind: 'audio', fileName: file.name, mimeType: file.type, fileSize: file.size };
        await pend(ctx, {
          id: opts.pendingId,
          title,
          kind: 'audio',
          source,
          blob: file.size <= PENDING_COPY_MAX_BYTES ? file : undefined,
          mimeType: file.type,
          fileName: file.name,
          separate,
        });
        const engine = await pickEngine(separate);
        if (ctx.signal.aborted) return null;
        ctx.update({ plan: planFor('audio', engine), separation: engine });
        return await transcribeAndSave(ctx, file, { title, source, fileName: file.name }, engine);
      } catch (err) {
        const again = (transcriber: TranscriptionEngine) => () =>
          get().importFile(file, { ...opts, separate, presetId: ctx.preset, transcriber, pendingId: undefined });
        return fail(ctx, err, { retry: () => again(retryModel(ctx))(), retryFast: withFast(ctx, again('basic-pitch')) });
      }
    },

    importMusicXml: async (xml, meta = {}) => {
      const title = meta.title ?? (meta.fileName ? titleFromFileName(meta.fileName) : 'Sheet music');
      const ctx = start(title, 'score', planFor('score', undefined));
      try {
        ctx.update({ stage: 'arranging', detail: 'Reading sheet music' });
        const { importMusicXml } = await import('../lib/score');
        const parsed = importMusicXml(xml, meta);
        return await finishScore(ctx, parsed, meta.source ?? { kind: 'score', ...(meta.fileName ? { fileName: meta.fileName } : {}) }, meta.title);
      } catch (err) {
        return fail(ctx, err);
      }
    },

    importSheet: async (input, opts = {}) => {
      const fileName = input.fileName;
      const title = input.title ?? sheetTitle(fileName);
      const ctx = start(title, 'score', SHEET_PLAN);
      ctx.update({ sheet: input.kind, detail: input.kind === 'pdf' ? 'Opening the PDF' : 'Opening the photos' });
      const { update, signal } = ctx;
      const nPages = input.kind === 'pdf' ? input.pages.length : input.photos.length;
      try {
        // keep the PDF / photos until this import ends, so "Try again" works after a crash (persistPending)
        const sheet: PendingSheet = {
          ...(input.kind === 'pdf'
            ? { kind: 'pdf' as const, pages: [...input.pages] }
            : { kind: 'photo' as const, photos: input.photos.map((p) => ({ blob: p.blob, name: p.name, quad: p.quad ? p.quad.map((q) => [q[0], q[1]] as [number, number]) : null })) }),
          ...(opts.lowMemory ? { lowMemory: true } : {}),
        };
        const first = input.kind === 'pdf' ? input.file : input.photos[0]?.blob;
        const size = input.kind === 'pdf' ? input.file.size : input.photos.reduce((a, p) => a + p.blob.size, 0);
        const source: SongSource & { kind: 'score' } = { kind: 'score', reader: input.kind, fileName, pages: nPages, ...(first?.type ? { mimeType: first.type } : {}), fileSize: size };
        await pend(ctx, {
          id: opts.pendingId,
          title,
          kind: 'score',
          source,
          blob: size <= PENDING_COPY_MAX_BYTES ? first : undefined,
          mimeType: first?.type ?? '',
          fileName,
          separate: false,
          ...(size <= PENDING_COPY_MAX_BYTES ? { sheet } : {}),
        });
        const omr = await import('../lib/omr');
        if (signal.aborted) return null;
        // 1. the page images
        let pages: { image: Gray; quad?: Quad | null }[];
        if (input.kind === 'pdf') {
          update({ stage: 'validating', progress: 0, detail: nPages > 1 ? `Preparing page 1 of ${nPages}` : 'Preparing the page' });
          const images = await omr.renderPdfPages(new Uint8Array(await input.file.arrayBuffer()), {
            pages: input.pages,
            signal,
            onPage: (done, total) => update({ progress: done / total, detail: done < total ? `Preparing page ${done + 1} of ${total}` : 'Preparing the pages' }),
          });
          pages = images.map((image) => ({ image }));
        } else {
          pages = [];
          for (let i = 0; i < input.photos.length; i++) {
            if (signal.aborted) return null;
            const p = input.photos[i];
            update({ stage: 'validating', progress: i / nPages, detail: nPages > 1 ? `Preparing photo ${i + 1} of ${nPages}` : 'Preparing the photo' });
            const image = p.image ?? (await omr.loadPhoto(p.blob)).image;
            pages.push({ image, quad: p.quad });
          }
        }
        if (signal.aborted) return null;
        // 2. read them
        const mb = omr.sheetReaderSupport(input.kind).downloadMB;
        let last = '';
        const onProgress = (p: ReadProgress) => {
          if (p.stage === 'loading-model') {
            const downloading = !!p.total && (p.loaded ?? 0) < p.total;
            update({
              stage: 'loading-model',
              progress: p.total ? Math.min(1, (p.loaded ?? 0) / p.total) : null,
              detail: downloading ? `Downloading the sheet-music reader (once, ${mb} MB)` : 'Starting the sheet-music reader',
            });
          } else if (p.stage === 'finding-lines') {
            update({ stage: 'analyzing', progress: 0, detail: 'Finding the lines of music' });
          } else {
            if (p.page !== undefined && p.pageLine !== undefined) {
              const pg = (p.pages ?? 1) > 1 ? `Reading page ${p.page + 1} of ${p.pages}, ` : 'Reading ';
              last = `${pg}line ${p.pageLine} of ${p.pageLines}`;
            }
            update({ stage: 'analyzing', progress: Math.max(0, Math.min(1, (p.progress - 0.2) / 0.8)), detail: last || 'Reading the music' });
          }
        };
        // after a crash: one WASM thread (about half the memory) and the model freed right after
        const result = await omr.readSheetImages(pages, { kind: input.kind, signal, title, onProgress, ...(opts.lowMemory ? { threads: 1, release: true } : {}) });
        pages.length = 0;
        if (signal.aborted) return null;
        // 3. the MusicXML goes through the normal score import
        update({ stage: 'arranging', progress: null, detail: 'Building arrangements' });
        const { importMusicXml } = await import('../lib/score');
        const parsed = importMusicXml(result.musicXml, { fileName });
        return await finishScore(ctx, parsed, source, input.title ?? title, (song) => {
          // the reader's notes are an estimate: its own notes first, then the score import's (reworded)
          song.transcription.warnings = [...result.warnings, ...readScoreWarnings(song.transcription.warnings)];
          song.transcription.processingMs = Math.round(result.stats.ms);
        });
      } catch (err) {
        return fail(ctx, err, { retry: () => get().importSheet(input, { lowMemory: opts.lowMemory }) });
      }
    },

    importAudioBlob: async (blob, meta) => {
      const ctx = start(meta.title, meta.source.kind, planFor(meta.source.kind, undefined), undefined, meta.presetId, meta.transcriber);
      const fileName = recordingName(meta.title, blob.type);
      let separate = !!meta.separate;
      try {
        if (ctx.transcriber === 'piano-specialist' && separate) {
          skipSeparation(ctx);
          separate = false;
        }
        await pend(ctx, {
          id: meta.pendingId,
          title: meta.title,
          artist: meta.artist,
          kind: meta.source.kind,
          source: meta.source,
          blob,
          mimeType: blob.type,
          fileName,
          separate,
        });
        const engine = await pickEngine(separate);
        if (ctx.signal.aborted) return null;
        ctx.update({ plan: planFor(meta.source.kind, engine), separation: engine });
        return await transcribeAndSave(ctx, blob, { ...meta, fileName }, engine);
      } catch (err) {
        const again = (transcriber: TranscriptionEngine) => () =>
          get().importAudioBlob(blob, { ...meta, presetId: ctx.preset, transcriber, pendingId: undefined });
        return fail(ctx, err, {
          retry: () => again(retryModel(ctx))(),
          retryFast: withFast(ctx, again('basic-pitch')),
          recording: isRecording(meta.source.kind) ? { blob, fileName } : undefined,
        });
      }
    },

    resumePending: async (rec) => {
      if (!rec.blob) return null;
      if (rec.kind === 'score') {
        const sheet = rec.sheet;
        if (!sheet) return null;
        const fileName = rec.fileName || rec.source.fileName || 'Sheet music';
        // the tab most likely ran out of memory: read again in the low-memory mode (interruptedNotice
        // says so; a second crash in that mode is not offered again)
        const again = { pendingId: rec.id, lowMemory: true };
        if (sheet.kind === 'pdf') return get().importSheet({ kind: 'pdf', file: rec.blob, fileName, pages: sheet.pages, title: rec.title }, again);
        const photos: SheetPhoto[] = sheet.photos.map((p) => ({ blob: p.blob, name: p.name, quad: p.quad && p.quad.length === 4 ? (p.quad as Quad) : null }));
        return get().importSheet({ kind: 'photo', photos, fileName, title: rec.title }, again);
      }
      const presetId = (['piano', 'mix', 'sensitive', 'custom'] as PresetId[]).includes(rec.presetId as PresetId) ? (rec.presetId as PresetId) : undefined;
      // a separation that crashed the tab has already been switched off for this preset (checkCrashedSeparation)
      const separate = rec.separate && (presetId ? get().prefs.separate[presetId] !== false : true);
      // the model it was started with (older records: Basic Pitch), unless that model took the tab down
      await crashChecks;
      const transcriber = resumeTranscriber(rec as PendingWithTranscriber);
      if (rec.kind === 'audio') {
        const file = new File([rec.blob], rec.fileName, { type: rec.mimeType || rec.blob.type });
        return get().importFile(file, { title: rec.title, separate, presetId, transcriber, pendingId: rec.id });
      }
      return get().importAudioBlob(rec.blob, { title: rec.title, artist: rec.artist, source: rec.source, separate, presetId, transcriber, pendingId: rec.id });
    },

    importYouTubeViaServer: async (videoUrl, videoId, separate, meta) => {
      const ctx = start(meta?.title ?? 'YouTube video', 'youtube', planFor('youtube', undefined, true), undefined, undefined, meta?.transcriber);
      const { update, signal } = ctx;
      try {
        const backend = backendUrl();
        if (!backend) throw new Error('No processing server is configured (Settings → Processing server).');
        if (ctx.transcriber === 'piano-specialist' && separate) {
          skipSeparation(ctx);
          separate = false;
        }
        const engine = await pickEngine(separate);
        if (signal.aborted) return null;
        const meta0 = { title: meta?.title ?? 'YouTube video', artist: meta?.artist };
        const sourceOf = (blob: Blob): SongSource => ({ kind: 'youtube', youtubeId: videoId, url: videoUrl, mimeType: blob.type, fileSize: blob.size });
        const earlier: string[] = [];
        let fallBackToBrowser = false;

        // the original mix of a separated job, when the server got that far (reused by the fallback)
        let mixFromServer: { blob: Blob; title: string; artist?: string } | null = null;
        if (engine === 'server') {
          // one server job fetches the video's audio and separates it: the original mix (for playback
          // in the Studio) and both stems come back from the same job, nothing is uploaded again
          update({ plan: [...new Set<ImportStage>(['validating', 'downloading', 'separating', ...TRANSCRIBE])], separation: 'server' });
          // only the server's part is inside this try: transcription and saving errors are not
          // separation failures and must not start the fallback
          let served: { mix: Blob; stems: { vocals: Blob; accomp: Blob; serverMs?: number }; title: string; artist?: string } | null = null;
          let why = '';
          try {
            update({ stage: 'downloading', progress: null, detail: 'Fetching audio on your processing server' });
            const job = await createYouTubeJob(backend, videoUrl, true);
            const done = await waitForJob(
              backend,
              job.id,
              (j) =>
                update({
                  stage: j.stage === 'downloading' || j.stage === 'queued' ? 'downloading' : 'separating',
                  progress: j.progress,
                  detail: serverStageDetail(j.stage),
                  title: j.title ?? meta0.title,
                }),
              signal,
            );
            const title = done.title ?? meta0.title;
            const artist = done.artist ?? meta0.artist;
            update({ stage: 'downloading', progress: null, detail: 'Transferring the audio and the separated stems to the browser' });
            const mix = await getJobAudio(backend, job.id, 'mix', signal);
            mixFromServer = { blob: mix, title, artist };
            const hasStems = !!done.stems?.includes('vocals') && done.stems.includes('accomp');
            if (!hasStems) {
              why = done.separationError || 'it returned no separated stems';
            } else {
              const stems = await backendApi.fetchStems(backend, job.id, signal);
              served = { mix, stems: { ...stems, serverMs: done.separationMs ?? undefined }, title, artist };
            }
          } catch (err) {
            if (isAbort(err) || signal.aborted) throw err;
            why = (err as Error)?.message ?? String(err);
          }
          if (signal.aborted) return null;
          if (served) {
            return await transcribeAndSave(ctx, served.mix, { title: served.title, artist: served.artist, source: sourceOf(served.mix), fileName: `${served.title}.m4a` }, 'server', served.stems);
          }
          // e.g. the server could fetch but not separate: separate here (where recommended) or transcribe the full mix
          const fb = browserFallback();
          fallBackToBrowser = fb.ok;
          earlier.push(
            fb.ok
              ? `The processing server could not separate this video (${why}); it was separated in the browser instead.`
              : `The processing server could not separate this video (${why}); the full mix was transcribed${fb.why ? ` (${fb.why})` : ''}.`,
          );
          update({ warnings: [...earlier] });
        }

        const engine2: SeparationEngine | undefined = engine === 'server' ? (fallBackToBrowser ? 'browser' : undefined) : engine;
        update({ plan: planFor('youtube', engine2, true), separation: engine2 });
        if (mixFromServer) {
          // the separated job already fetched the video: no second download on the server
          const { blob, title, artist } = mixFromServer;
          return await transcribeAndSave(ctx, blob, { title, artist, source: sourceOf(blob), fileName: `${title}.m4a` }, engine2, undefined, earlier);
        }
        update({ stage: 'downloading', progress: null, detail: 'Fetching audio on your processing server' });
        // fetch the original mix: it is what plays back in the Studio; separation follows as for files
        const job = await createYouTubeJob(backend, videoUrl, false);
        const done = await waitForJob(
          backend,
          job.id,
          (j) =>
            update({
              stage: 'downloading',
              progress: j.progress,
              detail: j.stage === 'downloading' ? 'Fetching audio on your processing server' : `Preparing audio on your processing server (${j.stage})`,
              title: j.title ?? meta0.title,
            }),
          signal,
        );
        update({ stage: 'downloading', progress: null, detail: 'Transferring audio to the browser' });
        const blob = await getJobAudio(backend, job.id, undefined, signal);
        const title = done.title ?? meta0.title;
        return await transcribeAndSave(
          ctx,
          blob,
          { title, artist: done.artist ?? meta0.artist, source: sourceOf(blob), fileName: `${title}.m4a` },
          engine2,
          undefined,
          earlier,
        );
      } catch (err) {
        return fail(ctx, err);
      }
    },

    importDemo: async () => {
      const ctx = start('Bach — Prelude in C major', 'demo', planFor('demo', undefined));
      const song = demoSong();
      return (await finish(ctx, song))!;
    },

    cancel: () => {
      get().controller?.abort();
      void current?.unpend?.();
      set({ job: null, controller: null, failed: null });
    },
    clear: () => {
      const j = get().job;
      if (j && (j.stage === 'done' || j.stage === 'error')) set({ job: null, controller: null, failed: null });
    },
  };
});

/** an import is running (not finished, failed or cancelled) */
export function importBusy(job: ImportJob | null): boolean {
  return !!job && job.stage !== 'done' && job.stage !== 'error';
}

if (typeof window !== 'undefined') {
  // A page load ends the document and the import with it. Router navigations keep the document
  // (App.tsx IsolationGate), but Back/Forward into a history entry of another document (the YouTube
  // route is its own document), a reload or closing the tab do not: ask first while an import runs.
  const onBeforeUnload = (e: BeforeUnloadEvent) => {
    e.preventDefault();
    e.returnValue = '';
  };
  let guarded = false;
  useImport.subscribe((st) => {
    const busy = importBusy(st.job);
    if (busy === guarded) return;
    guarded = busy;
    if (busy) window.addEventListener('beforeunload', onBeforeUnload);
    else window.removeEventListener('beforeunload', onBeforeUnload);
  });
  // a new version going online must not reload the page under a running import, or throw away a
  // recording that only lives in memory now (the error card's "Download recording")
  holdReload(() => {
    const st = useImport.getState();
    if (importBusy(st.job)) return 'Reload when the import has finished.';
    if (st.failed?.recording) return 'Download your recording first, then reload.';
    return null;
  });
  // keep the screen on while an import runs (a locked phone suspends the page)
  const wake = createScreenWakeLock();
  useImport.subscribe((st) => void wake.hold(importBusy(st.job)));
  crashChecks = new Promise<void>((resolve) =>
    setTimeout(() => {
      void Promise.all([
        checkCrashedSeparation((preset) => useImport.getState().setSeparatePref(preset, false, 'browser')),
        checkCrashedSpecialist(() => useImport.getState().setPianoModelPref(false)),
      ])
        .catch(() => undefined)
        .then(() => resolve());
    }, 0),
  );
}

/**
 * A song title from a sheet-music file name: "demo-prelude.pdf" → "Demo prelude" (file names often
 * use hyphens for spaces); names that already have spaces keep their hyphens ("Op. 28 - No. 4").
 */
export function sheetTitle(fileName: string): string {
  let t = titleFromFileName(fileName);
  if (!/\s/.test(t)) t = t.replace(/-+/g, ' ').trim() || t;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * The score import's warnings, reworded for music read from a PDF or photo: there, bar lines stop
 * matching the page because the reader made a bar longer, and the notes after it DO come later than
 * printed (for a MusicXML file the notes are exact, hence "the notes are not affected").
 */
export function readScoreWarnings(warnings: string[]): string[] {
  return warnings.map((w) => {
    const bar = /^From bar (\S+), the bar lines in the piano roll and in the sheet music view no longer match the original score/.exec(w);
    if (bar) return `From bar ${bar[1]}, the bar lines in the piano roll and in the sheet music view no longer match your page: a bar was read with too many beats. Notes after it may come later than printed.`;
    return w.replace(/;? ?the notes are not affected\.?$/i, '.').replace(/\.\.$/, '.');
  });
}

/** Timeline labels for the sheet-music reader's stages (the rest as in STAGE_LABELS). */
export const SHEET_STAGE_LABELS: Partial<Record<ImportStage, string>> = {
  validating: 'Preparing the pages',
  'loading-model': 'Loading the sheet-music reader',
  analyzing: 'Reading the music',
};

/** A stage's label in the progress timeline of this job. */
export function stageLabel(job: Pick<ImportJob, 'sheet'>, stage: ImportStage): string {
  return (job.sheet && SHEET_STAGE_LABELS[stage]) || STAGE_LABELS[stage];
}

export const STAGE_LABELS: Record<ImportStage, string> = {
  validating: 'Checking file',
  uploading: 'Uploading',
  downloading: 'Fetching audio',
  separating: 'Separating vocals & drums',
  decoding: 'Decoding audio',
  'loading-model': 'Loading AI model',
  analyzing: 'Detecting notes',
  extracting: 'Extracting notes',
  arranging: 'Building arrangements',
  saving: 'Saving',
  done: 'Done',
  error: 'Failed',
};
