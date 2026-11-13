/**
 * "Play a game while you wait": a full-screen layer over the import page with two small piano games
 * (Note Hopper, Key Snake) and the import's progress along the top. Loaded only when opened (its own
 * chunk). When the import ends it says so over the game ("Your song is ready" / failed / canceled)
 * and pauses the game; the import page does not jump to the Studio while this is open.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CheckCircle2, ChevronLeft, Loader2, Pause, Play, Volume2, VolumeX, X, XCircle } from 'lucide-react';
import { useImport } from '../../state/importStore';
import { useSettings } from '../../state/settingsStore';
import { isTouchDevice } from '../../lib/wakeLock';
import { gameFps } from '../../lib/games/loop';
import { createGameSynth, type GameSynth } from '../../lib/games/synth';
import { loadBest, loadSoundOn, saveBest, saveSoundOn, type GameId } from '../../lib/games/offer';
import { Button, ProgressBar, cn } from '../ui';
import { GameStage, type StageHandle, type StageState } from './GameStage';
import { createNoteHopper } from './noteHopperEngine';
import { createKeySnake } from './keySnakeEngine';
import type { GameEngine, GameInput } from './engine';

type ImportStatus = 'running' | 'done' | 'failed' | 'canceled';

const GAMES: Record<GameId, { name: string; blurb: string; touchHint: string; keyHint: string }> = {
  'note-hopper': {
    name: 'Note Hopper',
    blurb: 'Hop through the gaps between the keys. Every gap plays the next note of a tune.',
    touchHint: 'Tap to hop',
    keyHint: 'Space, ↑ or click to hop',
  },
  'key-snake': {
    name: 'Key Snake',
    blurb: 'Steer a line of notes over the keys and eat the next note of the tune. Don’t hit the edge or yourself.',
    touchHint: 'Swipe or use the arrows to steer',
    keyHint: 'Arrow keys or WASD to steer',
  },
};

const hopperKeys = (e: KeyboardEvent): GameInput | null =>
  e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W' ? { kind: 'press' } : null;

const snakeKeys = (e: KeyboardEvent): GameInput | null => {
  switch (e.key) {
    case 'ArrowUp':
    case 'w':
    case 'W':
      return { kind: 'dir', dir: 'up' };
    case 'ArrowDown':
    case 's':
    case 'S':
      return { kind: 'dir', dir: 'down' };
    case 'ArrowLeft':
    case 'a':
    case 'A':
      return { kind: 'dir', dir: 'left' };
    case 'ArrowRight':
    case 'd':
    case 'D':
      return { kind: 'dir', dir: 'right' };
    case ' ':
    case 'Enter':
      return { kind: 'press' };
    default:
      return null;
  }
};

function prefersReducedMotion(): boolean {
  try {
    return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || useSettings.getState().reducedMotion;
  } catch {
    return false;
  }
}

export default function GameOverlay({ jobId, onClose, onOpenSong }: { jobId: number; onClose: () => void; onOpenSong: (songId: string) => void }) {
  const job = useImport((s) => s.job);
  const status: ImportStatus = !job || job.id !== jobId ? 'canceled' : job.stage === 'done' ? 'done' : job.stage === 'error' ? 'failed' : 'running';
  const [touch] = useState(isTouchDevice);
  const [reducedMotion] = useState(prefersReducedMotion);
  const [game, setGame] = useState<GameId | null>(null);
  const [paused, setPaused] = useState(false);
  const [soundOn, setSoundOn] = useState(loadSoundOn);
  const [stage, setStage] = useState<StageState>({ phase: 'ready', score: 0 });
  const [best, setBest] = useState(0);
  const [newBest, setNewBest] = useState(false);
  const [notice, setNotice] = useState<ImportStatus | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const stageHandle = useRef<StageHandle | null>(null);

  const synth = useRef<GameSynth | null>(null);
  if (!synth.current) synth.current = createGameSynth(!soundOn);
  useEffect(() => {
    const s = synth.current;
    return () => s?.close();
  }, []);

  // the import ended (or was canceled) while playing: say so and pause the game
  const lastStatus = useRef(status);
  useEffect(() => {
    if (status === lastStatus.current) return;
    lastStatus.current = status;
    if (status !== 'running') {
      setNotice(status);
      setPaused(true);
    }
  }, [status]);

  const engine = useMemo<GameEngine | null>(() => {
    if (!game) return null;
    const opts = { synth: synth.current!, reducedMotion };
    return game === 'note-hopper' ? createNoteHopper(opts) : createKeySnake(opts);
  }, [game, reducedMotion]);

  const phaseRef = useRef<StageState['phase']>('ready');
  const pick = (g: GameId | null) => {
    phaseRef.current = 'ready';
    setGame(g);
    setStage({ phase: 'ready', score: 0 });
    setPaused(false);
    setNewBest(false);
    if (g) setBest(loadBest(g));
  };

  const onState = useCallback(
    (s: StageState) => {
      // a new run starts unpaused (a pause from a hidden page before it began doesn't carry over)
      if (s.phase === 'playing' && phaseRef.current !== 'playing') setPaused(false);
      phaseRef.current = s.phase;
      setStage(s);
      if (s.phase === 'over' && game) {
        const before = loadBest(game);
        setBest(saveBest(game, s.score));
        setNewBest(s.score > before);
      }
      if (s.phase === 'ready') setNewBest(false);
    },
    [game],
  );

  const playing = stage.phase === 'playing';
  /** a pause only holds a run in progress; the import's notice holds everything */
  const held = (paused && playing) || !!notice;

  // a hidden page (app switch, locked screen) pauses a run
  useEffect(() => {
    const vis = () => {
      if (document.visibilityState === 'hidden') setPaused(true);
    };
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  }, []);

  // focus: into the layer on open, back where it was on close
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      if (before?.isConnected) before.focus();
      else document.querySelector<HTMLElement>('[data-import-card]')?.focus();
    };
  }, []);
  // a new screen inside the layer: focus its first control
  useEffect(() => {
    const t = setTimeout(() => {
      const el = root.current?.querySelector<HTMLElement>(notice ? '[data-notice-focus]' : game ? '[role="application"]' : '[data-autofocus]');
      el?.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(t);
  }, [game, notice]);

  const toggleSound = () => {
    const on = !soundOn;
    setSoundOn(on);
    saveSoundOn(on);
    synth.current?.setMuted(!on);
  };

  const togglePause = useCallback(() => {
    if (notice) return;
    setPaused((p) => !p);
  }, [notice]);

  // keys for the layer: Escape pauses a run (or closes), P pauses, Tab stays inside
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (notice) setNotice(null);
        else if (game && playing && !paused) setPaused(true);
        else onClose();
      } else if ((e.key === 'p' || e.key === 'P') && game && playing) {
        e.preventDefault();
        togglePause();
      } else if (e.key === 'Tab' && root.current) {
        const els = [...root.current.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex="0"]')].filter((el) => el.offsetParent !== null);
        if (!els.length) return;
        const first = els[0];
        const lastEl = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [notice, game, playing, paused, onClose, togglePause]);

  const keepPlaying = () => setNotice(null);
  const songId = status === 'done' ? job?.songId : undefined;
  const info = game ? GAMES[game] : null;

  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={info ? info.name : 'Games'}
      className="animate-fade-in fixed inset-0 z-[58] flex flex-col bg-ink-950"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
        overscrollBehavior: 'contain',
      }}
    >
      {/* top bar: back / close, the import's progress, sound and pause */}
      <div className="flex items-center gap-2 border-b border-ink-800 px-2 py-2 sm:px-4">
        {game ? (
          <IconBtn label="All games" onClick={() => pick(null)}>
            <ChevronLeft size={20} />
          </IconBtn>
        ) : (
          <IconBtn label="Close games" onClick={onClose}>
            <X size={20} />
          </IconBtn>
        )}
        <ImportLine status={status} title={job?.id === jobId ? job.title : ''} progress={job?.id === jobId ? job.progress : null} songId={songId} onOpenSong={onOpenSong} />
        <IconBtn label={soundOn ? 'Turn sound off' : 'Turn sound on'} pressed={!soundOn} onClick={toggleSound}>
          {soundOn ? <Volume2 size={19} /> : <VolumeX size={19} />}
        </IconBtn>
        {game && (
          <IconBtn label={paused ? 'Resume' : 'Pause'} onClick={togglePause} disabled={!playing || !!notice}>
            {paused ? <Play size={19} /> : <Pause size={19} />}
          </IconBtn>
        )}
        {game && (
          <IconBtn label="Close games" onClick={onClose}>
            <X size={20} />
          </IconBtn>
        )}
      </div>

      {!game || !engine || !info ? (
        <Picker touch={touch} onPick={pick} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col px-3 pt-2 pb-3 sm:px-6 sm:pb-6">
          <div className="mx-auto flex w-full max-w-5xl items-baseline justify-between px-1 pb-2">
            <h2 className="text-[15px] font-semibold text-ink-50">{info.name}</h2>
            <p className="font-mono text-[13px] text-ink-200">
              <span className="sr-only">Score </span>
              <span className="text-[18px] font-semibold text-ink-50">{stage.score}</span>
              <span className="ml-3 text-ink-300">Best {Math.max(best, stage.score)}</span>
            </p>
          </div>
          <div className="relative mx-auto min-h-0 w-full max-w-5xl flex-1">
            <GameStage
              engine={engine}
              paused={held}
              fps={gameFps(touch)}
              touch={touch}
              swipe={game === 'key-snake'}
              keyInput={game === 'key-snake' ? snakeKeys : hopperKeys}
              onState={onState}
              handle={stageHandle}
              label={`${info.name}. ${touch ? info.touchHint : info.keyHint}.`}
            />
            {stage.phase === 'ready' && !notice && (
              <div className="pointer-events-none absolute inset-x-0 top-[38%] flex justify-center px-4">
                <p className="rounded-full bg-ink-900/90 px-4 py-2 text-[14px] font-medium text-ink-50 ring-1 ring-ink-600">{touch ? info.touchHint : info.keyHint}</p>
              </div>
            )}
            {stage.phase === 'over' && !notice && (
              <Panel role="status">
                <p className="text-[13px] font-medium tracking-wide text-ink-300 uppercase">Game over</p>
                <p className="mt-1 text-[32px] leading-none font-semibold text-ink-50">{stage.score}</p>
                <p className="mt-2 text-[13px] text-ink-200">{newBest ? 'New best score!' : `Best ${best}`}</p>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  <Button variant="primary" size="lg" data-notice-focus onClick={() => stageHandle.current?.restart()} icon={<Play size={16} />}>
                    Play again
                  </Button>
                  <Button size="lg" onClick={() => pick(null)}>
                    Other game
                  </Button>
                </div>
              </Panel>
            )}
            {paused && !notice && playing && (
              <Panel>
                <p className="text-[17px] font-semibold text-ink-50">Paused</p>
                <div className="mt-4 flex flex-wrap justify-center gap-2">
                  <Button variant="primary" size="lg" data-notice-focus autoFocus onClick={() => setPaused(false)} icon={<Play size={16} />}>
                    Resume
                  </Button>
                  <Button size="lg" onClick={onClose}>
                    Back to import
                  </Button>
                </div>
              </Panel>
            )}
            {notice && <ImportNotice status={notice} error={job?.id === jobId ? job.error : undefined} songId={songId} onOpenSong={onOpenSong} onBack={onClose} onKeepPlaying={keepPlaying} />}
          </div>
          {game === 'key-snake' && touch && <DPad onDir={(dir) => stageHandle.current?.input({ kind: 'dir', dir })} />}
        </div>
      )}
      {!game && notice && (
        <div className="absolute inset-x-0 top-[61px] bottom-0">
          <ImportNotice status={notice} error={job?.id === jobId ? job.error : undefined} songId={songId} onOpenSong={onOpenSong} onBack={onClose} onKeepPlaying={keepPlaying} />
        </div>
      )}
    </div>
  );
}

function IconBtn({ label, onClick, children, pressed, disabled }: { label: string; onClick: () => void; children: React.ReactNode; pressed?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className="focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-ink-200 transition-colors hover:bg-ink-800 hover:text-ink-50 disabled:opacity-35"
      style={{ touchAction: 'manipulation' }}
    >
      {children}
    </button>
  );
}

function Panel({ children, role }: { children: React.ReactNode; role?: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-ink-950/55 p-4">
      <div role={role} className="pointer-events-auto w-full max-w-xs rounded-2xl border border-ink-600 bg-ink-850 p-5 text-center shadow-panel">
        {children}
      </div>
    </div>
  );
}

function ImportLine({ status, title, progress, songId, onOpenSong }: { status: ImportStatus; title: string; progress: number | null; songId?: string; onOpenSong: (id: string) => void }) {
  return (
    <div className="min-w-0 flex-1 px-1" aria-live="polite">
      {status === 'running' && (
        <>
          <p className="flex items-center gap-1.5 truncate text-[12.5px] text-ink-200">
            <Loader2 size={13} className="shrink-0 animate-spin text-accent-400" />
            <span className="truncate">Importing{title ? ` “${title}”` : ''}</span>
            {progress !== null && <span className="ml-auto shrink-0 font-mono text-[11.5px] text-ink-300">{Math.round(progress * 100)}%</span>}
          </p>
          <div className="mt-1.5">
            <ProgressBar value={progress} />
          </div>
        </>
      )}
      {status === 'done' && (
        <div className="flex items-center gap-2">
          <CheckCircle2 size={15} className="shrink-0 text-ok" />
          <span className="truncate text-[13px] font-medium text-ink-50">
            {songId ? <span className="sm:hidden">Ready</span> : null}
            <span className={songId ? 'hidden sm:inline' : undefined}>Your song is ready</span>
          </span>
          {songId && (
            <Button size="sm" variant="primary" className="ml-auto" onClick={() => onOpenSong(songId)}>
              Open song
            </Button>
          )}
        </div>
      )}
      {status === 'failed' && (
        <p className="flex items-center gap-1.5 text-[13px] font-medium text-bad">
          <XCircle size={15} className="shrink-0" /> The import failed
        </p>
      )}
      {status === 'canceled' && <p className="text-[13px] font-medium text-ink-300">The import was canceled</p>}
    </div>
  );
}

function ImportNotice({
  status,
  error,
  songId,
  onOpenSong,
  onBack,
  onKeepPlaying,
}: {
  status: ImportStatus;
  error?: string;
  songId?: string;
  onOpenSong: (id: string) => void;
  onBack: () => void;
  onKeepPlaying: () => void;
}) {
  return (
    <Panel role="alert">
      {status === 'done' ? (
        <>
          <CheckCircle2 size={28} className="mx-auto text-ok" />
          <p className="mt-2 text-[18px] font-semibold text-ink-50">Your song is ready</p>
          <div className="mt-4 flex flex-col gap-2">
            {songId && (
              <Button variant="primary" size="lg" data-notice-focus onClick={() => onOpenSong(songId)}>
                Open song
              </Button>
            )}
            <Button size="lg" onClick={onKeepPlaying}>
              Keep playing
            </Button>
          </div>
        </>
      ) : (
        <>
          <XCircle size={28} className={cn('mx-auto', status === 'failed' ? 'text-bad' : 'text-ink-300')} />
          <p className="mt-2 text-[18px] font-semibold text-ink-50">{status === 'failed' ? 'The import failed' : 'The import was canceled'}</p>
          {status === 'failed' && error && <p className="mt-2 line-clamp-4 text-[13px] text-ink-200">{error}</p>}
          <div className="mt-4 flex flex-col gap-2">
            <Button variant="primary" size="lg" data-notice-focus onClick={onBack}>
              Back to import
            </Button>
            <Button size="lg" onClick={onKeepPlaying}>
              Keep playing
            </Button>
          </div>
        </>
      )}
    </Panel>
  );
}

function Picker({ touch, onPick }: { touch: boolean; onPick: (g: GameId) => void }) {
  const ids: GameId[] = ['note-hopper', 'key-snake'];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5" style={{ touchAction: 'pan-y' }}>
      <div className="mx-auto max-w-2xl">
        <h2 className="text-[20px] font-semibold text-ink-50">Play a game while you wait</h2>
        <p className="mt-1 text-[13px] text-ink-300">The import keeps going. We’ll tell you when your song is ready.</p>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          {ids.map((id, i) => (
            <button
              key={id}
              type="button"
              data-autofocus={i === 0 ? true : undefined}
              onClick={() => onPick(id)}
              className="focus-ring flex flex-col gap-3 rounded-2xl border border-ink-700 bg-ink-850 p-4 text-left transition-colors hover:border-accent-600 hover:bg-ink-800"
              style={{ touchAction: 'manipulation' }}
            >
              {id === 'note-hopper' ? <HopperIcon /> : <SnakeIcon />}
              <span>
                <span className="block text-[16px] font-semibold text-ink-50">{GAMES[id].name}</span>
                <span className="mt-1 block text-[13px] leading-snug text-ink-200">{GAMES[id].blurb}</span>
                <span className="mt-2 flex items-center justify-between gap-2 text-[12px] text-ink-300">
                  <span>{touch ? GAMES[id].touchHint : GAMES[id].keyHint}</span>
                  <span className="font-mono">Best {loadBest(id)}</span>
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function DPad({ onDir }: { onDir: (d: 'up' | 'down' | 'left' | 'right') => void }) {
  const btn = (d: 'up' | 'down' | 'left' | 'right', icon: React.ReactNode, label: string) => (
    <button
      type="button"
      aria-label={label}
      onPointerDown={(e) => {
        e.preventDefault();
        onDir(d);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onDir(d);
        }
      }}
      className="focus-ring flex h-14 w-16 items-center justify-center rounded-2xl border border-ink-600 bg-ink-800 text-ink-100 active:bg-accent-700"
      style={{ touchAction: 'none' }}
    >
      {icon}
    </button>
  );
  return (
    <div className="mx-auto mt-3 grid grid-cols-3 gap-1.5" style={{ touchAction: 'none' }}>
      <span />
      {btn('up', <ArrowUp size={22} />, 'Up')}
      <span />
      {btn('left', <ArrowLeft size={22} />, 'Left')}
      {btn('down', <ArrowDown size={22} />, 'Down')}
      {btn('right', <ArrowRight size={22} />, 'Right')}
    </div>
  );
}

function HopperIcon() {
  return (
    <svg width="64" height="40" viewBox="0 0 64 40" aria-hidden="true">
      <rect x="0" y="0" width="64" height="40" rx="8" fill="#0c0c10" />
      <rect x="40" y="0" width="9" height="13" fill="#b4b4c2" />
      <rect x="40" y="12" width="9" height="2" fill="#6d8cff" />
      <rect x="40" y="27" width="9" height="13" fill="#b4b4c2" />
      <rect x="40" y="27" width="9" height="2" fill="#6d8cff" />
      <ellipse cx="20" cy="23" rx="4.6" ry="3.4" transform="rotate(-22 20 23)" fill="#8aa2ff" />
      <path d="M24 22 V11 q1 4 5 5" stroke="#8aa2ff" strokeWidth="1.6" fill="none" />
    </svg>
  );
}

function SnakeIcon() {
  return (
    <svg width="64" height="40" viewBox="0 0 64 40" aria-hidden="true">
      <rect x="0" y="0" width="64" height="40" rx="8" fill="#0c0c10" />
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <rect key={i} x={i * 8} y="0" width="8" height="30" fill={i % 2 ? '#111116' : '#15151b'} />
      ))}
      {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
        <rect key={`k${i}`} x={i * 8 + 0.5} y="31" width="7" height="9" fill="#dcdce4" />
      ))}
      <rect x="9" y="17" width="6" height="6" rx="2" fill="#4258bd" />
      <rect x="17" y="17" width="6" height="6" rx="2" fill="#5672e8" />
      <rect x="25" y="17" width="6" height="6" rx="2" fill="#6d8cff" />
      <rect x="25" y="9" width="6" height="6" rx="2" fill="#a9bbff" />
      <ellipse cx="44" cy="12" rx="2.8" ry="2.1" transform="rotate(-22 44 12)" fill="#f5a524" />
      <rect x="46" y="5" width="1.2" height="7" fill="#f5a524" />
    </svg>
  );
}
