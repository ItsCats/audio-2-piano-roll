/**
 * Sheet music view of the current arrangement: grand staff drawn by OSMD (lazy), a cursor that
 * follows playback, tap a note or measure to jump there. The frame loop only touches styles (no
 * React state), like PianoRollView, so playback causes no re-renders.
 */
import { useEffect, useRef, useState } from 'react';
import { Loader2, LocateFixed, Minus, Plus } from 'lucide-react';
import { currentArrangement, useStudio } from '../../state/studioStore';
import { useSettings } from '../../state/settingsStore';
import { getPlayer } from '../../state/playback';
import { buildSheet, type Score } from '../../lib/sheet';
import { SheetRenderer } from '../../lib/sheet/render';
import { Button, cn, IconButton } from '../ui';

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 1.5;
const clampZoom = (z: number) => Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 10) / 10;
export const defaultSheetZoom = (width: number) => (width < 640 ? 0.75 : 1);

export function SheetMusicView() {
  const song = useStudio((s) => s.song)!;
  const difficulty = useStudio((s) => s.difficulty);
  const arr = useStudio(currentArrangement)!;
  const sheet = useSettings((s) => s.sheet);
  const setSheet = useSettings((s) => s.setSheet);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const tintRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<SheetRenderer | null>(null);
  const followRef = useRef(sheet.follow);
  const userScrollAt = useRef(0);
  const tappedAt = useRef(0);
  const [width, setWidth] = useState(0);
  const [score, setScore] = useState<Score | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  followRef.current = sheet.follow;
  const zoom = sheet.zoom ?? defaultSheetZoom(width || window.innerWidth);
  const empty = arr.notes.length === 0;

  // page width (re-render only when it really changes)
  useEffect(() => {
    const el = pageRef.current!;
    let timer = 0;
    let last = 0;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (!last) {
        last = w;
        setWidth(w);
        return;
      }
      if (Math.abs(w - last) <= 32) return;
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        last = el.clientWidth;
        setWidth(last);
      }, 250);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      clearTimeout(timer);
    };
  }, []);

  // the Score: right away for a new song or level, 400 ms after the last edit otherwise
  const scoreKey = useRef<string>('');
  useEffect(() => {
    if (empty) {
      setScore(null);
      return;
    }
    const key = `${song.id}:${difficulty}`;
    const delay = scoreKey.current === key ? 400 : 0;
    scoreKey.current = key;
    const timer = window.setTimeout(() => {
      performance.mark('sheet:score-start');
      setScore(buildSheet(song, difficulty));
      performance.mark('sheet:score-ready');
    }, delay);
    return () => clearTimeout(timer);
  }, [arr, song.tempo, song.key, song.duration, song.id, difficulty, empty]); // eslint-disable-line react-hooks/exhaustive-deps

  // draw (progressively); keep the current measure in view
  useEffect(() => {
    if (!score || !width) return;
    const host = hostRef.current!;
    const r = (rendererRef.current ??= new SheetRenderer(host));
    const player = getPlayer();
    const t = player.getVisualTime();
    let shown = false;
    setStatus((s) => (s === 'ready' ? s : 'loading'));
    r.render(score, {
      zoom,
      startTime: t,
      linesPerChunk: width < 640 ? 1 : 2,
      onChunk: (done) => {
        if (done !== 1 || shown) return;
        shown = true;
        setStatus('ready');
        const top = r.lineTopOf(r.measureAt(t));
        const sc = scrollRef.current;
        if (sc && top !== null && t > 0.5) sc.scrollTop = Math.max(0, wrapperTop() + top - sc.clientHeight * 0.2);
      },
    }).catch((e) => {
      console.error(e);
      setStatus('error');
    });
    return () => r.cancel();
  }, [score, zoom, width, attempt]);

  useEffect(() => () => rendererRef.current?.destroy(), []);

  const wrapperTop = () => {
    const sc = scrollRef.current;
    const w = hostRef.current?.parentElement;
    if (!sc || !w) return 0;
    return w.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
  };

  // frame loop: cursor, measure tint, following
  useEffect(() => {
    const player = getPlayer();
    let raf = 0;
    let lastT = -1;
    let smoothUntil = 0;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || useSettings.getState().reducedMotion;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const r = rendererRef.current;
      const cur = cursorRef.current;
      const tint = tintRef.current;
      const sc = scrollRef.current;
      if (!r || !cur || !tint || !sc) return;
      const t = player.getVisualTime();
      const c = r.cursorAt(t);
      if (!c) {
        cur.style.display = 'none';
        tint.style.display = 'none';
        lastT = t;
        return;
      }
      cur.style.display = 'block';
      cur.style.transform = `translate(${c.x - 1.5}px, ${c.top - 6}px)`;
      cur.style.height = `${c.bottom - c.top + 12}px`;
      tint.style.display = 'block';
      tint.style.transform = `translate(${c.box.x}px, ${c.top - 6}px)`;
      tint.style.width = `${c.box.w}px`;
      tint.style.height = `${c.bottom - c.top + 12}px`;
      const now = performance.now();
      // a jump the user made by tapping the music needs no scrolling: they are looking at it
      const jumped = Math.abs(t - lastT) > 0.6 && now - tappedAt.current > 800;
      lastT = t;
      if (!followRef.current || (!player.isPlaying && !jumped) || now - userScrollAt.current < 4000 || now < smoothUntil) return;
      const vh = sc.clientHeight;
      const base = wrapperTop() - sc.scrollTop;
      const yTop = base + c.top;
      const yBot = base + c.bottom;
      const tall = c.bottom - c.top > vh * 0.55;
      if (yTop < vh * 0.15 || (!tall && yBot > vh * 0.7) || (tall && yTop > vh * 0.5)) {
        const target = Math.max(0, sc.scrollTop + yTop - vh * 0.2);
        if (reduce || jumped) sc.scrollTop = target;
        else {
          sc.scrollTo({ top: target, behavior: 'smooth' });
          smoothUntil = now + 700;
        }
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  // hand scrolling pauses following for 4 s; ctrl + wheel zooms
  useEffect(() => {
    const sc = scrollRef.current!;
    const mark = () => (userScrollAt.current = performance.now());
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const z = useSettings.getState().sheet.zoom ?? defaultSheetZoom(sc.clientWidth);
        setSheet({ zoom: clampZoom(z + (e.deltaY < 0 ? 0.1 : -0.1)) });
        return;
      }
      mark();
    };
    const onKey = (e: KeyboardEvent) => {
      if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown'].includes(e.key)) mark();
    };
    sc.addEventListener('wheel', onWheel, { passive: false });
    sc.addEventListener('touchmove', mark, { passive: true });
    sc.addEventListener('keydown', onKey);
    return () => {
      sc.removeEventListener('wheel', onWheel);
      sc.removeEventListener('touchmove', mark);
      sc.removeEventListener('keydown', onKey);
    };
  }, [setSheet]);

  // tap / click a note or measure to jump there
  const down = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    down.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = down.current;
    down.current = null;
    if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6) return;
    const r = rendererRef.current;
    const w = hostRef.current?.parentElement;
    if (!r || !w) return;
    const rect = w.getBoundingClientRect();
    const t = r.timeAtPoint(e.clientX - rect.left, e.clientY - rect.top);
    if (t === null) return;
    tappedAt.current = performance.now();
    getPlayer().seek(Math.max(0, t));
  };

  const setZoom = (z: number) => setSheet({ zoom: clampZoom(z) });

  return (
    <div ref={scrollRef} tabIndex={-1} className="absolute inset-0 overflow-x-hidden overflow-y-auto bg-ink-950 outline-none" data-testid="sheet-scroll">
      <div className="pointer-events-none sticky top-0 z-20 flex justify-end px-2 pt-2 sm:px-3">
        <div className="panel pointer-events-auto flex items-center gap-0.5 p-1 shadow-lg">
          <IconButton size="sm" label="Smaller" onClick={() => setZoom(zoom - 0.1)} disabled={zoom <= ZOOM_MIN}>
            <Minus size={15} />
          </IconButton>
          <button
            type="button"
            className="focus-ring h-8 min-w-[3.25rem] rounded-lg px-1 font-mono text-[12px] text-ink-200 tabular-nums hover:bg-ink-700/70"
            title="Reset size"
            onClick={() => setSheet({ zoom: null })}
          >
            {Math.round(zoom * 100)}%
          </button>
          <IconButton size="sm" label="Bigger" onClick={() => setZoom(zoom + 0.1)} disabled={zoom >= ZOOM_MAX}>
            <Plus size={15} />
          </IconButton>
          <span className="mx-1 h-5 w-px bg-ink-700" />
          <Button
            size="sm"
            variant={sheet.follow ? 'primary' : 'ghost'}
            icon={<LocateFixed size={14} />}
            aria-pressed={sheet.follow}
            title="Keep the music that is playing in view"
            onClick={() => setSheet({ follow: !sheet.follow })}
          >
            Follow
          </Button>
        </div>
      </div>
      <div ref={pageRef} className="mx-auto -mt-12 w-full max-w-[1180px] px-0 pb-24 sm:px-4">
        <div className="min-h-full bg-white px-2 pt-14 pb-10 text-black shadow-xl sm:rounded-b-lg sm:px-5">
          <div className="mb-3 px-2 text-center">
            <h2 className="font-serif text-[22px] leading-tight font-semibold break-words text-black sm:text-[26px]">{song.title || 'Untitled'}</h2>
            {song.artist && <p className="mt-1 font-serif text-[14px] break-words text-neutral-700">{song.artist}</p>}
            <p className="mt-1 text-[11.5px] text-neutral-500 capitalize">{difficulty}</p>
            {song.transcription.estimated && <p className="mt-1 text-[11.5px] text-neutral-500">Written out automatically — may contain mistakes.</p>}
          </div>
          {empty ? (
            <p className="py-16 text-center text-[14px] text-neutral-500">No notes to show yet.</p>
          ) : (
            <div className="relative" onPointerDown={onPointerDown} onPointerUp={onPointerUp} data-testid="sheet-music">
              <div ref={hostRef} className="relative" />
              <div ref={tintRef} className="pointer-events-none absolute top-0 left-0 hidden rounded-sm bg-accent-500/10" />
              <div ref={cursorRef} className="pointer-events-none absolute top-0 left-0 hidden w-[3px] rounded-full bg-accent-500/80" data-testid="sheet-cursor" />
              {status !== 'ready' && (
                <div className={cn('flex flex-col items-center justify-center gap-2 py-16 text-[13px] text-neutral-600', status === 'loading' && 'absolute inset-x-0 top-0')}>
                  {status === 'loading' ? (
                    <>
                      <Loader2 className="animate-spin text-neutral-400" size={22} />
                      Writing out the notes…
                    </>
                  ) : (
                    <>
                      Couldn’t show the sheet music.
                      <Button size="sm" onClick={() => setAttempt((a) => a + 1)}>
                        Try again
                      </Button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
