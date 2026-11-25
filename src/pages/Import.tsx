import { Suspense, lazy, useEffect, useRef, useState, type ComponentType } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { FileAudio, FileMusic, Mic, Square, Smartphone, MonitorSpeaker } from 'lucide-react';
import { Dropzone } from '../components/import/Dropzone';
import { SeparationOption, useSeparationChoice } from '../components/import/SeparationOption';
import { PianoModelOption, usePianoBlendChoice, usePianoModelChoice } from '../components/import/PianoModelOption';
import type { TranscriptionEngine } from '../lib/transcription/pipeline';
import { Button, cn } from '../components/ui';
import { transcriberChoice, useImport, type PresetId } from '../state/importStore';
import { JobProgress } from '../components/import/JobProgress';
import { DetectionOptions } from '../components/import/DetectionOptions';
import { SheetMusicTab } from '../components/import/SheetMusicTab';
import { HandsVideoImport } from '../components/import/HandsVideoImport';
import { useSettings } from '../state/settingsStore';
import { NO_SOUND_SHARED, TERMS_NOTE, startTabAudioCapture, tabAudioSupport, type TabAudioCapture } from '../lib/audio/tabAudio';
import { formatTime } from '../lib/music/theory';
import { toast } from '../state/toastStore';
import { createScreenWakeLock, isTouchDevice } from '../lib/wakeLock';
import { audioSessionForRecording } from '../lib/audio/audioSession';
import { holdReload } from '../lib/newVersion';

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
      ? 'Another song is still being worked on. Wait for it to finish (it’s shown above).'
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


/** What went wrong with the microphone, in plain words (the browser's own message is technical). */
function micProblem(e: unknown): string {
  const name = (e as { name?: string } | null)?.name ?? '';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found. Check that one is connected and allowed for this site.';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'The microphone isn’t allowed for this site. Allow it in your browser’s settings, then try again.';
  if (name === 'NotReadableError' || name === 'AbortError') return 'The microphone couldn’t start. Close other apps that use it, then try again.';
  return 'The microphone couldn’t start. Check that one is connected and allowed for this site.';
}

function RecordTab({ busy }: { busy: boolean }) {
  const [rec, setRec] = useState<{ r: MediaRecorder; start: number; stream: MediaStream } | null>(null);
  const chunks = useRef<Blob[]>([]);
  const [, tick] = useState(0);
  const importBlob = useImport((s) => s.importAudioBlob);
  // "Remove singing and drums" for the recording (Piano solo's remembered choice; read at stop time)
  const sep = useSeparationChoice('piano');
  const model = usePianoModelChoice(true);
  const separateRef = useRef(sep.checked);
  separateRef.current = sep.checked;
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
        // the current preset with Basic Pitch, or (ticked below) the high-accuracy piano model and / or
        // "Remove singing and drums" with the "Piano solo" preset; read at stop time so a tick during
        // the recording counts
        const transcriber = transcriberChoice(useImport.getState().prefs, 'piano');
        const separate = separateRef.current;
        const piano = transcriber === 'piano-specialist' || separate;
        void importBlob(blob, {
          title: `Recording ${new Date().toLocaleString()}`,
          source: { kind: 'capture', mimeType: blob.type, fileSize: blob.size },
          transcriber,
          ...(piano ? { presetId: 'piano' as const } : {}),
          ...(separate ? { separate: true } : {}),
        });
        // the import has asked for its own lock by now (importStore.ts)
        void wake.hold(false);
      };
      r.start(500);
      live.current = { r, stream, endSession };
      setRec({ r, start: Date.now(), stream });
    } catch (e) {
      endSession();
      void wake.hold(false);
      toast.error('Microphone unavailable', micProblem(e));
    }
  };
  return (
    <div className="flex flex-col items-center gap-4 py-8 text-center">
      <p className="max-w-md text-[13px] text-ink-300">Play piano (or anything) into your mic. A quiet room and the mic up close work best.</p>
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
      {/* the options sit below the button, so "Start recording" stays in view on a phone; both are read at
          stop time, so a tick while recording still counts */}
      <PianoModelOption alwaysOffered className="w-full max-w-md" />
      <SeparationOption preset="piano" pianoModel={model.transcriber === 'piano-specialist'} className="w-full max-w-md text-left" />
    </div>
  );
}

export default function ImportPage() {
  const [params] = useSearchParams();
  const tab: Tab = (params.get('tab') as Tab) || 'audio';
  const job = useImport((s) => s.job);
  const failed = useImport((s) => s.failed);
  const cancel = useImport((s) => s.cancel);
  const clear = useImport((s) => s.clear);
  // a failed high-accuracy run: offer the fast model while the high-accuracy one is still selected
  const pianoModelSelected = useImport((s) => s.prefs.pianoModel === true);
  const importFile = useImport((s) => s.importFile);
  const navigate = useNavigate();
  const preset = useSettings((s) => s.detectionPreset) as PresetId;
  const setSettings = useSettings((s) => s.set);
  const detection = <DetectionOptions value={preset} onChange={(v) => setSettings({ detectionPreset: v })} />;
  const sep = useSeparationChoice();
  const model = usePianoModelChoice();
  const blend = usePianoBlendChoice();
  // (the piano model is only offered with Piano solo, where separation is "Remove singing and drums": both work together)
  const pianoModel = model.transcriber === 'piano-specialist';
  const separate = sep.checked;
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
    // (an "Analyze again" started in the Studio stays there: its card says where the song is)
    if (busy && startedHere.current === null && job && !job.reanalyze) startedHere.current = job.id;
  }, [busy, job]);

  const onFile = (f: File) => {
    if (busy) return;
    void importFile(f, { separate, transcriber: model.transcriber, pianoBlend: blend.offered && blend.checked }).then(() => {});
    startedHere.current = (useImport.getState().job?.id ?? 0);
  };
  /** a video of the user playing: solo piano, no separation, the video kept with the song */
  const onHandsVideo = (f: File, keep: boolean) => {
    if (busy) return;
    void importFile(f, { separate: false, transcriber: transcriberChoice(useImport.getState().prefs, 'piano', model.support.available), keepVideo: keep, presetId: 'piano' }).then(() => {});
    startedHere.current = useImport.getState().job?.id ?? 0;
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
            Your song is worked out right here on your device. Nothing gets uploaded (unless you set up your own server in Settings).
            The notes are a best guess, so check them against the song.{' '}
            <Link to="/accuracy" className="text-accent-400 hover:text-accent-300">
              How close does it get?
            </Link>
          </p>
        </header>

        {job && (
          <JobProgress
            job={job}
            failed={failed}
            onCancel={cancel}
            onDismiss={clear}
            onOpen={(songId) => navigate(`/studio/${songId}`)}
            onPlayGame={openGame}
            pianoModelSelected={pianoModelSelected}
          />
        )}
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
                <HandsVideoImport busy={busy} pianoModelOn={pianoModel} onVideo={onHandsVideo} />
                {detection}
                <SeparationOption pianoModel={pianoModel} />
                <p className="text-[12px] text-ink-400">Up to 20 minutes / 300 MB (videos of you playing: up to 4 GB). Longer files: trim first. Video files use their audio track.</p>
              </div>
            )}
            {tab === 'computer' && (
              <div className="flex flex-col gap-5">
                <ComputerTab busy={busy} separate={separate} transcriber={model.transcriber} />
                {tabAudioSupport() === 'ok' && (
                  <>
                    {detection}
                    <SeparationOption pianoModel={pianoModel} />
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
