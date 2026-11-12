import { useEffect, useRef, useState } from 'react';
import { Play, Pause, SkipBack, Repeat, Timer, Volume2, Music4, Hand, ChevronDown, Headphones } from 'lucide-react';
import { getPlayer, useAudioStatus } from '../../state/playback';
import { useTransport } from '../../state/transportStore';
import { useSettings } from '../../state/settingsStore';
import { currentArrangement, useStudio } from '../../state/studioStore';
import { formatTime } from '../../lib/music/theory';
import { IconButton, cn } from '../ui';
import { seekStepSeconds } from '../../state/studioKeys';

const SPEEDS = [0.25, 0.5, 0.6, 0.75, 0.85, 1, 1.15, 1.25, 1.5, 2];

function Minimap({ duration }: { duration: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const arr = useStudio(currentArrangement);
  const visual = useSettings((s) => s.visual);
  useEffect(() => {
    const c = ref.current;
    if (!c || !arr) return;
    const r = c.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = Math.max(1, r.width * dpr);
    c.height = Math.max(1, r.height * dpr);
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    if (!arr.notes.length) return;
    let lo = 127;
    let hi = 0;
    for (const n of arr.notes) {
      lo = Math.min(lo, n.midi);
      hi = Math.max(hi, n.midi);
    }
    const span = Math.max(12, hi - lo + 2);
    for (const n of arr.notes) {
      const x = (n.start / duration) * c.width;
      const w = Math.max(1, (n.dur / duration) * c.width);
      const y = c.height - ((n.midi - lo + 1) / span) * c.height;
      ctx.fillStyle = n.hand === 'L' ? visual.leftColor : visual.rightColor;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(x, y - dpr, w, 2 * dpr);
    }
  }, [arr, duration, visual.leftColor, visual.rightColor]);
  return <canvas ref={ref} className="pointer-events-none absolute inset-0 h-full w-full" />;
}

export function Transport() {
  const song = useStudio((s) => s.song);
  const t = useTransport();
  const audio = useSettings((s) => s.audio);
  const setAudio = useSettings((s) => s.setAudio);
  const practice = useSettings((s) => s.practice);
  const setPractice = useSettings((s) => s.setPractice);
  const audioStatus = useAudioStatus();
  const timeRef = useRef<HTMLSpanElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [speedOpen, setSpeedOpen] = useState(false);
  const duration = song?.duration ?? 0;
  const player = getPlayer();

  // playhead & time text updated outside React
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const time = Math.max(0, player.getVisualTime());
      const f = duration ? Math.min(1, time / duration) : 0;
      if (headRef.current) headRef.current.style.left = `${f * 100}%`;
      if (fillRef.current) fillRef.current.style.width = `${f * 100}%`;
      const text = formatTime(time);
      if (timeRef.current && timeRef.current.textContent !== text) {
        timeRef.current.textContent = text;
        barRef.current?.setAttribute('aria-valuenow', String(Math.round(time)));
        barRef.current?.setAttribute('aria-valuetext', text);
      }
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [duration, player]);

  const seekFromEvent = (clientX: number) => {
    const r = barRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration;
  };
  const dragging = useRef<{ loopFrom?: number } | null>(null);
  const onBarDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const time = seekFromEvent(e.clientX);
    if (e.shiftKey) {
      dragging.current = { loopFrom: time };
      t.set({ loop: { start: time, end: time }, loopEnabled: true });
    } else {
      dragging.current = {};
      player.seek(time);
    }
  };
  const onBarMove = (e: React.PointerEvent) => {
    if (!dragging.current) return;
    const time = seekFromEvent(e.clientX);
    if (dragging.current.loopFrom !== undefined) {
      const a = dragging.current.loopFrom;
      t.set({ loop: { start: Math.min(a, time), end: Math.max(a, time) } });
    } else player.seek(time);
  };
  const onBarUp = () => {
    const d = dragging.current;
    dragging.current = null;
    if (d?.loopFrom !== undefined) {
      const l = useTransport.getState().loop;
      if (l && l.end - l.start < 0.5) t.set({ loop: null, loopEnabled: false });
      else if (l) player.seek(l.start);
    }
  };

  const setLoopPoint = (which: 'start' | 'end') => {
    const now = player.getTime();
    const l = t.loop ?? { start: 0, end: duration };
    const next = which === 'start' ? { start: now, end: Math.max(now + 1, l.end) } : { start: Math.min(l.start, now - 1), end: now };
    next.start = Math.max(0, next.start);
    t.set({ loop: next, loopEnabled: true });
  };

  const handMode = t.hands.L && t.hands.R ? 'both' : t.hands.L ? 'L' : t.hands.R ? 'R' : 'none';
  const cycleHands = () => {
    const next = handMode === 'both' ? { L: false, R: true } : handMode === 'R' ? { L: true, R: false } : { L: true, R: true };
    // (from 'none' — practice with both hands — this returns to computer playing both)
    t.set({ hands: next });
  };

  return (
    <div className="flex flex-col gap-2 border-t border-ink-800 bg-ink-900/95 px-3 pt-2 pb-2.5 md:px-4">
      {/* timeline */}
      <div className="flex items-center gap-3">
        <span ref={timeRef} className="w-12 text-right font-mono text-[12px] text-ink-100 tabular-nums">
          0:00
        </span>
        <div
          ref={barRef}
          className="group relative h-8 flex-1 cursor-pointer overflow-hidden rounded-lg bg-ink-850 ring-1 ring-ink-700"
          onPointerDown={onBarDown}
          onPointerMove={onBarMove}
          onPointerUp={onBarUp}
          role="slider"
          aria-label="Song position (shift-drag to set a loop)"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={0}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
            // handled here only: stop the page-wide shortcut from seeking a second time
            e.preventDefault();
            e.stopPropagation();
            const step = seekStepSeconds(e.shiftKey);
            player.seek(player.getTime() + (e.key === 'ArrowRight' ? step : -step));
          }}
        >
          <Minimap duration={duration || 1} />
          <div ref={fillRef} className="pointer-events-none absolute inset-y-0 left-0 bg-accent-500/12" />
          {t.loop && (
            <div
              className={cn('pointer-events-none absolute inset-y-0 border-x-2', t.loopEnabled ? 'border-accent-400 bg-accent-500/15' : 'border-ink-500 bg-ink-500/10')}
              style={{ left: `${(t.loop.start / (duration || 1)) * 100}%`, width: `${((t.loop.end - t.loop.start) / (duration || 1)) * 100}%` }}
            />
          )}
          <div ref={headRef} className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_8px_rgba(255,255,255,0.7)]" />
        </div>
        <span className="w-12 font-mono text-[12px] text-ink-300 tabular-nums">{formatTime(duration)}</span>
      </div>

      {/* controls */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <IconButton label="Back to start (Home)" onClick={() => player.seek(t.loopEnabled && t.loop ? t.loop.start : 0)}>
            <SkipBack size={18} />
          </IconButton>
          <button
            type="button"
            onClick={() => player.toggle()}
            aria-label={t.playing ? 'Pause (Space)' : 'Play (Space)'}
            title={t.playing ? 'Pause (Space)' : 'Play (Space)'}
            disabled={!song}
            className="focus-ring relative flex h-11 w-11 items-center justify-center rounded-full bg-ink-50 text-ink-950 shadow-lg transition-transform hover:scale-105 active:scale-95 disabled:opacity-40"
          >
            {t.playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" className="ml-0.5" />}
            {!audioStatus.ready && !audioStatus.error && (
              <span className="absolute -inset-1 animate-spin rounded-full border-2 border-transparent border-t-accent-400" aria-hidden />
            )}
          </button>
          {!audioStatus.ready && !audioStatus.error && (
            <span className="ml-1 hidden text-[12px] text-ink-300 sm:inline" aria-live="polite">
              Loading piano… {Math.round(audioStatus.progress * 100)}%
            </span>
          )}
          <div className="relative">
            <button
              type="button"
              onClick={() => setSpeedOpen((o) => !o)}
              className="focus-ring ml-1 flex h-9 items-center gap-1 rounded-[10px] px-2.5 font-mono text-[12.5px] text-ink-100 hover:bg-ink-700/70"
              title="Playback speed"
              aria-haspopup="listbox"
              aria-expanded={speedOpen}
            >
              {t.rate}× <ChevronDown size={14} />
            </button>
            {speedOpen && (
              <div className="panel absolute bottom-11 left-0 z-20 flex w-28 flex-col p-1" role="listbox">
                {SPEEDS.map((s) => (
                  <button
                    key={s}
                    role="option"
                    aria-selected={t.rate === s}
                    onClick={() => {
                      t.set({ rate: s });
                      setSpeedOpen(false);
                    }}
                    className={cn('rounded-md px-2.5 py-1.5 text-left font-mono text-[12.5px] hover:bg-ink-700', t.rate === s ? 'text-accent-300' : 'text-ink-100')}
                  >
                    {s}× {s < 1 ? '· practice' : ''}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1">
          <IconButton
            label={`Computer plays: ${handMode === 'both' ? 'both hands' : handMode === 'L' ? 'left hand only' : handMode === 'R' ? 'right hand only' : 'nothing (you play)'}`}
            active={handMode !== 'both'}
            onClick={cycleHands}
          >
            <span className="flex items-center gap-0.5 text-[11px] font-semibold">
              <Hand size={15} />
              {handMode === 'both' ? 'LR' : handMode === 'none' ? '–' : handMode}
            </span>
          </IconButton>
          <IconButton label="Loop section (shift-drag on the timeline)" active={t.loopEnabled} onClick={() => t.set({ loopEnabled: !t.loopEnabled, loop: t.loop ?? { start: player.getTime(), end: Math.min(duration, player.getTime() + 8) } })}>
            <Repeat size={17} />
          </IconButton>
          <button className="focus-ring h-8 rounded-md px-1.5 font-mono text-[11px] text-ink-300 hover:bg-ink-700 hover:text-ink-50" onClick={() => setLoopPoint('start')} title="Set loop start at playhead">
            A
          </button>
          <button className="focus-ring h-8 rounded-md px-1.5 font-mono text-[11px] text-ink-300 hover:bg-ink-700 hover:text-ink-50" onClick={() => setLoopPoint('end')} title="Set loop end at playhead">
            B
          </button>
          <IconButton label="Metronome" active={practice.metronome} onClick={() => setPractice({ metronome: !practice.metronome })}>
            <Timer size={17} />
          </IconButton>
          <IconButton label="Count-in before playing" active={practice.countIn} onClick={() => setPractice({ countIn: !practice.countIn })}>
            <span className="text-[11px] font-semibold">1·2·3</span>
          </IconButton>
        </div>

        <div className="flex items-center gap-3">
          {audioStatus.loading && audioStatus.ready && (
            <span className="flex items-center gap-1.5 text-[11.5px] text-ink-300" title="Loading more piano velocity layers in the background">
              <Music4 size={14} className="animate-pulse text-accent-400" /> {Math.round(audioStatus.progress * 100)}%
            </span>
          )}
          {audioStatus.error && <span className="max-w-48 truncate text-[11.5px] text-bad" title={audioStatus.error}>Audio error</span>}
          {song?.hasAudio && player.hasOriginalAudio && (
            <label className="hidden items-center gap-2 text-[12px] text-ink-300 lg:flex" title="Blend in the original recording to check the transcription">
              <Headphones size={15} />
              <span>Original</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={audio.originalVolume}
                onChange={(e) => setAudio({ originalVolume: parseFloat(e.target.value) })}
                className="w-20"
                style={{ ['--fill' as string]: `${audio.originalVolume * 100}%` }}
                aria-label="Original recording volume"
              />
            </label>
          )}
          <label className="flex items-center gap-2 text-[12px] text-ink-300">
            <Volume2 size={15} />
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={audio.volume}
              onChange={(e) => setAudio({ volume: parseFloat(e.target.value) })}
              className="w-20 md:w-24"
              style={{ ['--fill' as string]: `${audio.volume * 100}%` }}
              aria-label="Piano volume"
            />
          </label>
        </div>
      </div>
    </div>
  );
}
