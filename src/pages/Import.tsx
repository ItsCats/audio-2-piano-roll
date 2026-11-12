import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { FileAudio, SquarePlay, FileMusic, Mic, Loader2, CheckCircle2, XCircle, Circle, ArrowRight, Square, Info, Server, RotateCcw, Download, Smartphone } from 'lucide-react';
import { Dropzone } from '../components/import/Dropzone';
import { SeparationOption, useSeparationChoice } from '../components/import/SeparationOption';
import { PianoModelOption, usePianoModelChoice } from '../components/import/PianoModelOption';
import type { TranscriptionEngine } from '../lib/transcription/pipeline';
import { Badge, Button, ProgressBar, Segmented, cn } from '../components/ui';
import { STAGE_LABELS, rememberServerHealth, useImport, type ImportJob, type ImportStage } from '../state/importStore';
import { useSettings } from '../state/settingsStore';
import { configuredBackendUrl, health, type BackendHealth } from '../lib/backend/client';
import { createPlayer, fetchVideoMeta, parseYouTubeId, startTabCapture, tabCaptureSupported, type TabCapture, type VideoMeta, type YTPlayer } from '../lib/youtube/youtube';
import { formatTime } from '../lib/music/theory';
import { toast } from '../state/toastStore';
import { createScreenWakeLock, isTouchDevice } from '../lib/wakeLock';
import { saveBlobAs } from '../lib/saveBlob';
import { YOUTUBE_IMPORT_PATH, documentIsolated, isYouTubeImportPath, switchDocument } from '../lib/isolation';

type Tab = 'audio' | 'youtube' | 'midi' | 'record';

function useBackend() {
  const url = configuredBackendUrl(useSettings((s) => s.backendUrl));
  const [state, setState] = useState<{ health: BackendHealth | null; checking: boolean }>({ health: null, checking: false });
  useEffect(() => {
    if (!url) return;
    let alive = true;
    setState({ health: null, checking: true });
    health(url)
      .then((h) => {
        rememberServerHealth(url, h); // the separation option and the import use the same answer
        if (alive) setState({ health: h, checking: false });
      })
      .catch(() => {
        rememberServerHealth(url, null);
        if (alive) setState({ health: null, checking: false });
      });
    return () => {
      alive = false;
    };
  }, [url]);
  return { url, ...state };
}

function DetectionOptions() {
  const preset = useSettings((s) => s.detectionPreset);
  const set = useSettings((s) => s.set);
  const descriptions: Record<string, string> = {
    piano: 'Best for solo piano recordings. Tuned to ignore ringing strings and reverb.',
    mix: 'For full songs with vocals, drums and band. Follows sustained melody lines.',
    sensitive: 'Catches quiet and fast notes, at the cost of more false notes to clean up.',
    custom: 'Your custom thresholds from Settings.',
  };
  return (
    <div className="flex flex-col gap-2">
      <span className="text-[12.5px] font-medium text-ink-200">What kind of recording is it?</span>
      <Segmented
        ariaLabel="Detection preset"
        value={preset}
        onChange={(v) => set({ detectionPreset: v })}
        options={[
          { value: 'piano', label: 'Piano solo' },
          { value: 'mix', label: 'Full song' },
          { value: 'sensitive', label: 'Sensitive' },
        ]}
      />
      <p className="text-[12px] text-ink-300">{descriptions[preset]}</p>
      <PianoModelOption className="mt-1" />
    </div>
  );
}

/** Timeline: the planned stages, with any unplanned stage that actually happened slotted in where it happened. */
function timeline(job: ImportJob): ImportStage[] {
  const order = [...job.plan];
  job.history.forEach((st, i) => {
    if (st === 'done' || st === 'error' || order.includes(st)) return;
    // right after the stage that preceded it
    const prev = i > 0 ? order.indexOf(job.history[i - 1]) : -1;
    order.splice(prev + 1, 0, st);
  });
  return order;
}

function formatEta(sec: number): string {
  if (sec < 15) return 'a few seconds left';
  if (sec < 60) return `about ${Math.round(sec / 5) * 5} s left`;
  const m = Math.round(sec / 60);
  return m <= 1 ? 'about 1 min left' : `about ${m} min left`;
}

/**
 * The step the speed measurement covers ("separation", "pitch detection 1 of 2"): the ETA is for
 * this step only, so it says which one (more steps follow, see the checklist below the bar).
 */
function etaStep(job: Pick<ImportJob, 'stage' | 'detail' | 'transcriber'>): string {
  const part = job.detail?.match(/\((\d+) of (\d+)\)/);
  switch (job.stage) {
    case 'separating':
      return 'separation';
    case 'loading-model':
      return job.transcriber === 'piano-specialist' ? 'loading the piano model' : STAGE_LABELS[job.stage].toLowerCase();
    case 'analyzing':
      if (job.transcriber === 'piano-specialist') return 'piano model';
      return part ? `pitch detection ${part[1]} of ${part[2]}` : 'pitch detection';
    case 'downloading':
      return 'download';
    case 'uploading':
      return 'upload';
    default:
      return STAGE_LABELS[job.stage].toLowerCase();
  }
}

/** time remaining in the current step, extrapolated from its measured speed (null until measured) */
function etaText(job: ImportJob): string | null {
  const r = job.rate;
  if (!r || r.etaSec === undefined || r.at === undefined) return null;
  const left = r.etaSec - (Date.now() - r.at) / 1000;
  return `${etaStep(job)}: ${left > 0 ? formatEta(left) : 'finishing…'}`;
}

function JobProgress() {
  const job = useImport((s) => s.job);
  const cancel = useImport((s) => s.cancel);
  const clear = useImport((s) => s.clear);
  const failed = useImport((s) => s.failed);
  // a failed high-accuracy run: offer the fast model while the high-accuracy one is still selected
  const pianoModelSelected = useImport((s) => s.prefs.pianoModel === true);
  const navigate = useNavigate();
  const [touch] = useState(isTouchDevice);
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 500);
    return () => clearInterval(t);
  }, []);
  if (!job) return null;
  const order = timeline(job);
  const failedStage = job.stage === 'error' ? job.history[job.history.length - 2] : null;
  const current = failedStage ?? job.stage;
  const activeIdx = order.indexOf(current);
  const eta = etaText(job);
  const elapsed = ((job.finishedAt ?? Date.now()) - job.startedAt) / 1000;
  const done = job.stage === 'done';
  const err = job.stage === 'error';
  const failedHere = err && failed?.jobId === job.id ? failed : null;
  return (
    <div className="panel animate-fade-in p-5" aria-live="polite">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold text-ink-50">{job.title}</p>
          <p className="mt-0.5 text-[12.5px] text-ink-300">
            {done ? (job.kind === 'score' || job.kind === 'midi' ? 'Ready' : 'Transcription complete') : err ? 'Import failed' : job.detail ?? STAGE_LABELS[job.stage]} · {formatTime(elapsed)}
          </p>
        </div>
        {!done && !err && (
          <Button size="sm" variant="ghost" onClick={cancel}>
            Cancel
          </Button>
        )}
      </div>
      {!done && !err && (
        <div className="mt-4">
          <ProgressBar value={job.progress} />
          {touch && job.kind !== 'midi' && job.kind !== 'demo' && job.kind !== 'score' && (
            <p className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-300">
              <Smartphone size={13} className="shrink-0 text-accent-400" /> Keep this page open while it’s analysing.
            </p>
          )}
          {job.progress !== null && (
            <p className="mt-1.5 flex justify-between gap-3 font-mono text-[11px] text-ink-300">
              <span>{eta ?? ((job.stage === 'separating' || job.stage === 'analyzing') && job.progress < 0.99 ? `${etaStep(job)}: measuring speed…` : '')}</span>
              <span>{Math.round(job.progress * 100)}%</span>
            </p>
          )}
        </div>
      )}
      <ol className="mt-4 grid gap-1.5 sm:grid-cols-2">
        {order.map((st, i) => {
          const state =
            done ? 'done' : st === current ? (err ? 'failed' : 'active') : i < activeIdx || job.history.includes(st) ? 'done' : 'todo';
          return (
            <li key={st} className="flex items-center gap-2 text-[12.5px]">
              {state === 'done' ? <CheckCircle2 size={14} className="text-ok" /> : state === 'active' ? <Loader2 size={14} className="animate-spin text-accent-400" /> : state === 'failed' ? <XCircle size={14} className="text-bad" /> : <Circle size={14} className="text-ink-500" />}
              <span className={state === 'todo' ? 'text-ink-400' : 'text-ink-100'}>{STAGE_LABELS[st]}</span>
            </li>
          );
        })}
      </ol>
      {err && <p className="mt-4 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-[13px] text-bad">{job.error}</p>}
      {job.warnings.length > 0 && (
        <ul className="mt-4 flex flex-col gap-1">
          {job.warnings.map((w) => (
            <li key={w} className="flex gap-2 text-[12.5px] text-warn">
              <Info size={14} className="mt-0.5 shrink-0" /> {w}
            </li>
          ))}
        </ul>
      )}
      {(done || err) && (
        <div className="mt-4 flex flex-wrap gap-2">
          {done && job.songId && (
            <Button variant="primary" onClick={() => navigate(`/studio/${job.songId}`)} icon={<ArrowRight size={16} />}>
              Open in Piano Studio
            </Button>
          )}
          {err && failedHere && (
            <Button variant="primary" onClick={() => void failedHere.retry()} icon={<RotateCcw size={15} />}>
              Try again
            </Button>
          )}
          {err && failedHere?.retryFast && pianoModelSelected && (
            <Button onClick={() => void failedHere.retryFast!()} icon={<RotateCcw size={15} />}>
              Try with the normal model
            </Button>
          )}
          {err && failedHere?.recording && (
            <Button onClick={() => saveBlobAs(failedHere.recording!.blob, failedHere.recording!.fileName)} icon={<Download size={15} />}>
              Download recording
            </Button>
          )}
          <Button variant="ghost" onClick={clear}>
            {err ? 'Dismiss' : 'Import another'}
          </Button>
        </div>
      )}
    </div>
  );
}

function YouTubeTab({ busy, separate, transcriber }: { busy: boolean; separate: boolean; transcriber: TranscriptionEngine }) {
  const [params] = useSearchParams();
  const [url, setUrl] = useState(() => params.get('url') ?? '');
  // Only reachable while an import was running when the tab was opened (App.tsx IsolationGate):
  // this page is cross-origin isolated, which the YouTube player can't be embedded in.
  const [isolated] = useState(documentIsolated);
  const [meta, setMeta] = useState<VideoMeta | null>(null);
  const [rights, setRights] = useState(false);
  const [capturing, setCapturing] = useState<{ t: number; d: number } | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);
  const playerEl = useRef<HTMLDivElement>(null);
  const player = useRef<YTPlayer | null>(null);
  const capture = useRef<TabCapture | null>(null);
  const importYT = useImport((s) => s.importYouTubeViaServer);
  const importBlob = useImport((s) => s.importAudioBlob);
  const backend = useBackend();
  const id = parseYouTubeId(url);
  const serverReady = !!backend.health?.features.youtube;
  // say why a button is disabled instead of leaving it silently grey
  const commonBlock = !rights
    ? 'Tick the box above to confirm you have the rights to this video.'
    : busy
      ? 'Another import is still running — wait for it to finish (progress is shown above).'
      : null;
  const recordBlock = !tabCaptureSupported()
    ? 'Recording tab audio needs Chrome or Edge on a computer.'
    : isolated
      ? 'Load the video player above first.'
      : playerError
      ? 'This video can’t be played here, so it can’t be recorded.'
      : commonBlock;
  const serverBlock = !serverReady ? 'Set up a processing server in Settings to use this.' : commonBlock;

  useEffect(() => {
    setMeta(null);
    setPlayerError(null);
    if (!id) return;
    let alive = true;
    void fetchVideoMeta(id).then((m) => alive && setMeta(m));
    const host = playerEl.current;
    if (host && !isolated) {
      host.innerHTML = '<div></div>';
      createPlayer(host.firstElementChild as HTMLElement, id, (state) => {
        if (state === 0 && capture.current) void finishCapture();
      })
        .then((p) => {
          if (alive) player.current = p;
          else p.destroy();
        })
        .catch((e: Error) => alive && setPlayerError(e.message));
    }
    return () => {
      alive = false;
      player.current?.destroy();
      player.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    if (!capturing) return;
    const t = setInterval(() => {
      const p = player.current;
      if (p) setCapturing({ t: p.getCurrentTime(), d: p.getDuration() });
    }, 250);
    return () => clearInterval(t);
  }, [capturing !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const finishCapture = async () => {
    const c = capture.current;
    if (!c) return;
    capture.current = null;
    player.current?.pauseVideo();
    setCapturing(null);
    const blob = await c.stop();
    if (blob.size < 2000) {
      toast.error('Nothing was recorded', 'Make sure "Share tab audio" was enabled.');
      return;
    }
    void importBlob(blob, {
      title: meta?.title ?? 'YouTube capture',
      artist: meta?.author,
      source: { kind: 'youtube', youtubeId: id ?? undefined, url, mimeType: blob.type, fileSize: blob.size },
      separate,
      transcriber,
    });
  };

  const startCapture = async () => {
    const p = player.current;
    if (!p) return;
    try {
      const c = await startTabCapture();
      capture.current = c;
      c.stream.getTracks().forEach((t) => (t.onended = () => void finishCapture()));
      p.seekTo(0, true);
      p.unMute();
      p.setVolume(100);
      p.playVideo();
      setCapturing({ t: 0, d: p.getDuration() });
    } catch (e) {
      const msg = (e as Error).message;
      if (!/denied|NotAllowed/i.test(msg)) toast.error('Could not capture tab audio', msg);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label htmlFor="yt" className="text-[12.5px] font-medium text-ink-200">
          YouTube URL
        </label>
        <input
          id="yt"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://www.youtube.com/watch?v=…"
          className="focus-ring h-11 rounded-xl border border-ink-600 bg-ink-900 px-3.5 text-[14px] text-ink-50 placeholder:text-ink-400"
        />
        {url && !id && <p className="text-[12px] text-bad">That doesn’t look like a YouTube video link.</p>}
      </div>
      <div className={cn('overflow-hidden rounded-xl border border-ink-700 bg-black', !id && 'hidden')}>
        <div className={cn('aspect-video w-full', isolated && 'hidden')} ref={playerEl} />
        {isolated && (
          <div className="flex aspect-video w-full flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="max-w-sm text-[12.5px] leading-relaxed text-ink-200">
              {busy
                ? 'The video player needs a page reload, which would stop the import that is running. It can load as soon as that import finishes.'
                : 'The video player needs a quick page reload.'}
            </p>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => switchDocument(`${YOUTUBE_IMPORT_PATH}${url ? `?url=${encodeURIComponent(url)}` : ''}`)}
            >
              Load the video player
            </Button>
          </div>
        )}
      </div>
      {playerError && <p className="text-[12.5px] text-bad">{playerError}</p>}
      {id && (
        <>
          {meta && (
            <p className="text-[13px] text-ink-200">
              <span className="font-medium text-ink-50">{meta.title}</span> · {meta.author}
            </p>
          )}
          <label
            className={cn(
              'flex items-start gap-2 rounded-lg border p-2.5 text-[12.5px] transition-colors',
              rights ? 'border-transparent text-ink-200' : 'border-accent-500/40 bg-accent-500/10 text-ink-100',
            )}
          >
            <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} className="mt-0.5 accent-[var(--color-accent-500)]" />
            I own this content or have permission to use it, and I’ll respect YouTube’s Terms of Service and the creator’s copyright.
          </label>
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-ink-700 bg-ink-900/60 p-4">
              <div className="flex items-center gap-2 text-[13.5px] font-medium text-ink-50">
                <Server size={16} className="text-accent-400" /> Process on my server
                {serverReady ? <Badge tone="ok">connected</Badge> : <Badge>not configured</Badge>}
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed text-ink-300">
                Fastest and most reliable. Your self-hosted processing server fetches the audio. See the README to set one up.
              </p>
              <Button className="mt-3" variant="primary" size="sm" disabled={!!serverBlock} onClick={() => void importYT(url, id, separate, { title: meta?.title, artist: meta?.author, transcriber })}>
                Fetch & transcribe
              </Button>
              {serverBlock && <p className="mt-1.5 text-[11.5px] text-ink-400">{serverBlock}</p>}
            </div>
            <div className="rounded-xl border border-ink-700 bg-ink-900/60 p-4">
              <div className="flex items-center gap-2 text-[13.5px] font-medium text-ink-50">
                <Mic size={16} className="text-accent-400" /> Record from this tab
                {!tabCaptureSupported() && <Badge tone="warn">unsupported</Badge>}
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed text-ink-300">
                Works in Chrome/Edge on desktop. Choose <b>This tab</b> and enable <b>Share tab audio</b>; the video plays once in real time while it records.
              </p>
              {capturing ? (
                <div className="mt-3 flex flex-col gap-2">
                  <ProgressBar value={capturing.d ? capturing.t / capturing.d : null} />
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11.5px] text-ink-300">
                      Recording {formatTime(capturing.t)} / {formatTime(capturing.d)}
                    </span>
                    <Button size="sm" variant="danger" icon={<Square size={12} />} onClick={() => void finishCapture()}>
                      Stop & transcribe
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <Button className="mt-3" size="sm" disabled={!!recordBlock} onClick={() => void startCapture()}>
                    Start recording
                  </Button>
                  {recordBlock && <p className="mt-1.5 text-[11.5px] text-ink-400">{recordBlock}</p>}
                </>
              )}
            </div>
          </div>
        </>
      )}
      <p className="text-[12px] leading-relaxed text-ink-400">
        Piano2Vision never bypasses DRM or downloads YouTube videos inside the browser. If neither option suits you, download
        the audio through a service you’re licensed for and upload the file instead.
      </p>
    </div>
  );
}

function RecordTab({ busy }: { busy: boolean }) {
  const [rec, setRec] = useState<{ r: MediaRecorder; start: number; stream: MediaStream } | null>(null);
  const chunks = useRef<Blob[]>([]);
  const [, tick] = useState(0);
  const importBlob = useImport((s) => s.importAudioBlob);
  const [touch] = useState(isTouchDevice);
  // a phone that auto-locks mid-recording suspends the page (and the microphone): keep the screen on
  // while recording; the import holds its own lock from "Stop & transcribe" on (importStore.ts)
  const [wake] = useState(() => createScreenWakeLock());
  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => tick((x) => x + 1), 250);
    return () => clearInterval(t);
  }, [rec]);
  // leaving the tab mid-recording: stop the microphone (nothing is imported) and let the screen lock
  const live = useRef<{ r: MediaRecorder; stream: MediaStream } | null>(null);
  useEffect(
    () => () => {
      const l = live.current;
      live.current = null;
      if (l) {
        l.r.onstop = null;
        try {
          if (l.r.state !== 'inactive') l.r.stop();
        } catch {
          /* already stopped */
        }
        l.stream.getTracks().forEach((t) => t.stop());
      }
      chunks.current = [];
      void wake.hold(false);
    },
    [wake],
  );
  const start = async () => {
    // asked for inside the tap (some browsers only grant it with a user gesture); never throws
    void wake.hold(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const r = new MediaRecorder(stream);
      chunks.current = [];
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = () => {
        live.current = null;
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: r.mimeType || 'audio/webm' });
        // the Blob holds the data now: don't keep a second reference to every chunk
        chunks.current = [];
        // (no preset or model choice on this tab: Basic Pitch with the current preset, as always)
        void importBlob(blob, { title: `Recording ${new Date().toLocaleString()}`, source: { kind: 'capture', mimeType: blob.type, fileSize: blob.size }, transcriber: 'basic-pitch' });
        // the import has asked for its own lock by now (importStore.ts)
        void wake.hold(false);
      };
      r.start(500);
      live.current = { r, stream };
      setRec({ r, start: Date.now(), stream });
    } catch (e) {
      void wake.hold(false);
      toast.error('Microphone unavailable', (e as Error).message);
    }
  };
  return (
    <div className="flex flex-col items-center gap-4 py-8 text-center">
      <p className="max-w-md text-[13px] text-ink-300">Play piano (or anything) into your microphone. A quiet room and a close mic give the best transcription.</p>
      {rec ? (
        <>
          <div className="flex items-center gap-2 text-[14px] text-ink-50">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-bad" /> Recording {formatTime((Date.now() - rec.start) / 1000)}
          </div>
          {touch && (
            <p className="flex items-center gap-1.5 text-[12px] text-ink-300">
              <Smartphone size={13} className="shrink-0 text-accent-400" /> Keep this page open while recording.
            </p>
          )}
          <Button variant="danger" onClick={() => { live.current = null; rec.r.stop(); setRec(null); }} icon={<Square size={14} />}>
            Stop & transcribe
          </Button>
        </>
      ) : (
        <Button variant="primary" disabled={busy || !navigator.mediaDevices?.getUserMedia} onClick={() => void start()} icon={<Mic size={16} />}>
          Start recording
        </Button>
      )}
    </div>
  );
}

export default function ImportPage() {
  const [params] = useSearchParams();
  const { pathname } = useLocation();
  // the YouTube tab is its own route (no cross-origin isolation there: src/lib/isolation.ts)
  const tab: Tab = isYouTubeImportPath(pathname) ? 'youtube' : ((params.get('tab') as Tab) || 'audio');
  const job = useImport((s) => s.job);
  const importFile = useImport((s) => s.importFile);
  const navigate = useNavigate();
  const sep = useSeparationChoice();
  const model = usePianoModelChoice();
  // the piano model is for solo piano: separation is not used with it
  const pianoModel = model.transcriber === 'piano-specialist';
  const separate = sep.checked && !pianoModel;
  const busy = !!job && job.stage !== 'done' && job.stage !== 'error';

  // jump to the studio as soon as an import started on this page finishes
  const startedHere = useRef<number | null>(null);
  useEffect(() => {
    if (job?.stage === 'done' && job.songId && startedHere.current === job.id) {
      const t = setTimeout(() => navigate(`/studio/${job.songId}`), 700);
      return () => clearTimeout(t);
    }
  }, [job?.stage, job?.songId, job?.id, navigate]);
  useEffect(() => {
    if (busy && startedHere.current === null && job) startedHere.current = job.id;
  }, [busy, job]);

  const onFile = (f: File) => {
    if (busy) return;
    void importFile(f, { separate, transcriber: model.transcriber }).then(() => {});
    startedHere.current = (useImport.getState().job?.id ?? 0);
  };

  const tabs = [
    { id: 'audio', label: 'Audio / Video', icon: FileAudio },
    { id: 'youtube', label: 'YouTube', icon: SquarePlay },
    { id: 'midi', label: 'MIDI / Sheet music', icon: FileMusic },
    { id: 'record', label: 'Record', icon: Mic },
  ] as const;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-5 py-8 md:px-10">
        <header>
          <h1 className="text-[26px] font-semibold tracking-tight text-ink-50">Import music</h1>
          <p className="mt-1 text-[14px] text-ink-300">
            Audio is analysed on your device with Spotify’s Basic Pitch neural network (or, for solo piano, an optional high-accuracy piano model).
            Nothing is uploaded unless you use your own processing server.
            The result is an AI estimate —{' '}
            <Link to="/accuracy" className="text-accent-400 hover:text-accent-300">
              see how accurate it is
            </Link>
            .
          </p>
        </header>

        {job && <JobProgress />}

        <div className="panel overflow-hidden">
          <div role="tablist" className="flex overflow-x-auto border-b border-ink-700 px-2">
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => navigate(t.id === 'youtube' ? YOUTUBE_IMPORT_PATH : `/import?tab=${t.id}`)}
                className={cn(
                  'focus-ring flex h-12 items-center gap-2 border-b-2 px-4 text-[13.5px] font-medium whitespace-nowrap transition-colors',
                  tab === t.id ? 'border-accent-500 text-ink-50' : 'border-transparent text-ink-300 hover:text-ink-100',
                )}
              >
                <t.icon size={16} /> {t.label}
              </button>
            ))}
          </div>
          <div className="p-5">
            {tab === 'audio' && (
              <div className="flex flex-col gap-5">
                <Dropzone onFile={onFile} />
                <DetectionOptions />
                <SeparationOption unusedReason={pianoModel ? 'Not used with the high-accuracy piano model.' : undefined} />
                <p className="text-[12px] text-ink-400">Up to 20 minutes / 300 MB. Longer files: trim first. Video files use their audio track.</p>
              </div>
            )}
            {tab === 'youtube' && (
              <div className="flex flex-col gap-5">
                <YouTubeTab busy={busy} separate={separate} transcriber={model.transcriber} />
                <DetectionOptions />
                <SeparationOption unusedReason={pianoModel ? 'Not used with the high-accuracy piano model.' : undefined} />
              </div>
            )}
            {tab === 'midi' && (
              <div className="flex flex-col gap-3">
                <Dropzone onFile={onFile} accept="">
                  <p className="text-[15px] font-medium text-ink-50">Drop a MIDI or sheet-music file</p>
                  <p className="text-[12.5px] text-ink-300">MIDI (.mid) · MusicXML (.musicxml, .mxl) · MuseScore (.mscz)</p>
                </Dropzone>
                <p className="text-[12.5px] text-ink-300">
                  The notes are used exactly as written, and repeats are played in order. Hard is the piece as written; Easy and Medium are
                  made simpler for you.
                </p>
                <p className="text-[12px] text-ink-400">From other notation apps, save or export as MusicXML. PDFs and photos of sheet music are coming soon.</p>
              </div>
            )}
            {tab === 'record' && <RecordTab busy={busy} />}
          </div>
        </div>
      </div>
    </div>
  );
}
