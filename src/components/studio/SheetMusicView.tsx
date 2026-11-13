/**
 * Sheet music view of the current arrangement: grand staff drawn by OSMD (lazy), a cursor that
 * follows playback, tap a note or measure to jump there. The frame loop only touches styles (no
 * React state), like PianoRollView, so playback causes no re-renders.
 */
import { useEffect, useRef, useState } from 'react';
import { Loader2, LocateFixed, Maximize, Minus, Plus } from 'lucide-react';
import { currentArrangement, useStudio } from '../../state/studioStore';
import { useSettings } from '../../state/settingsStore';
import { getPlayer } from '../../state/playback';
import { toggleStageFullscreen, useStageFullscreen } from '../../state/fullscreenStore';
import { buildSheet, type Score } from '../../lib/sheet';
import { loadOsmd, SheetRenderer } from '../../lib/sheet/render';
import { Button, cn, IconButton } from '../ui';
import { sheetCtx, sheetEditedRecently } from '../../state/sheetEdit';
import { barMarkRefs, markSelOfHit } from '../../state/sheetMarks';
import { useSheetUi } from '../../state/sheetUi';
import { SheetEditBar, DOCK_PAD } from './sheet/SheetEditBar';
import { SheetEditOverlay } from './sheet/SheetEditOverlay';
import { SheetContextMenu } from './sheet/SheetContextMenu';
import { useSheetOverlay, useSheetPointer } from './sheet/useSheetPointer';
import { performSheetAction } from './sheet/sheetActions';
import { setSheetActionHandler } from '../../state/sheetKeys';

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 1.5;
const clampZoom = (z: number) => Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) * 10) / 10;
/** Loads the notation library ahead of time (see Studio's view switch). */
export const warmNotation = () => loadOsmd();

export const defaultSheetZoom = (width: number) => (width < 640 ? 0.75 : 1);

export function SheetMusicView() {
  const song = useStudio((s) => s.song)!;
  const difficulty = useStudio((s) => s.difficulty);
  const arr = useStudio(currentArrangement)!;
  const sheet = useSettings((s) => s.sheet);
  const setSheet = useSettings((s) => s.setSheet);
  // inside the Studio's full-screen stage this toolbar also holds its "Full screen" button
  const canFullscreen = useStageFullscreen((s) => s.controls !== null && s.mode === 'off');
  const fullscreen = useStageFullscreen((s) => s.mode !== 'off');
  const editMode = useStudio((s) => s.editMode);
  const selection = useStudio((s) => s.selection);
  const markSel = useStudio((s) => s.markSel);
  const [drawTick, setDrawTick] = useState(0);
  const addMode = useSheetUi((s) => s.addMode);
  // in full screen the edit tools dock inside the stage (otherwise the Studio shows them)
  const dock = editMode && fullscreen;
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const tintRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<SheetRenderer | null>(null);
  const followRef = useRef(sheet.follow);
  const userScrollAt = useRef(0);
  /** Zoom shown while a pinch / ctrl + wheel gesture runs (drawn for real when it ends). */
  const gestureZoom = useRef<number | null>(null);
  const zoomLayerRef = useRef<HTMLDivElement>(null);
  /** Song and level of the music on screen (a redraw of the same keeps it until the new one is ready). */
  const drawnKey = useRef('');
  const tappedAt = useRef(0);
  const [width, setWidth] = useState(0);
  const [score, setScore] = useState<Score | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  const [gestureLabel, setGestureLabel] = useState<number | null>(null);
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
      // small growth is ignored (the music just gets a little margin); any shrink redraws, or the
      // fixed-width music would be cut off at the right edge
      if (w >= last && w - last <= 32) return;
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
    const same = scoreKey.current === key;
    scoreKey.current = key;
    const build = () => {
      performance.mark('sheet:score-start');
      setScore(buildSheet(song, difficulty));
      performance.mark('sheet:score-ready');
    };
    // an edit made on the sheet shows on the next frame; piano-roll edits and undo wait 400 ms
    if (same && sheetEditedRecently()) {
      const raf = requestAnimationFrame(build);
      return () => cancelAnimationFrame(raf);
    }
    const timer = window.setTimeout(build, same ? 400 : 0);
    return () => clearTimeout(timer);
  }, [arr, song.tempo, song.key, song.duration, song.sheet, song.id, difficulty, empty]); // eslint-disable-line react-hooks/exhaustive-deps

  // draw (progressively); keep the current measure in view
  useEffect(() => {
    if (!score || !width) return;
    const host = hostRef.current!;
    // the host div is re-created after a level with no notes: never draw into a detached one
    if (rendererRef.current?.host !== host) {
      rendererRef.current?.destroy();
      rendererRef.current = new SheetRenderer(host);
    }
    const r = rendererRef.current;
    const drawKey = `${song.id}:${difficulty}`;
    const keepOld = drawnKey.current === drawKey;
    drawnKey.current = drawKey;
    const player = getPlayer();
    const t = player.getVisualTime();
    let shown = false;
    setStatus((s) => (s === 'ready' ? s : 'loading'));
    r.render(score, {
      zoom,
      startTime: t,
      linesPerChunk: width < 640 ? 1 : 2,
      keepOld,
      // an edit (on the sheet or undo while editing): keep the lines, redraw only what changed
      edit: keepOld && useStudio.getState().editMode,
      onChunk: () => {
        if (shown) return;
        shown = true;
        // the pinch preview (a scaled copy of the old drawing) ends when the new drawing shows
        if (zoomLayerRef.current) zoomLayerRef.current.style.transform = '';
        setStatus('ready');
        const top = r.lineTopOf(r.measureAt(t));
        const sc = scrollRef.current;
        if (sc && top !== null && t > 0.5) sc.scrollTop = Math.max(0, wrapperTop() + top - sc.clientHeight * 0.2);
      },
    })
      .then((done) => done && setDrawTick((n) => n + 1))
      .catch((e) => {
        console.error(e);
        setStatus('error');
      });
    return () => r.cancel();
  }, [score, zoom, width, attempt]);

  useEffect(() => () => rendererRef.current?.destroy(), []);

  // selected notes light up on the sheet (the renderer re-applies it after every redraw)
  useEffect(() => {
    rendererRef.current?.highlight(editMode ? selection : new Set());
  }, [selection, editMode, score]);

  useEffect(() => {
    if (!editMode) useSheetUi.getState().set({ addMode: false, menu: null, chips: [], panel: null, picker: null });
  }, [editMode]);

  // the selected marking gets a ring (drawn by the overlay)
  useEffect(() => {
    const r = rendererRef.current;
    const ctx = sheetCtx();
    let ring = null;
    if (editMode && markSel && r && ctx) {
      const h = r.markHits(barMarkRefs(ctx)).find((x) => markSelOfHit(ctx, x.id) === markSel);
      if (h) ring = { x0: h.x0, y0: h.y0, x1: h.x1, y1: h.y1 };
    }
    useSheetOverlay.getState().set({ ring });
  }, [markSel, editMode, drawTick, status]);

  // the Studio's keyboard handler sends sheet keys here while the sheet is on screen
  useEffect(() => {
    setSheetActionHandler(performSheetAction);
    return () => setSheetActionHandler(null);
  }, []);

  const pointer = useSheetPointer({
    renderer: () => rendererRef.current,
    layer: () => hostRef.current?.parentElement ?? null,
    enabled: editMode && status === 'ready',
    onSeek: (t) => {
      tappedAt.current = performance.now();
      getPlayer().seek(Math.max(0, t));
    },
  });

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

  // hand scrolling pauses following for 4 s (wheel, touch, keys, dragging the scroll bar, middle-
  // click scrolling); ctrl + wheel / trackpad pinch zooms
  useEffect(() => {
    const sc = scrollRef.current!;
    const mark = () => (userScrollAt.current = performance.now());
    let wheelAcc = 0;
    let commit = 0;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        // a pinch sends many small events: step 10 % per 50 px, show it scaled at once and draw
        // the music at the new size only when the gesture stops
        wheelAcc += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        if (Math.abs(wheelAcc) < 50) return;
        const steps = Math.trunc(wheelAcc / 50);
        wheelAcc -= steps * 50;
        const drawn = useSettings.getState().sheet.zoom ?? defaultSheetZoom(sc.clientWidth);
        const next = clampZoom((gestureZoom.current ?? drawn) - steps * 0.1);
        gestureZoom.current = next;
        const layer = zoomLayerRef.current;
        if (layer) {
          layer.style.transformOrigin = 'top center';
          layer.style.transform = next === drawn ? '' : `scale(${next / drawn})`;
        }
        setGestureLabel(next);
        clearTimeout(commit);
        commit = window.setTimeout(() => {
          const z = gestureZoom.current;
          gestureZoom.current = null;
          setGestureLabel(null);
          if (z !== null && z !== (useSettings.getState().sheet.zoom ?? defaultSheetZoom(sc.clientWidth))) setSheet({ zoom: z });
          else if (layer) layer.style.transform = '';
        }, 300);
        return;
      }
      mark();
    };
    const onKey = (e: KeyboardEvent) => {
      if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End', ' '].includes(e.key)) mark();
    };
    let dragging = false;
    const onDown = (e: PointerEvent) => {
      // the scroll bar belongs to the scroll box itself; the middle button starts auto-scrolling
      if (e.target === sc || e.button === 1) dragging = true;
    };
    const onUp = () => (dragging = false);
    const onScroll = () => {
      if (dragging) mark();
    };
    sc.addEventListener('wheel', onWheel, { passive: false });
    sc.addEventListener('touchmove', mark, { passive: true });
    sc.addEventListener('keydown', onKey);
    sc.addEventListener('pointerdown', onDown);
    sc.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      clearTimeout(commit);
      sc.removeEventListener('wheel', onWheel);
      sc.removeEventListener('touchmove', mark);
      sc.removeEventListener('keydown', onKey);
      sc.removeEventListener('pointerdown', onDown);
      sc.removeEventListener('scroll', onScroll);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [setSheet]);

  // tap / click a note or measure to jump there
  const down = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (editMode) return pointer.onPointerDown(e);
    down.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (editMode) return pointer.onPointerUp(e);
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
      {/* in full screen (--fs-top) the toolbar starts below the stage's title / Exit row */}
      <div aria-hidden style={{ height: 'var(--fs-top, 0px)' }} />
      <div className="pointer-events-none sticky z-20 flex justify-end px-2 pt-2 sm:px-3" style={{ top: 'var(--fs-top, 0px)' }} data-testid="sheet-toolbar">
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
            {Math.round((gestureLabel ?? zoom) * 100)}%
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
          {canFullscreen && (
            <>
              <span className="mx-1 h-5 w-px bg-ink-700" />
              <IconButton size="sm" label="Full screen" title="Full screen (F)" data-fs-enter onClick={toggleStageFullscreen}>
                <Maximize size={15} />
              </IconButton>
            </>
          )}
        </div>
      </div>
      <div ref={pageRef} className="mx-auto -mt-12 w-full max-w-[1180px] px-0 pb-24 sm:px-4" style={dock ? { paddingBottom: DOCK_PAD } : undefined}>
        <div className="min-h-full bg-white px-2 pt-14 pb-10 text-black shadow-xl sm:rounded-b-lg sm:px-5">
          <div className="mb-3 px-2 text-center">
            <h2 className="font-serif text-[22px] leading-tight font-semibold break-words text-black sm:text-[26px]">{song.title || 'Untitled'}</h2>
            {song.artist && <p className="mt-1 font-serif text-[14px] break-words text-neutral-700">{song.artist}</p>}
            <p className="mt-1 text-[11.5px] text-neutral-500 capitalize">{difficulty}</p>
            {song.transcription.estimated && <p className="mt-1 text-[11.5px] text-neutral-500">Written out automatically — may contain mistakes.</p>}
            {song.source.kind === 'score' && song.source.reader && (
              <p className="mt-1 text-[11.5px] text-neutral-500">Read from {song.source.reader === 'photo' ? 'a photo' : 'a PDF'}{song.source.sheetReader === 'accurate' ? '' : ' (Beta)'} — may contain mistakes.</p>
            )}
            {!song.transcription.estimated && song.tempo.source === 'midi' && score?.time.source === 'estimated' && (
              <p className="mt-1 text-[11.5px] text-neutral-500">The bar lines were guessed from how it was played.</p>
            )}
          </div>
          {empty ? (
            <p className="py-16 text-center text-[14px] text-neutral-500">No notes to show yet.</p>
          ) : (
            <div
              ref={zoomLayerRef}
              className={cn('relative', editMode && 'sheet-editing', editMode && addMode && 'cursor-crosshair')}
              style={editMode ? { touchAction: 'pan-x pan-y' } : undefined}
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              onPointerMove={editMode ? pointer.onPointerMove : undefined}
              onPointerLeave={editMode ? pointer.onPointerLeave : undefined}
              onPointerCancel={editMode ? pointer.onPointerCancel : undefined}
              onDoubleClick={editMode ? pointer.onDoubleClick : undefined}
              onContextMenu={editMode ? pointer.onContextMenu : undefined}
              data-testid="sheet-music"
              data-editing={editMode ? 'true' : undefined}
            >
              <div ref={hostRef} className="relative" />
              {editMode && <SheetEditOverlay />}
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
      {editMode && <SheetContextMenu />}
      {dock && <SheetEditBar layout="dock" fixed />}
    </div>
  );
}
