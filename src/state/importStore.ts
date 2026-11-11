/**
 * Import jobs (one at a time). Lives outside React components so an import keeps running
 * while the user navigates around the app.
 */
import { create } from 'zustand';
import { transcribeAudio, type ProgressEvent, type TranscribeOptions } from '../lib/transcription/pipeline';
import type { TranscriptionStage } from '../lib/transcription/workerProtocol';
import { classifyFile } from '../lib/transcription/decode';
import { parseMidi } from '../lib/music/midi';
import { buildSong, demoSong, songFromMidi, titleFromFileName } from '../lib/songs';
import { saveAudio, savePosteriors, saveSong } from '../lib/storage/db';
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
import type { Song, SongSource } from '../lib/music/types';
import { toast } from './toastStore';

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
  /**
   * Speed measurement for the current phase (same stage and same kind of detail message): where
   * progress was when the phase started, and the time remaining extrapolated from the measured
   * rate at the last update. Only set once there is real progress to extrapolate from.
   */
  rate?: { key: string; t0: number; p0: number; etaSec?: number; at?: number };
}

/** Detection preset ids (mirrors settings.detectionPreset). */
export type PresetId = 'piano' | 'mix' | 'sensitive' | 'custom';

export interface ImportPrefs {
  /** the user's last explicit "Separate vocals & drums" choice, per detection preset */
  separate: Partial<Record<PresetId, boolean>>;
}

interface ImportState {
  job: ImportJob | null;
  controller: AbortController | null;
  prefs: ImportPrefs;
  /** remember the user's separation choice for a detection preset */
  setSeparatePref: (preset: PresetId, value: boolean) => void;
  /** `separate` defaults to the user's choice for the current detection preset */
  importFile: (file: File, opts?: { separate?: boolean; title?: string }) => Promise<string | null>;
  importAudioBlob: (blob: Blob, meta: { title: string; artist?: string; source: SongSource; separate?: boolean }) => Promise<string | null>;
  importYouTubeViaServer: (videoUrl: string, videoId: string, separate: boolean, meta?: { title?: string; artist?: string }) => Promise<string | null>;
  importDemo: () => Promise<string>;
  cancel: () => void;
  clear: () => void;
}

// ---------------------------------------------------------------- preferences (own key; the settings key is untouched)

const PREFS_KEY = 'piano2vision-import-prefs';

function loadPrefs(): ImportPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { separate: {} };
    const p = JSON.parse(raw) as Partial<ImportPrefs>;
    const sep: ImportPrefs['separate'] = {};
    for (const k of ['piano', 'mix', 'sensitive', 'custom'] as PresetId[]) {
      if (typeof p.separate?.[k] === 'boolean') sep[k] = p.separate[k];
    }
    return { separate: sep };
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

/** Health of the processing server, cached for a minute (null when unreachable). */
export function serverHealth(url: string): Promise<BackendHealth | null> {
  const hit = healthCache.get(url);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const value = health(url).catch(() => null);
  healthCache.set(url, { at: Date.now(), value });
  return value;
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

/** The separation default for a preset: the user's last choice, else on for "Full song" (when recommended). */
export function separationChoice(prefs: ImportPrefs, preset: PresetId, avail: SeparationAvailability): boolean {
  if (!avail.available) return false;
  const remembered = prefs.separate[preset];
  if (remembered !== undefined) return remembered;
  return preset === 'mix' && avail.recommended;
}

// ---------------------------------------------------------------- timeline plans

const TRANSCRIBE: ImportStage[] = ['decoding', 'loading-model', 'analyzing', 'arranging', 'saving'];
const BROWSER_SEP: ImportStage[] = ['decoding', 'separating', 'loading-model', 'analyzing', 'arranging', 'saving'];
const SERVER_SEP: ImportStage[] = ['uploading', 'separating', 'downloading', ...TRANSCRIBE];

function planFor(kind: SongSource['kind'], sep: SeparationEngine | undefined, youtubeServer = false): ImportStage[] {
  if (kind === 'midi' || kind === 'demo') return ['validating', 'arranging', 'saving'];
  const rest = sep === 'server' ? SERVER_SEP : sep === 'browser' ? BROWSER_SEP : TRANSCRIBE;
  // unique: a YouTube import via the server downloads twice (the video's audio, then the stems)
  return [...new Set<ImportStage>(['validating', ...(youtubeServer ? (['downloading'] as ImportStage[]) : []), ...rest])];
}

/** "Separating vocals & drums: part 3 of 12" and "… part 4 of 12" are the same phase; numbers are dropped. */
const phaseKey = (stage: ImportStage, detail?: string) => `${stage}|${(detail ?? '').replace(/[\d.,]+/g, '#')}`;

let seq = 1;

/** One import's handle: its updates are dropped once it was cancelled or replaced by a newer import. */
interface Ctx {
  id: number;
  signal: AbortSignal;
  update: (patch: Partial<ImportJob>) => void;
  onProgress: (e: ProgressEvent) => void;
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

  const start = (title: string, kind: SongSource['kind'], plan: ImportStage[], separation?: SeparationEngine): Ctx => {
    get().controller?.abort();
    const controller = new AbortController();
    const id = seq++;
    set({
      controller,
      job: { id, title, kind, stage: 'validating', progress: null, warnings: [], startedAt: Date.now(), history: ['validating'], plan, separation },
    });
    const update = (patch: Partial<ImportJob>) => {
      if (!controller.signal.aborted) apply(id, patch);
    };
    return { id, signal: controller.signal, update, onProgress: (e) => update({ stage: e.stage, progress: e.progress, detail: e.detail }) };
  };

  const finish = async ({ update }: Ctx, song: Song) => {
    update({ stage: 'saving', progress: null, detail: 'Saving to your library' });
    await saveSong(song);
    void useLibrary.getState().refresh();
    update({ stage: 'done', progress: 1, songId: song.id, finishedAt: Date.now(), detail: undefined });
    return song.id;
  };

  const isAbort = (err: unknown) => (err instanceof DOMException || err instanceof Error) && err.name === 'AbortError';

  const fail = (ctx: Ctx, err: unknown) => {
    if (isAbort(err) || ctx.signal.aborted) {
      if (get().job?.id === ctx.id) set({ job: null, controller: null });
      return null;
    }
    const msg = err instanceof Error ? err.message : String(err);
    ctx.update({ stage: 'error', error: msg, finishedAt: Date.now() });
    return null;
  };

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
    await waitForJob(
      url,
      job.id,
      (j) =>
        update({
          stage: 'separating',
          progress: j.progress,
          detail: j.stage === 'queued' ? 'Waiting for your processing server' : j.stage === 'separating' ? 'Separating vocals & drums on your server' : `Separating vocals & drums on your server (${j.stage})`,
        }),
      signal,
    );
    update({ stage: 'downloading', progress: null, detail: 'Downloading the separated vocals and accompaniment' });
    const stems = await backendApi.fetchStems(url, job.id);
    if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    return stems;
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
  ) => {
    const { update, onProgress, signal } = ctx;
    const params = detectionParams();
    const extraWarnings: string[] = [];
    let opts: TranscribeOptions = {};
    let progress = onProgress;
    if (engine === 'server') {
      try {
        opts = { stems: await serverStems(ctx, original, meta.fileName) };
        // the pipeline's "separating" step for ready-made stems is only decoding them
        progress = (e) => onProgress(e.stage === 'separating' ? { ...e, stage: 'decoding', progress: null } : e);
      } catch (err) {
        if (isAbort(err) || signal.aborted) throw err;
        const browser = separationSupport();
        const why = (err as Error)?.message ?? String(err);
        if (browser.ok) {
          extraWarnings.push(`The processing server could not separate this song (${why}); it was separated in the browser instead.`);
          opts = { separate: true };
          const job = get().job;
          if (job) update({ plan: planFor(job.kind, 'browser', job.plan[1] === 'downloading'), separation: 'browser' });
        } else {
          extraWarnings.push(`The processing server could not separate this song (${why}); the full mix was transcribed.`);
        }
        update({ warnings: [...(get().job?.warnings ?? []), ...extraWarnings] });
      }
    } else if (engine === 'browser') {
      opts = { separate: true };
    }
    const result = await transcribeAudio(original, params, progress, signal, opts);
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
    });
    update({ warnings: result.info.warnings, stage: 'saving', progress: null });
    try {
      await saveAudio(song.id, original, meta.source.fileName ?? meta.title);
      await savePosteriors(song.id, result.posteriors);
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
    prefs: loadPrefs(),

    setSeparatePref: (preset, value) => {
      const prefs = { ...get().prefs, separate: { ...get().prefs.separate, [preset]: value } };
      set({ prefs });
      savePrefs(prefs);
    },

    importFile: async (file, opts = {}) => {
      const kind = classifyFile(file);
      const title = opts.title ?? titleFromFileName(file.name);
      if (kind === 'midi' || kind === 'unsupported') {
        const ctx = start(title, kind === 'midi' ? 'midi' : 'audio', planFor('midi', undefined));
        const { update } = ctx;
        try {
          if (kind === 'unsupported') throw new Error(`"${file.name}" is not a supported audio, video or MIDI file.`);
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
      const ctx = start(title, 'audio', planFor('audio', undefined));
      try {
        const separate = opts.separate ?? (await defaultSeparate());
        const engine = await pickEngine(separate);
        if (ctx.signal.aborted) return null;
        ctx.update({ plan: planFor('audio', engine), separation: engine });
        const source: SongSource = { kind: 'audio', fileName: file.name, mimeType: file.type, fileSize: file.size };
        return await transcribeAndSave(ctx, file, { title, source, fileName: file.name }, engine);
      } catch (err) {
        return fail(ctx, err);
      }
    },

    importAudioBlob: async (blob, meta) => {
      const ctx = start(meta.title, meta.source.kind, planFor(meta.source.kind, undefined));
      try {
        const engine = await pickEngine(!!meta.separate);
        if (ctx.signal.aborted) return null;
        ctx.update({ plan: planFor(meta.source.kind, engine), separation: engine });
        return await transcribeAndSave(ctx, blob, { ...meta, fileName: `${meta.title}.webm` }, engine);
      } catch (err) {
        return fail(ctx, err);
      }
    },

    importYouTubeViaServer: async (videoUrl, videoId, separate, meta) => {
      const ctx = start(meta?.title ?? 'YouTube video', 'youtube', planFor('youtube', undefined, true));
      const { update, signal } = ctx;
      try {
        const backend = backendUrl();
        if (!backend) throw new Error('No processing server is configured (Settings → Processing server).');
        const engine = await pickEngine(separate);
        if (signal.aborted) return null;
        update({ plan: planFor('youtube', engine, true), separation: engine });
        update({ stage: 'downloading', progress: null, detail: 'Fetching audio on your processing server' });
        // always fetch the original mix: it is what plays back in the Studio; separation follows as for files
        const job = await createYouTubeJob(backend, videoUrl, false);
        const done = await waitForJob(
          backend,
          job.id,
          (j) =>
            update({
              stage: 'downloading',
              progress: j.progress,
              detail: j.stage === 'downloading' ? 'Fetching audio on your processing server' : `Preparing audio on your processing server (${j.stage})`,
              title: j.title ?? meta?.title ?? 'YouTube video',
            }),
          signal,
        );
        update({ stage: 'downloading', progress: null, detail: 'Transferring audio to the browser' });
        const blob = await getJobAudio(backend, job.id);
        const title = done.title ?? meta?.title ?? 'YouTube video';
        return await transcribeAndSave(
          ctx,
          blob,
          {
            title,
            artist: done.artist ?? meta?.artist,
            source: { kind: 'youtube', youtubeId: videoId, url: videoUrl, mimeType: blob.type, fileSize: blob.size },
            fileName: `${title}.m4a`,
          },
          engine,
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
      set({ job: null, controller: null });
    },
    clear: () => {
      const j = get().job;
      if (j && (j.stage === 'done' || j.stage === 'error')) set({ job: null, controller: null });
    },
  };
});

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
