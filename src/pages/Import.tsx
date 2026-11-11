import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { FileAudio, SquarePlay, Music2, Mic, Loader2, CheckCircle2, XCircle, Circle, ArrowRight, Square, Info, Server } from 'lucide-react';
import { Dropzone } from '../components/import/Dropzone';
import { Badge, Button, ProgressBar, Segmented, Toggle, cn } from '../components/ui';
import { STAGE_LABELS, useImport, type ImportStage } from '../state/importStore';
import { useSettings } from '../state/settingsStore';
import { configuredBackendUrl, health, type BackendHealth } from '../lib/backend/client';
import { createPlayer, fetchVideoMeta, parseYouTubeId, startTabCapture, tabCaptureSupported, type TabCapture, type VideoMeta, type YTPlayer } from '../lib/youtube/youtube';
import { formatTime } from '../lib/music/theory';
import { toast } from '../state/toastStore';

type Tab = 'audio' | 'youtube' | 'midi' | 'record';

function useBackend() {
  const url = configuredBackendUrl(useSettings((s) => s.backendUrl));
  const [state, setState] = useState<{ health: BackendHealth | null; checking: boolean }>({ health: null, checking: false });
  useEffect(() => {
    if (!url) return;
    let alive = true;
    setState({ health: null, checking: true });
    health(url)
      .then((h) => alive && setState({ health: h, checking: false }))
      .catch(() => alive && setState({ health: null, checking: false }));
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
    </div>
  );
}

function JobProgress() {
  const job = useImport((s) => s.job);
  const cancel = useImport((s) => s.cancel);
  const clear = useImport((s) => s.clear);
  const navigate = useNavigate();
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 500);
    return () => clearInterval(t);
  }, []);
  if (!job) return null;
  const order: ImportStage[] = job.kind === 'midi' || job.kind === 'demo'
    ? ['validating', 'arranging', 'saving']
    : ['validating', ...(job.history.includes('uploading') ? (['uploading'] as ImportStage[]) : []), ...(job.history.includes('downloading') ? (['downloading'] as ImportStage[]) : []), ...(job.history.includes('separating') ? (['separating'] as ImportStage[]) : []), 'decoding', 'loading-model', 'analyzing', 'arranging', 'saving'];
  const failedStage = job.stage === 'error' ? job.history[job.history.length - 2] : null;
  const activeIdx = failedStage ? order.indexOf(failedStage) : order.indexOf(job.stage);
  const elapsed = ((job.finishedAt ?? Date.now()) - job.startedAt) / 1000;
  const done = job.stage === 'done';
  const err = job.stage === 'error';
  return (
    <div className="panel animate-fade-in p-5" aria-live="polite">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold text-ink-50">{job.title}</p>
          <p className="mt-0.5 text-[12.5px] text-ink-300">
            {done ? 'Transcription complete' : err ? 'Import failed' : job.detail ?? STAGE_LABELS[job.stage]} · {formatTime(elapsed)}
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
          <ProgressBar value={job.stage === 'analyzing' || job.stage === 'separating' ? job.progress : null} />
          {job.stage === 'analyzing' && job.progress !== null && (
            <p className="mt-1.5 text-right font-mono text-[11px] text-ink-300">{Math.round(job.progress * 100)}%</p>
          )}
        </div>
      )}
      <ol className="mt-4 grid gap-1.5 sm:grid-cols-2">
        {order.map((st, i) => {
          const state = done || i < activeIdx ? 'done' : i === activeIdx ? (err ? 'failed' : 'active') : 'todo';
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
        <div className="mt-4 flex gap-2">
          {done && job.songId && (
            <Button variant="primary" onClick={() => navigate(`/studio/${job.songId}`)} icon={<ArrowRight size={16} />}>
              Open in Piano Studio
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

function YouTubeTab({ busy }: { busy: boolean }) {
  const [url, setUrl] = useState('');
  const [meta, setMeta] = useState<VideoMeta | null>(null);
  const [rights, setRights] = useState(false);
  const [separate, setSeparate] = useState(true);
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

  useEffect(() => {
    setMeta(null);
    setPlayerError(null);
    if (!id) return;
    let alive = true;
    void fetchVideoMeta(id).then((m) => alive && setMeta(m));
    const host = playerEl.current;
    if (host) {
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
      separate: separate && !!backend.health?.features.separation,
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
        <div className="aspect-video w-full" ref={playerEl} />
      </div>
      {playerError && <p className="text-[12.5px] text-bad">{playerError}</p>}
      {id && (
        <>
          {meta && (
            <p className="text-[13px] text-ink-200">
              <span className="font-medium text-ink-50">{meta.title}</span> · {meta.author}
            </p>
          )}
          <label className="flex items-start gap-2 text-[12.5px] text-ink-200">
            <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} className="mt-0.5 accent-[var(--color-accent-500)]" />
            I own this content or have permission to use it, and I’ll respect YouTube’s Terms of Service and the creator’s copyright.
          </label>
          {backend.health?.features.separation && <Toggle label="Isolate the piano part on my server (Demucs)" checked={separate} onChange={setSeparate} />}
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-ink-700 bg-ink-900/60 p-4">
              <div className="flex items-center gap-2 text-[13.5px] font-medium text-ink-50">
                <Server size={16} className="text-accent-400" /> Process on my server
                {serverReady ? <Badge tone="ok">connected</Badge> : <Badge>not configured</Badge>}
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed text-ink-300">
                Fastest and most reliable. Your self-hosted processing server fetches the audio. See the README to set one up.
              </p>
              <Button className="mt-3" variant="primary" size="sm" disabled={!serverReady || !rights || busy} onClick={() => void importYT(url, id, separate, { title: meta?.title, artist: meta?.author })}>
                Fetch & transcribe
              </Button>
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
                <Button className="mt-3" size="sm" disabled={!tabCaptureSupported() || !rights || busy || !!playerError} onClick={() => void startCapture()}>
                  Start recording
                </Button>
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
  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => tick((x) => x + 1), 250);
    return () => clearInterval(t);
  }, [rec]);
  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const r = new MediaRecorder(stream);
      chunks.current = [];
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks.current, { type: r.mimeType || 'audio/webm' });
        chunks.current = []; // don't keep a second copy of the recording alive during analysis
        void importBlob(blob, { title: `Recording ${new Date().toLocaleString()}`, source: { kind: 'capture', mimeType: blob.type, fileSize: blob.size } });
      };
      r.start(500);
      setRec({ r, start: Date.now(), stream });
    } catch (e) {
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
          <Button variant="danger" onClick={() => { rec.r.stop(); setRec(null); }} icon={<Square size={14} />}>
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
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'audio';
  const job = useImport((s) => s.job);
  const importFile = useImport((s) => s.importFile);
  const navigate = useNavigate();
  const backend = useBackend();
  const [separate, setSeparate] = useState(false);
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
    void importFile(f, { separate }).then(() => {});
    startedHere.current = (useImport.getState().job?.id ?? 0);
  };

  const tabs = [
    { id: 'audio', label: 'Audio / Video', icon: FileAudio },
    { id: 'youtube', label: 'YouTube', icon: SquarePlay },
    { id: 'midi', label: 'MIDI', icon: Music2 },
    { id: 'record', label: 'Record', icon: Mic },
  ] as const;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-5 py-8 md:px-10">
        <header>
          <h1 className="text-[26px] font-semibold tracking-tight text-ink-50">Import music</h1>
          <p className="mt-1 text-[14px] text-ink-300">
            Audio is analysed on your device with Spotify’s Basic Pitch neural network. Nothing is uploaded unless you use your own processing server.
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
                onClick={() => setParams({ tab: t.id })}
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
                <Toggle
                  label="Isolate the piano part first"
                  hint={backend.health?.features.separation ? 'Uses Demucs on your processing server — slower, much cleaner for full songs.' : 'Requires a processing server with Demucs (Settings → Processing server).'}
                  checked={separate && !!backend.health?.features.separation}
                  onChange={setSeparate}
                  disabled={!backend.health?.features.separation}
                />
                <p className="text-[12px] text-ink-400">Up to 20 minutes / 300 MB. Longer files: trim first. Video files use their audio track.</p>
              </div>
            )}
            {tab === 'youtube' && (
              <div className="flex flex-col gap-5">
                <YouTubeTab busy={busy} />
                <DetectionOptions />
              </div>
            )}
            {tab === 'midi' && (
              <div className="flex flex-col gap-3">
                <Dropzone onFile={onFile}>
                  <p className="text-[15px] font-medium text-ink-50">Drop a MIDI file (.mid, .midi)</p>
                  <p className="text-[12.5px] text-ink-300">Notes, velocities, sustain pedal and tempo are imported exactly.</p>
                </Dropzone>
              </div>
            )}
            {tab === 'record' && <RecordTab busy={busy} />}
          </div>
        </div>
      </div>
    </div>
  );
}
