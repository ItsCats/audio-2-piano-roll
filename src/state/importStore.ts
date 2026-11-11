/**
 * Import jobs (one at a time). Lives outside React components so an import keeps running
 * while the user navigates around the app.
 */
import { create } from 'zustand';
import { transcribeAudio, type ProgressEvent } from '../lib/transcription/pipeline';
import type { TranscriptionStage } from '../lib/transcription/workerProtocol';
import { classifyFile } from '../lib/transcription/decode';
import { parseMidi } from '../lib/music/midi';
import { buildSong, demoSong, songFromMidi, titleFromFileName } from '../lib/songs';
import { saveAudio, savePosteriors, saveSong } from '../lib/storage/db';
import { detectionParams, useSettings } from './settingsStore';
import { useLibrary } from './libraryStore';
import { configuredBackendUrl, createSeparationJob, createYouTubeJob, getJobAudio, waitForJob } from '../lib/backend/client';
import type { Song, SongSource } from '../lib/music/types';
import { toast } from './toastStore';

export type ImportStage = TranscriptionStage | 'downloading' | 'uploading' | 'done' | 'error';

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
}

interface ImportState {
  job: ImportJob | null;
  controller: AbortController | null;
  importFile: (file: File, opts?: { separate?: boolean; title?: string }) => Promise<string | null>;
  importAudioBlob: (blob: Blob, meta: { title: string; artist?: string; source: SongSource; separate?: boolean }) => Promise<string | null>;
  importYouTubeViaServer: (videoUrl: string, videoId: string, separate: boolean, meta?: { title?: string; artist?: string }) => Promise<string | null>;
  importDemo: () => Promise<string>;
  cancel: () => void;
  clear: () => void;
}

let seq = 1;

export const useImport = create<ImportState>((set, get) => {
  const update = (patch: Partial<ImportJob>) => {
    const job = get().job;
    if (!job) return;
    const history = patch.stage && job.history[job.history.length - 1] !== patch.stage ? [...job.history, patch.stage] : job.history;
    set({ job: { ...job, ...patch, history } });
  };

  const start = (title: string, kind: SongSource['kind']) => {
    get().controller?.abort();
    const controller = new AbortController();
    set({
      controller,
      job: { id: seq++, title, kind, stage: 'validating', progress: null, warnings: [], startedAt: Date.now(), history: ['validating'] },
    });
    return controller;
  };

  const finish = async (song: Song) => {
    update({ stage: 'saving', progress: null, detail: 'Saving to your library' });
    await saveSong(song);
    void useLibrary.getState().refresh();
    update({ stage: 'done', progress: 1, songId: song.id, finishedAt: Date.now(), detail: undefined });
    return song.id;
  };

  const fail = (err: unknown) => {
    if (err instanceof DOMException && err.name === 'AbortError') {
      set({ job: null, controller: null });
      return null;
    }
    const msg = err instanceof Error ? err.message : String(err);
    update({ stage: 'error', error: msg, finishedAt: Date.now() });
    return null;
  };

  const onProgress = (e: ProgressEvent) => update({ stage: e.stage, progress: e.progress, detail: e.detail });

  const transcribeAndSave = async (
    original: Blob,
    forTranscription: Blob,
    meta: { title: string; artist?: string; source: SongSource; separated?: boolean },
    signal: AbortSignal,
  ) => {
    const params = detectionParams();
    const result = await transcribeAudio(forTranscription, params, onProgress, signal);
    if (meta.separated) result.info.separated = true;
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
    return finish(song);
  };

  const separateIfRequested = async (blob: Blob, name: string, separate: boolean | undefined, signal: AbortSignal) => {
    const backend = configuredBackendUrl(useSettings.getState().backendUrl);
    if (!separate || !backend) return { blob, separated: false };
    update({ stage: 'uploading', progress: null, detail: 'Uploading to your processing server' });
    const job = await createSeparationJob(backend, blob, name);
    await waitForJob(
      backend,
      job.id,
      (j) => update({ stage: 'separating', progress: j.progress, detail: `Isolating the piano part (${j.stage})` }),
      signal,
    );
    update({ stage: 'downloading', progress: null, detail: 'Downloading separated audio' });
    return { blob: await getJobAudio(backend, job.id), separated: true };
  };

  return {
    job: null,
    controller: null,

    importFile: async (file, opts = {}) => {
      const controller = start(opts.title ?? titleFromFileName(file.name), 'audio');
      try {
        const kind = classifyFile(file);
        if (kind === 'unsupported') {
          throw new Error(`"${file.name}" is not a supported audio, video or MIDI file.`);
        }
        if (kind === 'midi') {
          update({ kind: 'midi', stage: 'arranging', detail: 'Reading MIDI file' });
          if (file.size > 20 * 1024 * 1024) throw new Error('MIDI file is unusually large (max 20 MB).');
          const parsed = parseMidi(await file.arrayBuffer());
          const song = songFromMidi(parsed, file.name, file.size);
          if (opts.title) song.title = opts.title;
          return await finish(song);
        }
        const source: SongSource = { kind: 'audio', fileName: file.name, mimeType: file.type, fileSize: file.size };
        const sep = await separateIfRequested(file, file.name, opts.separate, controller.signal);
        return await transcribeAndSave(
          file,
          sep.blob,
          { title: opts.title ?? titleFromFileName(file.name), source, separated: sep.separated },
          controller.signal,
        );
      } catch (err) {
        return fail(err);
      }
    },

    importAudioBlob: async (blob, meta) => {
      const controller = start(meta.title, meta.source.kind);
      try {
        const sep = await separateIfRequested(blob, `${meta.title}.webm`, meta.separate, controller.signal);
        return await transcribeAndSave(blob, sep.blob, { ...meta, separated: sep.separated }, controller.signal);
      } catch (err) {
        return fail(err);
      }
    },

    importYouTubeViaServer: async (videoUrl, videoId, separate, meta) => {
      const controller = start(meta?.title ?? 'YouTube video', 'youtube');
      try {
        const backend = configuredBackendUrl(useSettings.getState().backendUrl);
        if (!backend) throw new Error('No processing server is configured (Settings → Processing server).');
        update({ stage: 'downloading', progress: null, detail: 'Fetching audio on your processing server' });
        const job = await createYouTubeJob(backend, videoUrl, separate);
        const done = await waitForJob(
          backend,
          job.id,
          (j) =>
            update({
              stage: j.stage === 'separating' ? 'separating' : 'downloading',
              progress: j.progress,
              detail: j.stage === 'separating' ? 'Isolating the piano part (Demucs)' : 'Fetching audio on your processing server',
              title: j.title ?? meta?.title ?? 'YouTube video',
            }),
          controller.signal,
        );
        update({ stage: 'downloading', progress: null, detail: 'Transferring audio to the browser' });
        const blob = await getJobAudio(backend, job.id);
        const title = done.title ?? meta?.title ?? 'YouTube video';
        return await transcribeAndSave(
          blob,
          blob,
          {
            title,
            artist: done.artist ?? meta?.artist,
            source: { kind: 'youtube', youtubeId: videoId, url: videoUrl, mimeType: blob.type, fileSize: blob.size },
            separated: separate,
          },
          controller.signal,
        );
      } catch (err) {
        return fail(err);
      }
    },

    importDemo: async () => {
      start('Bach — Prelude in C major', 'demo');
      const song = demoSong();
      return (await finish(song))!;
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
  separating: 'Isolating piano',
  decoding: 'Decoding audio',
  'loading-model': 'Loading AI model',
  analyzing: 'Detecting notes',
  extracting: 'Extracting notes',
  arranging: 'Building arrangements',
  saving: 'Saving',
  done: 'Done',
  error: 'Failed',
};
