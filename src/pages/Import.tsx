import { Suspense, lazy, useEffect, useRef, useState, type ComponentType } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { FileAudio, FileMusic, Mic, Loader2, CheckCircle2, XCircle, Circle, ArrowRight, Square, Info, RotateCcw, Download, Smartphone, MonitorSpeaker, Gamepad2 } from 'lucide-react';
import { Dropzone } from '../components/import/Dropzone';
import { SeparationOption, useSeparationChoice } from '../components/import/SeparationOption';
import { PianoModelOption, usePianoModelChoice } from '../components/import/PianoModelOption';
import type { TranscriptionEngine } from '../lib/transcription/pipeline';
import { Button, ProgressBar, Segmented, cn } from '../components/ui';
import { STAGE_LABELS, stageLabel, useImport, type ImportJob, type ImportStage } from '../state/importStore';
import { SheetMusicTab } from '../components/import/SheetMusicTab';
import { useSettings } from '../state/settingsStore';
import { NO_SOUND_SHARED, TERMS_NOTE, startTabAudioCapture, tabAudioSupport, type TabAudioCapture } from '../lib/audio/tabAudio';
import { formatTime } from '../lib/music/theory';
import { toast } from '../state/toastStore';
import { createScreenWakeLock, isTouchDevice } from '../lib/wakeLock';
import { saveBlobAs } from '../lib/saveBlob';
import { audioSessionForRecording } from '../lib/audio/audioSession';
import { holdReload } from '../lib/newVersion';
import { offerGame } from '../lib/games/offer';

// the mini-games load only when opened (their own chunk); offline, the button just says so
const GameOverlay = lazy<ComponentType<{ jobId: number; onClose: () => void; onOpenSong: (songId: string) => void }>>(() =>
  import('../components/games/GameOverlay').catch(() => ({
    default: function GamesUnavailable({ onClose }: { onClose: () => void }) {
      useEffect(() => {
        toast.error('Couldn’t load the games', 'Check your connection and try again.');
        onClose();
      }, [onClose]);
      return null;
    },
  })),
);

type Tab = 'audio' | 'computer' | 'midi' | 'record';

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
/** "reading: 1 min left" → "Reading: 1 min left" (the sheet reader's plain progress line) */
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function etaStep(job: Pick<ImportJob, 'stage' | 'detail' | 'transcriber' | 'sheet'>): string {
  const part = job.detail?.match(/\((\d+) of (\d+)\)/);
  if (job.sheet) return job.stage === 'analyzing' ? 'reading' : job.stage === 'loading-model' ? 'download' : stageLabel(job, job.stage).toLowerCase();
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

function JobProgress({ onPlayGame }: { onPlayGame: () => void }) {
  const job = useImport((s) => s.job);
  const cancel = useImport((s) => s.cancel);
  const clear = useImport((s) => s.clear);
  const failed = useImport((s) => s.failed);
  // a failed high-accuracy run: offer the fast model while the high-accuracy one is still selected
  const pianoModelSelected = useImport((s) => s.prefs.pianoModel === true);
  const navigate = useNavigate();
  const [touch] = useState(isTouchDevice);
  const [, force] = useState(0);
  // a new import: bring its card into view (on a phone the button that started it is far below)
  const card = useRef<HTMLDivElement>(null);
  const jobId = job?.id;
  useEffect(() => {
    if (jobId !== undefined) card.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [jobId]);
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
    <div ref={card} data-import-card tabIndex={-1} className="panel animate-fade-in scroll-mt-4 p-5 outline-none" aria-live="polite">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold text-ink-50">{job.title}</p>
          <p className="mt-0.5 text-[12.5px] text-ink-300">
            {done ? (job.kind === 'score' || job.kind === 'midi' ? 'Ready' : 'Transcription complete') : err ? 'Import failed' : job.detail ? `${job.detail}${job.sheet && job.stage !== 'saving' ? '…' : ''}` : stageLabel(job, job.stage)} · {formatTime(elapsed)}
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
          {touch && job.kind !== 'midi' && job.kind !== 'demo' && (job.kind !== 'score' || job.sheet) && (
            <p className="mt-2 flex items-center gap-1.5 text-[12px] text-ink-300">
              <Smartphone size={13} className="shrink-0 text-accent-400" /> {job.sheet ? 'Keep this page open while it reads the music.' : 'Keep this page open while it’s analyzing.'}
            </p>
          )}
          {job.progress !== null && (
            <p className={cn('mt-1.5 flex justify-between gap-3 text-ink-300', job.sheet ? 'text-[12px]' : 'font-mono text-[11px]')}>
              <span>
                {job.sheet
                  ? sentence(eta ?? (job.stage === 'analyzing' && job.progress < 0.99 ? 'Working out the time left…' : ''))
                  : (eta ?? ((job.stage === 'separating' || job.stage === 'analyzing') && job.progress < 0.99 ? `${etaStep(job)}: measuring speed…` : ''))}
              </span>
              <span>{Math.round(job.progress * 100)}%</span>
            </p>
          )}
          {offerGame(job, Date.now()) && (
            <Button size="sm" className="mt-3" onClick={onPlayGame} icon={<Gamepad2 size={15} />}>
              Play a game while you wait
            </Button>
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
              <span className={state === 'todo' ? 'text-ink-400' : 'text-ink-100'}>{stageLabel(job, st)}</span>
            </li>
          );
        })}
      </ol>
      {err && <p className="mt-4 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-[13px] text-bad">{job.error}</p>}
      {done && job.sheet && (
        <p className="mt-4 flex gap-2 text-[12.5px] text-ink-200">
          <Info size={14} className="mt-0.5 shrink-0 text-warn" /> Read from sheet music{job.sheetReader === 'accurate' ? '' : ' (Beta)'} — check the notes against your page.
        </p>
      )}
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
          {err && failedHere?.retryQuick && (
            <Button onClick={() => void failedHere.retryQuick!()} icon={<RotateCcw size={15} />}>
              Use the Quick reader
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

/** A link to another tab of this page. */
function TabLink({ tab, children }: { tab: Tab; children: string }) {
  return (
    <Link to={`/import?tab=${tab}`} className="font-medium text-accent-400 hover:text-accent-300">
      {children}
    </Link>
  );
}

/**
 * Record what is playing on this computer: the sound of another tab (or app) through the browser's
 * screen-sharing dialog (src/lib/audio/tabAudio.ts). Phones can't share sound with a web page, so
 * there this tab explains the other ways.
 */
function ComputerTab({ busy, separate, transcriber }: { busy: boolean; separate: boolean; transcriber: TranscriptionEngine }) {
  const [support] = useState(tabAudioSupport);
  const [name, setName] = useState('');
  const [rights, setRights] = useState(false);
  const [rec, setRec] = useState<{ start: number } | null>(null);
  const capture = useRef<TabAudioCapture | null>(null);
  const [, tick] = useState(0);
  const importBlob = useImport((s) => s.importAudioBlob);
  useEffect(() => {
    if (!rec) return;
    const t = setInterval(() => tick((x) => x + 1), 250);
    return () => clearInterval(t);
  }, [rec]);
  // while recording, a new version going online must not reload the page (src/lib/newVersion.ts)
  useEffect(() => (rec ? holdReload(() => 'Stop recording first, then reload.') : undefined), [rec]);
  // leaving the tab mid-recording: stop sharing, nothing is imported
  useEffect(
    () => () => {
      capture.current?.cancel();
      capture.current = null;
    },
    [],
  );

  const finish = async () => {
    const c = capture.current;
    if (!c) return;
    capture.current = null;
    setRec(null);
    const blob = await c.stop();
    if (blob.size < 2000) {
      toast.error('Nothing was recorded', 'Turn on “Share tab audio” and play the song while recording.');
      return;
    }
    const title = name.trim() || `Recording ${new Date().toLocaleString()}`;
    void importBlob(blob, { title, source: { kind: 'capture', mimeType: blob.type, fileSize: blob.size }, separate, transcriber });
  };

  const start = async () => {
    try {
      const c = await startTabAudioCapture();
      capture.current = c;
      c.onEnded(() => void finish()); // the browser's "Stop sharing" button
      setRec({ start: Date.now() });
    } catch (e) {
      const err = e as Error;
      // closing the browser's dialog (Cancel) is not an error
      if (err.message === NO_SOUND_SHARED || !/NotAllowed|Abort/i.test(err.name)) toast.error('Could not record the sound', err.message);
    }
  };

  if (support !== 'ok') {
    return (
      <div className="flex flex-col gap-3 text-[13px] leading-relaxed text-ink-200">
        {support === 'iphone' ? (
          <>
            <p className="font-medium text-ink-50">iPhone and iPad can’t share another app’s sound with a website.</p>
            <p>Use a screen recording instead:</p>
            <ol className="ml-5 list-decimal space-y-1">
              <li>Open Control Center and tap Screen Recording.</li>
              <li>Play the song in its app with the sound on, then stop the recording.</li>
              <li>
                Come back here and upload the video from Photos under <TabLink tab="audio">Audio / Video</TabLink>. Only its sound is used.
              </li>
            </ol>
            <p className="text-ink-300">Some apps mute their sound in screen recordings. Then play the song out loud and use <TabLink tab="record">Record</TabLink> with the microphone.</p>
          </>
        ) : support === 'phone' ? (
          <>
            <p className="font-medium text-ink-50">Phones can’t share another app’s sound with a website.</p>
            <p>
              Record the song with your phone’s screen recorder, then upload the video under <TabLink tab="audio">Audio / Video</TabLink>. Or play the song
              out loud and use <TabLink tab="record">Record</TabLink> with the microphone.
            </p>
          </>
        ) : (
          <>
            <p className="font-medium text-ink-50">This needs Chrome or Edge on a computer.</p>
            <p>
              This browser can’t record another tab’s sound. Open this page in Chrome or Edge, or upload a sound or video file under{' '}
              <TabLink tab="audio">Audio / Video</TabLink>.
            </p>
          </>
        )}
        <p className="text-[12px] text-ink-400">{TERMS_NOTE}</p>
      </div>
    );
  }

  const block = !rights
    ? 'Tick the box above first.'
    : busy
      ? 'Another import is still running — wait for it to finish (progress is shown above).'
      : null;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] leading-relaxed text-ink-200">
        Record a song playing in another tab. Press <b>Start recording</b>, pick the tab with the music and turn on <b>Share tab audio</b>. Then play
        the song from the beginning and press <b>Stop</b> when it ends. It records in real time.
      </p>
      <div className="flex flex-col gap-2">
        <label htmlFor="rec-name" className="text-[12.5px] font-medium text-ink-200">
          Song name (optional)
        </label>
        <input
          id="rec-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
          placeholder="Recording"
          className="focus-ring h-11 rounded-xl border border-ink-600 bg-ink-900 px-3.5 text-[14px] text-ink-50 placeholder:text-ink-400"
        />
      </div>
      <label
        className={cn(
          'flex items-start gap-2 rounded-lg border p-2.5 text-[12.5px] transition-colors',
          rights ? 'border-transparent text-ink-200' : 'border-accent-500/40 bg-accent-500/10 text-ink-100',
        )}
      >
        <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} className="mt-0.5 accent-[var(--color-accent-500)]" />
        I own this music or have permission to use it.
      </label>
      <p className="text-[12px] leading-relaxed text-ink-300">{TERMS_NOTE}</p>
      {rec ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink-700 bg-ink-900/60 p-4">
          <span className="flex items-center gap-2 text-[14px] text-ink-50">
            <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-bad" /> Recording {formatTime((Date.now() - rec.start) / 1000)}
          </span>
          <Button variant="danger" icon={<Square size={14} />} onClick={() => void finish()}>
            Stop & transcribe
          </Button>
        </div>
      ) : (
        <div>
          <Button variant="primary" disabled={!!block} onClick={() => void start()} icon={<MonitorSpeaker size={16} />}>
            Start recording
          </Button>
          {block && <p className="mt-1.5 text-[11.5px] text-ink-400">{block}</p>}
        </div>
      )}
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
  // while recording, a new version going online must not reload the page (src/lib/newVersion.ts)
  useEffect(() => (rec ? holdReload(() => 'Stop recording first, then reload.') : undefined), [rec]);
  // leaving the tab mid-recording: stop the microphone (nothing is imported) and let the screen lock
  const live = useRef<{ r: MediaRecorder; stream: MediaStream; endSession: () => void } | null>(null);
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
        l.endSession();
      }
      chunks.current = [];
      void wake.hold(false);
    },
    [wake],
  );
  const start = async () => {
    // asked for inside the tap (some browsers only grant it with a user gesture); never throws
    void wake.hold(true);
    // iPhone: the microphone needs the 'play-and-record' audio session (back to playback when stopped)
    const endSession = audioSessionForRecording();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      const r = new MediaRecorder(stream);
      chunks.current = [];
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = () => {
        live.current = null;
        stream.getTracks().forEach((t) => t.stop());
        endSession();
        const blob = new Blob(chunks.current, { type: r.mimeType || 'audio/webm' });
        // the Blob holds the data now: don't keep a second reference to every chunk
        chunks.current = [];
        // (no preset or model choice on this tab: Basic Pitch with the current preset, as always)
        void importBlob(blob, { title: `Recording ${new Date().toLocaleString()}`, source: { kind: 'capture', mimeType: blob.type, fileSize: blob.size }, transcriber: 'basic-pitch' });
        // the import has asked for its own lock by now (importStore.ts)
        void wake.hold(false);
      };
      r.start(500);
      live.current = { r, stream, endSession };
      setRec({ r, start: Date.now(), stream });
    } catch (e) {
      endSession();
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
  const tab: Tab = (params.get('tab') as Tab) || 'audio';
  const job = useImport((s) => s.job);
  const importFile = useImport((s) => s.importFile);
  const navigate = useNavigate();
  const sep = useSeparationChoice();
  const model = usePianoModelChoice();
  // the piano model is for solo piano: separation is not used with it
  const pianoModel = model.transcriber === 'piano-specialist';
  const separate = sep.checked && !pianoModel;
  const busy = !!job && job.stage !== 'done' && job.stage !== 'error';

  // "Play a game while you wait": the import it was opened for
  const [gameFor, setGameFor] = useState<number | null>(null);
  /** the import a game was played during: it doesn't jump to the studio (the game says the song is ready) */
  const gamePlayedFor = useRef<number | null>(null);
  const openGame = () => {
    if (!job) return;
    gamePlayedFor.current = job.id;
    setGameFor(job.id);
  };
  // closed while the import still runs: back to the card as before, so the finished import opens the
  // studio by itself again (one that finished while the game was open stays put: the player saw "Your
  // song is ready" and chose to stay)
  const closeGame = () => {
    setGameFor(null);
    const j = useImport.getState().job;
    if (j && j.id === gamePlayedFor.current && j.stage !== 'done' && j.stage !== 'error') gamePlayedFor.current = null;
  };

  // jump to the studio as soon as an import started on this page finishes
  const startedHere = useRef<number | null>(null);
  useEffect(() => {
    if (job?.stage === 'done' && job.songId && startedHere.current === job.id && gamePlayedFor.current !== job.id) {
      const id = job.id;
      const t = setTimeout(() => {
        if (gamePlayedFor.current !== id) navigate(`/studio/${job.songId}`);
      }, 700);
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
    { id: 'computer', label: 'Computer sound', icon: MonitorSpeaker },
    { id: 'midi', label: 'MIDI / Sheet music', icon: FileMusic },
    { id: 'record', label: 'Record', icon: Mic },
  ] as const;

  // on a phone the tabs don't all fit: scroll the open one into view (centred, so the tabs on
  // either side peek out and show that the row scrolls)
  const tabListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = tabListRef.current;
    const btn = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !btn || list.scrollWidth <= list.clientWidth) return;
    list.scrollLeft = Math.max(0, btn.offsetLeft - (list.clientWidth - btn.offsetWidth) / 2);
  }, [tab]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 px-5 py-8 md:px-10">
        <header>
          <h1 className="text-[26px] font-semibold tracking-tight text-ink-50">Import music</h1>
          <p className="mt-1 text-[14px] text-ink-300">
            Audio is analyzed on your device with Spotify’s Basic Pitch neural network (or, for solo piano, an optional high-accuracy piano model).
            Nothing is uploaded unless you use your own processing server.
            The result is an AI estimate —{' '}
            <Link to="/accuracy" className="text-accent-400 hover:text-accent-300">
              see how accurate it is
            </Link>
            .
          </p>
        </header>

        {job && <JobProgress onPlayGame={openGame} />}
        {gameFor !== null && (
          <Suspense fallback={<div className="fixed inset-0 z-[58] bg-ink-950" aria-busy="true" />}>
            <GameOverlay jobId={gameFor} onClose={closeGame} onOpenSong={(id) => navigate(`/studio/${id}`)} />
          </Suspense>
        )}

        <div className="panel overflow-hidden">
          <div ref={tabListRef} role="tablist" className="relative flex overflow-x-auto border-b border-ink-700 px-1 sm:px-2">
            {tabs.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => navigate(`/import?tab=${t.id}`)}
                className={cn(
                  'focus-ring flex h-12 shrink-0 items-center gap-2 border-b-2 px-3 text-[13.5px] font-medium whitespace-nowrap transition-colors sm:px-4',
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
            {tab === 'computer' && (
              <div className="flex flex-col gap-5">
                <ComputerTab busy={busy} separate={separate} transcriber={model.transcriber} />
                {tabAudioSupport() === 'ok' && (
                  <>
                    <DetectionOptions />
                    <SeparationOption unusedReason={pianoModel ? 'Not used with the high-accuracy piano model.' : undefined} />
                  </>
                )}
              </div>
            )}
            {tab === 'midi' && (
              <SheetMusicTab
                busy={busy}
                onScoreFile={onFile}
                onStarted={() => (startedHere.current = useImport.getState().job?.id ?? 0)}
              />
            )}
            {tab === 'record' && <RecordTab busy={busy} />}
          </div>
        </div>
      </div>
    </div>
  );
}
