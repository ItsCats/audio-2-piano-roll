/**
 * Full-screen stage for the Studio's main view (the piano roll today; any view placed inside goes
 * full screen with it). Uses the real Fullscreen API where the browser has it, and on iPhone (where
 * Safari only allows it on <video>) a fixed layer that covers the whole viewport.
 *
 * In full screen only the view and a few overlay controls show: play/pause, a seek bar, speed and
 * "Exit full screen". While playing they fade out after 3 s without a touch; a tap on the notes
 * brings them back (that tap does nothing else, not even press the control that appears under the
 * finger). Taps on the on-screen piano keys always reach the view: a child marks where its keys
 * start with `data-keys-top` (CSS px from its own top), and the bottom controls sit above that line
 * so they never cover the keys.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Maximize, Minimize2, Pause, Play, Smartphone, X } from 'lucide-react';
import { cn } from '../ui';
import { getPlayer } from '../../state/playback';
import { useTransport } from '../../state/transportStore';
import { useStudio } from '../../state/studioStore';
import { useStageFullscreen } from '../../state/fullscreenStore';
import { formatTime } from '../../lib/music/theory';
import { createScreenWakeLock, isTouchDevice } from '../../lib/wakeLock';
import {
  coverViewport,
  createAutoHide,
  createBackToExit,
  createTapGuard,
  currentFullscreenElement,
  dismissRotateHint,
  inertOutside,
  isSmallTouchScreen,
  exitNativeFullscreen,
  fullscreenSupport,
  lockPageScroll,
  onFullscreenChange,
  requestNativeFullscreen,
  rotateHintDismissed,
  shouldShowRotateHint,
  type AutoHide,
} from '../../lib/fullscreen';

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5];
const HIDE_AFTER_MS = 3000;

function usePortrait(): boolean {
  const query = () => {
    try {
      return window.matchMedia('(orientation: portrait)').matches;
    } catch {
      return window.innerHeight > window.innerWidth;
    }
  };
  const [portrait, setPortrait] = useState(query);
  useEffect(() => {
    const update = () => setPortrait(query());
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);
  return portrait;
}

/**
 * Height (CSS px) of the on-screen keys at the bottom of the view inside `wrap`, from the view's
 * `data-keys-top`; 0 for a view without keys. Follows resizes, rotation and view changes.
 */
function useKeysHeight(wrapRef: React.RefObject<HTMLDivElement | null>, active: boolean): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!active || !wrap) return;
    const measure = () => {
      const el = wrap.querySelector<HTMLElement>('[data-keys-top]');
      const top = parseFloat(el?.dataset.keysTop ?? '');
      setHeight(el && Number.isFinite(top) ? Math.max(0, Math.round(el.clientHeight - top)) : 0);
    };
    const mo = new MutationObserver(measure);
    mo.observe(wrap, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-keys-top'] });
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    measure();
    return () => {
      mo.disconnect();
      ro.disconnect();
    };
  }, [wrapRef, active]);
  return height;
}

/** Is this pointer event on the on-screen piano keys of the view (see `data-keys-top`)? */
function onKeys(e: React.PointerEvent): boolean {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-keys-top]');
  if (!el) return false;
  const top = parseFloat(el.dataset.keysTop ?? '');
  if (!Number.isFinite(top)) return false;
  return e.clientY - el.getBoundingClientRect().top >= top;
}

function SeekBar({ duration, visible, onHold }: { duration: number; visible: boolean; onHold: (held: boolean) => void }) {
  const barRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);
  const dragging = useRef(false);
  const player = getPlayer();

  // follows the song only while the controls show (no work behind hidden controls)
  useEffect(() => {
    if (!visible) return;
    let raf = 0;
    let lastText = '';
    let lastTime = -1;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const time = Math.max(0, player.getVisualTime());
      if (time === lastTime) return;
      lastTime = time;
      const f = duration ? Math.min(1, time / duration) : 0;
      if (fillRef.current) fillRef.current.style.width = `${f * 100}%`;
      if (thumbRef.current) thumbRef.current.style.left = `${f * 100}%`;
      const text = formatTime(time);
      if (text !== lastText && timeRef.current) {
        lastText = text;
        timeRef.current.textContent = text;
        barRef.current?.setAttribute('aria-valuenow', String(Math.round(time)));
        barRef.current?.setAttribute('aria-valuetext', `${text} of ${formatTime(duration)}`);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [duration, player, visible]);

  const seekTo = (clientX: number) => {
    const r = barRef.current!.getBoundingClientRect();
    player.seek(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration);
  };
  const end = () => {
    if (!dragging.current) return;
    dragging.current = false;
    onHold(false);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const t = player.getTime();
    let to: number | null = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') to = t - (e.shiftKey ? 1 : 5);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') to = t + (e.shiftKey ? 1 : 5);
    else if (e.key === 'Home') to = 0;
    else if (e.key === 'End') to = duration;
    if (to === null) return;
    e.preventDefault();
    e.stopPropagation(); // the Studio's own arrow-key seek would move a second time
    player.seek(Math.max(0, Math.min(duration, to)));
  };

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5">
      <span ref={timeRef} className="w-10 shrink-0 text-right font-mono text-[12px] text-white tabular-nums">
        0:00
      </span>
      <div
        ref={barRef}
        role="slider"
        tabIndex={0}
        aria-label="Song position"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        className="focus-ring group relative flex h-11 min-w-0 flex-1 cursor-pointer touch-none items-center rounded-md"
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          dragging.current = true;
          onHold(true);
          seekTo(e.clientX);
        }}
        onPointerMove={(e) => dragging.current && seekTo(e.clientX)}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={onKeyDown}
      >
        <div className="pointer-events-none relative h-1 w-full overflow-hidden rounded-full bg-white/25">
          <div ref={fillRef} className="absolute inset-y-0 left-0 bg-accent-400" />
        </div>
        <div
          ref={thumbRef}
          className="pointer-events-none absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_8px_rgba(0,0,0,0.6)]"
        />
      </div>
      <span className="w-10 shrink-0 font-mono text-[12px] text-white/70 tabular-nums">{formatTime(duration)}</span>
    </div>
  );
}

const pill = 'focus-ring pointer-events-auto flex h-11 shrink-0 items-center justify-center gap-2 rounded-full bg-black/55 px-4 text-[13px] font-medium text-white ring-1 ring-white/15 backdrop-blur-md hover:bg-black/75';

function Controls({ auto, visible, keysHeight, onExit }: { auto: AutoHide; visible: boolean; keysHeight: number; onExit: () => void }) {
  const playing = useTransport((s) => s.playing);
  const rate = useTransport((s) => s.rate);
  const title = useStudio((s) => s.song?.title ?? '');
  const duration = useStudio((s) => s.song?.duration ?? 0);
  const [speedOpen, setSpeedOpen] = useState(false);
  useEffect(() => auto.setHeld(speedOpen), [auto, speedOpen]);
  useEffect(() => {
    if (!visible) setSpeedOpen(false);
  }, [visible]);

  return (
    <div
      data-fs-controls
      aria-hidden={!visible}
      // hidden controls can't be focused or tapped: a tap goes to the stage, which shows them again
      inert={!visible}
      className={cn('pointer-events-none absolute inset-0 z-20 transition-opacity duration-300', visible ? 'opacity-100' : 'opacity-0')}
      style={{
        paddingTop: 'env(safe-area-inset-top, 0px)',
        paddingRight: 'env(safe-area-inset-right, 0px)',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)',
        paddingLeft: 'env(safe-area-inset-left, 0px)',
      }}
    >
      <div className={cn('relative flex h-full flex-col justify-between', !visible && '[&_*]:pointer-events-none!')}>
        <div className="flex items-center gap-3 bg-gradient-to-b from-black/70 to-transparent px-3 pt-3 pb-8">
          <p className="min-w-0 flex-1 truncate text-[14px] font-semibold text-white drop-shadow">{title}</p>
          <button type="button" className={pill} onClick={onExit} title="Exit full screen (Esc)" aria-label="Exit full screen">
            <Minimize2 size={17} />
            Exit full screen
          </button>
        </div>

        {/* sits just above the on-screen keys (keysHeight), so they stay visible and playable */}
        <div className="relative bg-gradient-to-t from-black/60 to-transparent px-3 pt-8 pb-2" style={{ marginBottom: keysHeight }}>
          {speedOpen && (
            <div
              role="group"
              aria-label="Playback speed"
              className="pointer-events-auto absolute right-3 bottom-[4.25rem] flex gap-1 rounded-full bg-black/80 p-1 ring-1 ring-white/15 backdrop-blur-md"
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return;
                e.stopPropagation(); // Esc closes this menu, not full screen
                setSpeedOpen(false);
              }}
            >
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={rate === s}
                  onClick={() => {
                    useTransport.getState().set({ rate: s });
                    setSpeedOpen(false);
                  }}
                  className={cn(
                    'focus-ring h-11 min-w-11 rounded-full px-2.5 font-mono text-[13px]',
                    rate === s ? 'bg-white text-ink-950' : 'text-white hover:bg-white/15',
                  )}
                >
                  {s}×
                </button>
              ))}
            </div>
          )}
          <div className="pointer-events-auto flex items-center gap-2 rounded-full bg-black/70 p-1 ring-1 ring-white/10 backdrop-blur-md">
            <button
              type="button"
              onClick={() => getPlayer().toggle()}
              aria-label={playing ? 'Pause' : 'Play'}
              title={playing ? 'Pause (Space)' : 'Play (Space)'}
              className="focus-ring flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white text-ink-950 shadow-lg active:scale-95"
            >
              {playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" className="ml-0.5" />}
            </button>
            <SeekBar duration={duration} visible={visible} onHold={(h) => auto.setHeld(h)} />
            <button
              type="button"
              className={cn(pill, 'min-w-14 bg-white/10 px-3 font-mono ring-0 hover:bg-white/20')}
              onClick={() => setSpeedOpen((o) => !o)}
              aria-expanded={speedOpen}
              aria-label={`Playback speed ${rate}×`}
              title="Playback speed"
            >
              {rate}×
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function FullscreenStage({ children, onEnter }: { children: ReactNode; onEnter?: () => void }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const enterBtnRef = useRef<HTMLButtonElement>(null);
  const mode = useStageFullscreen((s) => s.mode);
  const setMode = useStageFullscreen((s) => s.setMode);
  const active = mode !== 'off';
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const onEnterRef = useRef(onEnter);
  onEnterRef.current = onEnter;
  const playing = useTransport((s) => s.playing);
  const [visible, setVisible] = useState(true);
  const [auto] = useState(() => createAutoHide(setVisible, HIDE_AFTER_MS));
  const [wake] = useState(() => createScreenWakeLock());
  const [touch] = useState(() => isTouchDevice());
  const [phone] = useState(() => isSmallTouchScreen());
  const [tapGuard] = useState(() => createTapGuard());
  const keysHeight = useKeysHeight(viewRef, active);
  const portrait = usePortrait();
  const [hintDismissed, setHintDismissed] = useState(() => rotateHintDismissed());

  const enter = useCallback(() => {
    const el = stageRef.current;
    if (!el || modeRef.current !== 'off') return;
    onEnterRef.current?.();
    if (fullscreenSupport(document, el) === 'none') {
      setMode('pseudo');
      return;
    }
    // requested synchronously inside the tap / key press; falls back to the fixed layer if refused
    void requestNativeFullscreen(document, el).then((ok) => {
      if (!stageRef.current) return;
      if (ok && currentFullscreenElement(document) === el) setMode('native');
      else if (!ok && modeRef.current === 'off') setMode('pseudo');
    });
  }, [setMode]);

  const exit = useCallback(() => {
    if (modeRef.current === 'off') return;
    if (stageRef.current && currentFullscreenElement(document) === stageRef.current) exitNativeFullscreen(document);
    setMode('off');
  }, [setMode]);
  const exitRef = useRef(exit);
  exitRef.current = exit;

  // the F key and other callers reach the stage through the store
  useEffect(() => {
    useStageFullscreen.getState().setControls({ toggle: () => (modeRef.current === 'off' ? enter() : exit()), exit });
    return () => useStageFullscreen.getState().setControls(null);
  }, [enter, exit]);

  // real full screen also ends via Esc, the browser's own UI or a system gesture
  useEffect(() => {
    return onFullscreenChange(document, () => {
      const el = stageRef.current;
      const fe = currentFullscreenElement(document);
      if (el && fe === el) setMode('native');
      else if (modeRef.current === 'native') setMode('off');
    });
  }, [setMode]);

  // leaving the page or switching songs unmounts the stage: put everything back
  useEffect(() => {
    const el = stageRef.current;
    return () => {
      if (el && currentFullscreenElement(document) === el) exitNativeFullscreen(document);
      useStageFullscreen.getState().setMode('off');
      auto.stop();
      void wake.hold(false);
    };
  }, [auto, wake]);

  // iPhone layer: no page scroll or rubber-band; keep the page at the top so the layer lines up;
  // reach under the notch and home indicator; the back swipe leaves full screen, not the song
  useEffect(() => {
    if (mode !== 'pseudo') return;
    const unlock = lockPageScroll(document);
    const uncover = coverViewport(document);
    const back = createBackToExit(window, () => exitRef.current());
    const toTop = () => window.scrollTo(0, 0);
    toTop();
    window.addEventListener('resize', toTop);
    return () => {
      window.removeEventListener('resize', toTop);
      back.release();
      uncover();
      unlock();
    };
  }, [mode]);

  // nothing behind the stage can be focused or tapped (Tab stays in full screen)
  useEffect(() => {
    if (!active || !stageRef.current) return;
    return inertOutside(stageRef.current);
  }, [active]);

  // focus moves into the stage so keys keep working; on exit back to the button
  useEffect(() => {
    if (active) stageRef.current?.focus({ preventScroll: true });
    else if (stageRef.current?.contains(document.activeElement)) enterBtnRef.current?.focus({ preventScroll: true });
    auto.poke();
  }, [active, auto]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exit();
      else auto.poke(); // keyboard use shows the controls, like a touch
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, exit, auto]);

  // controls going inert would drop focus to the page: keep it on the stage
  useEffect(() => {
    const stage = stageRef.current;
    if (!active || visible || !stage) return;
    const el = document.activeElement;
    if (el && el !== stage && stage.querySelector('[data-fs-controls]')?.contains(el)) stage.focus({ preventScroll: true });
  }, [active, visible]);

  useEffect(() => auto.setPlaying(playing), [auto, playing]);

  // a phone left alone to watch the notes would lock its screen
  useEffect(() => {
    void wake.hold(active && playing);
  }, [wake, active, playing]);

  // turning the phone sideways is what the hint asks for: it has done its job
  useEffect(() => {
    if (active && touch && !portrait && !hintDismissed) {
      dismissRotateHint();
      setHintDismissed(true);
    }
  }, [active, touch, portrait, hintDismissed]);

  const onPointerDownCapture = (e: React.PointerEvent) => {
    if (!active) return;
    tapGuard.pointerDown(stageTap(e));
  };
  /** what a pointerdown on the stage does; true when it was swallowed (then so is its click) */
  const stageTap = (e: React.PointerEvent): boolean => {
    if ((e.target as HTMLElement).closest('[data-fs-controls]')) {
      const hidden = !auto.visible;
      if (hidden) swallow(e); // a control fading out: this tap only brings them back
      auto.poke();
      return hidden;
    }
    if (onKeys(e)) return false; // the piano keys always play
    if (!auto.visible) {
      auto.poke();
      swallow(e);
      return true;
    }
    if (playing && e.pointerType !== 'mouse') {
      auto.hide();
      swallow(e);
      return true;
    }
    return false; // paused with the controls up: the tap reaches the view (drag to move through the song)
  };
  // the click after a revealing tap would land on the control now under the finger: drop it
  const onClickCapture = (e: React.MouseEvent) => {
    if (active && tapGuard.swallowClick(e.detail)) {
      e.stopPropagation();
      e.preventDefault();
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (active && e.pointerType === 'mouse') auto.poke();
  };

  const showHint = shouldShowRotateHint({ active, portrait, phone, dismissed: hintDismissed });

  return (
    <div
      ref={stageRef}
      data-fullscreen={mode}
      tabIndex={-1}
      className={cn('outline-none', active ? 'fs-stage-on' : 'relative min-h-0 flex-1', active && !visible && 'fs-cursor-hidden')}
      onPointerDownCapture={onPointerDownCapture}
      onClickCapture={onClickCapture}
      onPointerMove={onPointerMove}
    >
      <div
        ref={viewRef}
        className="absolute"
        style={
          active
            ? {
                top: 'env(safe-area-inset-top, 0px)',
                right: 'env(safe-area-inset-right, 0px)',
                bottom: 'env(safe-area-inset-bottom, 0px)',
                left: 'env(safe-area-inset-left, 0px)',
              }
            : { inset: 0 }
        }
      >
        {children}
      </div>

      {!active && (
        <button
          ref={enterBtnRef}
          type="button"
          onClick={enter}
          title="Full screen (F)"
          aria-label="Full screen"
          className={cn(
            pill,
            'absolute top-2 right-2 z-10 px-3.5 transition-opacity [@media(max-height:500px)]:w-11 [@media(max-height:500px)]:px-0',
            playing && 'opacity-60 hover:opacity-100',
          )}
        >
          <Maximize size={16} />
          {/* a phone held sideways has a short roll: icon only there */}
          <span className="[@media(max-height:500px)]:hidden">Full screen</span>
        </button>
      )}

      {active && <Controls auto={auto} visible={visible} keysHeight={keysHeight} onExit={exit} />}

      {showHint && visible && (
        <div
          data-fs-controls
          role="status"
          className="absolute inset-x-0 top-[calc(env(safe-area-inset-top,0px)+4.25rem)] z-30 flex justify-center px-3"
        >
          <div className="flex max-w-sm items-center gap-2 rounded-2xl bg-black/80 py-1 pr-1 pl-3.5 text-[13px] text-white ring-1 ring-white/15 backdrop-blur-md">
            <Smartphone size={17} className="shrink-0 rotate-90 text-accent-300" />
            <span>Turn your phone sideways for a bigger keyboard.</span>
            <button
              type="button"
              aria-label="Dismiss"
              title="Dismiss"
              className="focus-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-full hover:bg-white/15"
              onClick={() => {
                dismissRotateHint();
                setHintDismissed(true);
              }}
            >
              <X size={17} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function swallow(e: React.PointerEvent) {
  e.stopPropagation();
  e.preventDefault();
}
