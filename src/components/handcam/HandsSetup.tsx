/**
 * Hands video setup, step by step (phones: full screen; desktop: a wide panel):
 *   Sync → Pick a frame → Corners → Keys → Framing → Save.
 * The calibration is saved on the song (Song.handVideo.calibration).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Crosshair, FlipHorizontal2, Loader2, RotateCw, Sparkles, Volume2, Wand2, X, Eraser } from 'lucide-react';
import { Button, ProgressBar, Segmented, Select, Slider, cn } from '../ui';
import type { Difficulty, Song } from '../../lib/music/types';
import type { HandVideo, HandsLayout, KeyboardCalibration } from '../../lib/handcam/types';
import {
  EDGE_RANGE,
  HANDS_RANGE,
  HIT_V_RANGE,
  KEY_LENGTH_RANGE,
  KEY_PRESETS,
  cornersValid,
  defaultCalibration,
  keyboardAspect,
  noteSpan,
  notesOutside,
  presetFor,
  uOfWhite,
  whiteKeys,
  whitesBetween,
  windowMatrix,
} from '../../lib/handcam/calibration';
import { autoMatch, blackCenters, findKeyboard, guessRange, rectify, toGray } from '../../lib/handcam/detect';
import { createWarper, type Warper } from '../../lib/handcam/warp';
import { autoSync, offsetSentence, syncReference } from '../../lib/handcam/syncRun';
import { videoSoundForSpan } from '../../lib/handcam/media';
import { isBlack, noteName } from '../../lib/music/theory';
import { formatTime } from '../../lib/music/theory';
import type { VisualSettings } from '../../lib/render/settings';
import type { ExportSettings } from '../../lib/export/types';
import type { WatermarkSettings } from '../../lib/watermark/types';
import { useHandFrames, useVideoFrame, type FrameImage } from './hooks';
import { PreviewPainter } from './previewPainter';
import { QuadEditor } from './QuadEditor';

type Step = 'sync' | 'frame' | 'corners' | 'keys' | 'framing';
const STEP_TITLE: Record<Step, string> = { sync: 'Sync', frame: 'Pick a frame', corners: 'Corners', keys: 'Keys', framing: 'Framing' };
const CORNER_LABELS = ['Lowest key, back', 'Highest key, back', 'Highest key, front', 'Lowest key, front'];
const LEVEL_LABEL = { high: 'High', medium: 'Medium', low: 'Low' };

/** the frame as the user sees it (turned / mirrored), as a canvas */
function orientCanvas(src: CanvasImageSource, w: number, h: number, cal: Pick<KeyboardCalibration, 'turn' | 'mirror'>): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.translate(w / 2, h / 2);
  if (cal.turn === 180) ctx.rotate(Math.PI);
  if (cal.mirror) ctx.scale(-1, 1);
  ctx.drawImage(src, -w / 2, -h / 2, w, h);
  return c;
}

/** The straightened keyboard (u 0..1, v v0..v1) of a still frame, drawn into `canvas` (WebGL warp, reused). */
function useStraightened(canvas: HTMLCanvasElement | null, still: FrameImage | null, cal: KeyboardCalibration, w: number, h: number, v0: number, v1: number) {
  const warper = useRef<Warper | null>(null);
  useEffect(
    () => () => {
      warper.current?.dispose();
      warper.current = null;
    },
    [],
  );
  useEffect(() => {
    if (!canvas || !still || w < 2 || h < 2) return;
    if (!warper.current) warper.current = createWarper(w, h);
    const wp = warper.current;
    wp.resize(w, h);
    wp.upload(still.canvas as TexImageSource, still.w, still.h);
    wp.draw(windowMatrix(cal, w, h, { ua: 0, ub: 1, v0, v1 }, 0));
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(wp.canvas as CanvasImageSource, 0, 0);
  }, [canvas, still, cal, w, h, v0, v1]);
}

/** lanes over the straightened keyboard: white-key edges, black keys, C labels */
function drawLanes(ctx: CanvasRenderingContext2D, cal: KeyboardCalibration, w: number, h: number, v0: number, v1: number) {
  const y = (v: number) => ((v - v0) / (v1 - v0)) * h;
  const n = whitesBetween(cal.lo, cal.hi);
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255,80,160,0.9)';
  ctx.beginPath();
  for (let i = 0; i <= n; i++) {
    const x = Math.round(uOfWhite(cal, i) * w) + 0.5;
    ctx.moveTo(x, y(0));
    ctx.lineTo(x, y(1));
  }
  ctx.stroke();
  const { a, b } = { a: cal.edgeL, b: n + cal.edgeR };
  const bw = (0.6 / (b - a)) * w;
  ctx.strokeStyle = 'rgba(80,220,255,0.95)';
  for (const u of blackCenters(cal)) ctx.strokeRect(u * w - bw / 2, y(0), bw, y(0.63) - y(0));
  // the hit line and C labels
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.beginPath();
  ctx.moveTo(0, y(cal.hitV));
  ctx.lineTo(w, y(cal.hitV));
  ctx.stroke();
  ctx.font = `600 ${Math.max(9, Math.min(13, (w / n) * 0.55))}px Inter Variable, Inter, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  let wi = 0;
  for (let m = cal.lo; m <= cal.hi; m++) {
    if (isBlack(m)) continue;
    if (m % 12 === 0) {
      const x = ((uOfWhite(cal, wi) + uOfWhite(cal, wi + 1)) / 2) * w;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      ctx.fillRect(x - 12, y(0.98) - 13, 24, 15);
      ctx.fillStyle = '#ffd34d';
      ctx.fillText(noteName(m), x, y(0.98) - 2);
    }
    wi++;
  }
  ctx.restore();
}

export interface HandsSetupProps {
  song: Song;
  difficulty: Difficulty;
  visual: VisualSettings;
  settings: ExportSettings;
  watermark: WatermarkSettings | null;
  logo: ImageBitmap | null;
  /** start the automatic sync right away (a video that was just added) */
  autoStart?: boolean;
  setLayout: (l: HandsLayout) => void;
  onClose: () => void;
  onSave: (hv: HandVideo) => void;
}

export function HandsSetup({ song, difficulty, visual, settings, watermark, logo, autoStart, setLayout, onClose, onSave }: HandsSetupProps) {
  const hv0 = song.handVideo!;
  const [hv, setHv] = useState<HandVideo>(hv0);
  const [cal, setCal] = useState<KeyboardCalibration>(() => hv0.calibration ?? defaultCalibration({ frameTime: Math.min(hv0.duration / 2, Math.max(0, hv0.offset + 2)) }));
  const steps: Step[] = ['sync', 'frame', 'corners', 'keys', 'framing'];
  const [si, setSi] = useState(0);
  const step = steps[si];
  const { frames, blob, error: loadError } = useHandFrames(song);
  const [clean, setClean] = useState<HTMLCanvasElement | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const shown = useVideoFrame(frames, cal.frameTime, 60);
  const display = clean && !shown ? null : clean ? { canvas: clean, w: clean.width, h: clean.height, t: cal.frameTime } : shown;
  const still = display;
  const notes = song.arrangements[difficulty].notes;
  const aspect = hv.displayW / Math.max(1, hv.displayH);

  // ---------- sync ----------
  const [sync, setSync] = useState<{ status: 'idle' | 'running' | 'error'; progress: number; what: string; message?: string }>({ status: 'idle', progress: 0, what: '' });
  const syncAbort = useRef<AbortController | null>(null);
  const runSync = async () => {
    if (!blob) return;
    syncAbort.current?.abort();
    const ac = new AbortController();
    syncAbort.current = ac;
    setSync({ status: 'running', progress: 0, what: 'Finding where your video lines up with the song…' });
    try {
      const r = await autoSync(song, blob, { signal: ac.signal, onProgress: (f) => setSync((s) => ({ ...s, progress: f })) });
      if (ac.signal.aborted) return;
      setHv((h) => ({ ...h, offset: r.offset, sync: r.sync }));
      setSync({ status: 'idle', progress: 1, what: '' });
    } catch (e) {
      if ((e as Error).name === 'AbortError') return setSync({ status: 'idle', progress: 0, what: '' });
      setSync({ status: 'error', progress: 0, what: '', message: (e as Error).message });
    }
  };
  const started = useRef(false);
  useEffect(() => {
    if (autoStart && blob && !started.current && hv.store === 'handcam') {
      started.current = true;
      void runSync();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, blob]);
  useEffect(() => () => syncAbort.current?.abort(), []);
  const found = hv.sync?.found ?? hv.offset;
  const [songT, setSongT] = useState(() => notes[Math.min(notes.length - 1, 3)]?.start ?? 1);
  const syncFrame = useVideoFrame(frames, step === 'sync' || step === 'framing' ? songT + hv.offset : null, 80);
  const listen = useRef<AudioContext | null>(null);
  const [listening, setListening] = useState(false);
  const playListen = async () => {
    if (!blob || listening) return;
    setListening(true);
    try {
      const ctx = new AudioContext();
      listen.current = ctx;
      const span = { start: Math.max(0, songT - 0.5), end: songT + 5.5 };
      const src = await videoSoundForSpan(blob, hv.offset, span, ctx.sampleRate, { mono: true });
      const buf = ctx.createBuffer(1, src.channels[0].length || 1, ctx.sampleRate);
      buf.copyToChannel(src.channels[0] as Float32Array<ArrayBuffer>, 0);
      const node = ctx.createBufferSource();
      node.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = 0.8;
      node.connect(g).connect(ctx.destination);
      const t0 = ctx.currentTime + 0.1;
      // the recording starts at song time offsetFrame / sr
      const recStart = src.offsetFrame / ctx.sampleRate;
      node.start(t0 + Math.max(0, recStart - span.start), Math.max(0, span.start - recStart));
      // a click on every note start (the song's notes)
      for (const n of notes) {
        if (n.start < span.start || n.start > span.end) continue;
        const at = t0 + (n.start - span.start);
        const o = ctx.createOscillator();
        const e = ctx.createGain();
        o.frequency.value = 1600;
        e.gain.setValueAtTime(0.0001, at);
        e.gain.exponentialRampToValueAtTime(0.35, at + 0.004);
        e.gain.exponentialRampToValueAtTime(0.0001, at + 0.06);
        o.connect(e).connect(ctx.destination);
        o.start(at);
        o.stop(at + 0.08);
      }
      setTimeout(() => {
        void ctx.close();
        setListening(false);
      }, (span.end - span.start + 0.4) * 1000);
    } catch {
      setListening(false);
    }
  };
  useEffect(() => () => void listen.current?.close().catch(() => {}), []);

  // ---------- frame & corners ----------
  const orientedUrl = useMemo(() => {
    if (!still) return null;
    return orientCanvas(still.canvas, still.w, still.h, cal).toDataURL('image/jpeg', 0.85);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [still, cal.turn, cal.mirror]);
  const [detectMsg, setDetectMsg] = useState<string | null>(null);
  const detect = (silent = false) => {
    if (!still) return;
    const c = orientCanvas(still.canvas, still.w, still.h, cal);
    const data = c.getContext('2d')!.getImageData(0, 0, c.width, c.height);
    const corners = findKeyboard(toGray(data.data, c.width, c.height));
    if (!corners || !cornersValid(corners)) {
      if (!silent) setDetectMsg('Couldn’t find the keyboard. Drag the dots onto its corners.');
      return;
    }
    setDetectMsg(silent ? null : 'Found it. Check the dots and adjust them if needed.');
    const next = { ...cal, corners };
    // the key count, from the straightened keyboard
    const strip = rectify(toGray(data.data, c.width, c.height), corners, 1600, 100);
    const p = guessRange(strip, KEY_PRESETS);
    setCal(p ? { ...next, lo: p.lo, hi: p.hi } : next);
  };
  const triedDetect = useRef(false);
  useEffect(() => {
    if (step === 'corners' && still && !hv.calibration && !triedDetect.current) {
      triedDetect.current = true;
      detect(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, still]);
  const makeClean = async () => {
    if (!frames) return;
    setCleaning(true);
    try {
      setClean(await frames.cleanFrame(9));
    } finally {
      setCleaning(false);
    }
  };

  // ---------- keys ----------
  const preset = presetFor(cal.lo, cal.hi);
  const [other, setOther] = useState(preset === 'other');
  const n = whitesBetween(cal.lo, cal.hi);
  const move = -(cal.edgeL + cal.edgeR) / 2;
  const stretch = cal.edgeR - cal.edgeL;
  const setMoveStretch = (m: number, st: number) => setCal((c) => ({ ...c, edgeL: -m - st / 2, edgeR: -m + st / 2 }));
  const outside = notesOutside(cal, notes);
  const runAutoMatch = () => {
    if (!still) return;
    const c = orientCanvas(still.canvas, still.w, still.h, cal);
    const g = toGray(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
    const m = autoMatch(rectify(g, cal.corners, 2000, 100), cal);
    if (m) setCal((x) => ({ ...x, edgeL: m.edgeL, edgeR: m.edgeR }));
    setDetectMsg(m ? 'Matched the lanes to the black keys.' : 'Couldn’t see the black keys clearly. Use the sliders.');
  };
  const stripWrap = useRef<HTMLDivElement>(null);
  const [wrapW, setWrapW] = useState(600);
  useEffect(() => {
    const el = stripWrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWrapW(el.clientWidth));
    ro.observe(el);
    setWrapW(el.clientWidth);
    return () => ro.disconnect();
  }, [step]);
  const [zoom, setZoom] = useState(1);
  const v0 = -0.12;
  const v1 = 1.08;
  const stripW = Math.round(wrapW * zoom);
  const stripH = Math.round(Math.min(220 * zoom, Math.max(48, (stripW / keyboardAspect(cal)) * (v1 - v0))));
  const stripRef = useRef<HTMLCanvasElement>(null);
  const [stripCanvas, setStripCanvas] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => setStripCanvas(stripRef.current), [step, zoom]);
  const calForStrip = useMemo(() => ({ ...cal }), [cal]);
  useStraightened(step === 'corners' || step === 'keys' ? stripCanvas : null, still, calForStrip, stripW, stripH, v0, v1);
  useEffect(() => {
    if (step !== 'keys' || !stripCanvas || !still) return;
    drawLanes(stripCanvas.getContext('2d')!, cal, stripW, stripH, v0, v1);
  }, [step, stripCanvas, still, cal, stripW, stripH]);
  const jumpToC4 = () => {
    const el = stripWrap.current;
    if (!el) return;
    const u = (uOfWhite(cal, Math.max(0, whiteKeys(cal.lo, 60).length - 1)) + 0.5 / n) * stripW;
    el.scrollLeft = Math.max(0, u - el.clientWidth / 2);
  };

  // ---------- framing / sync preview ----------
  const previewRef = useRef<HTMLCanvasElement>(null);
  const painter = useRef<PreviewPainter | null>(null);
  useEffect(
    () => () => {
      painter.current?.dispose();
      painter.current = null;
    },
    [],
  );
  const draftHv = useMemo<HandVideo>(() => ({ ...hv, calibration: cal }), [hv, cal]);
  const calibrated = !!hv0.calibration || si > 3;
  useEffect(() => {
    const c = previewRef.current;
    if (!c || (step !== 'framing' && !(step === 'sync' && calibrated))) return;
    painter.current ??= new PreviewPainter(640);
    painter.current.paint(c, {
      song,
      difficulty,
      visual,
      settings,
      time: songT,
      layout: settings.handsLayout === 'pip' ? 'pip' : 'bottom',
      hv: draftHv,
      frame: syncFrame?.canvas ?? null,
      frameW: syncFrame?.w,
      frameH: syncFrame?.h,
      watermark,
      logo,
    });
  }, [step, calibrated, song, difficulty, visual, settings, songT, draftHv, syncFrame, watermark, logo]);
  // before calibration: a flash dot on the frame when a note starts
  const noteNow = notes.some((x) => Math.abs(x.start - songT) < 0.06);

  const canNext = step === 'corners' ? cornersValid(cal.corners) : step === 'sync' ? sync.status !== 'running' : true;
  const save = () => onSave({ ...hv, calibration: { ...cal, frameTime: cal.frameTime } });
  const outW = settings.orientation === 'portrait' ? 9 : settings.orientation === 'square' ? 1 : 16;
  const outH = settings.orientation === 'portrait' ? 16 : settings.orientation === 'square' ? 1 : 9;

  // ---------- layout ----------
  const media = (() => {
    if (loadError) return <p className="p-4 text-[13px] text-bad">{loadError}</p>;
    if (!frames) return <div className="flex h-56 items-center justify-center text-ink-300"><Loader2 className="animate-spin" size={20} /></div>;
    switch (step) {
      case 'sync':
        return calibrated ? (
          <canvas ref={previewRef} className="mx-auto block max-h-[52vh] max-w-full rounded-md" style={{ aspectRatio: `${outW} / ${outH}` }} aria-label="Preview with the notes falling onto your video" />
        ) : (
          <div className="relative mx-auto max-w-full" style={{ aspectRatio: String(aspect), maxHeight: '52vh' }}>
            {syncFrame && <img alt="Your video at this point of the song" className="h-full w-full rounded-md object-contain" src={(syncFrame.canvas as HTMLCanvasElement).toDataURL('image/jpeg', 0.8)} />}
            <span className={cn('absolute top-3 right-3 h-6 w-6 rounded-full border-2 border-white transition-colors', noteNow ? 'bg-accent-400 shadow-[0_0_18px_6px_rgba(140,160,255,0.8)]' : 'bg-black/40')} aria-label={noteNow ? 'A note starts here' : undefined} />
          </div>
        );
      case 'frame':
        return still ? (
          <img alt="The frame used to set up the keyboard" className="mx-auto block max-h-[52vh] max-w-full rounded-md" src={orientedUrl ?? ''} />
        ) : (
          <div className="flex h-56 items-center justify-center"><Loader2 className="animate-spin" size={20} /></div>
        );
      case 'corners':
        return (
          <div className="flex flex-col gap-3">
            {orientedUrl && <QuadEditor image={orientedUrl} aspect={aspect} corners={cal.corners} labels={CORNER_LABELS} onChange={(corners) => setCal((c) => ({ ...c, corners }))} maxHeight="46vh" />}
            <div ref={stripWrap} className="overflow-hidden rounded-md bg-black">
              <canvas ref={stripRef} className="block w-full" aria-label="Your keyboard, straightened" />
            </div>
          </div>
        );
      case 'keys':
        return (
          <div className="flex flex-col gap-2">
            {orientedUrl && <img alt="" aria-hidden className="mx-auto hidden max-h-[24vh] max-w-full rounded-md sm:block" src={orientedUrl} />}
            <div ref={stripWrap} className={cn('rounded-md bg-black', zoom > 1 ? 'overflow-x-auto' : 'overflow-hidden')} data-testid="key-strip">
              <canvas ref={stripRef} style={{ width: stripW, height: stripH }} className="block" aria-label="Lanes over your keyboard" />
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-300">
              <Segmented size="sm" ariaLabel="Zoom" value={String(zoom)} onChange={(z) => setZoom(Number(z))} options={[{ value: '1', label: '1×' }, { value: '3', label: '3×' }]} />
              {zoom > 1 && (
                <button className="rounded-full border border-ink-600 px-2.5 py-1 hover:border-ink-400" onClick={jumpToC4}>
                  Jump to middle C
                </button>
              )}
              <span>Pink lines: white keys. Blue boxes: black keys.</span>
            </div>
          </div>
        );
      case 'framing':
        return <canvas ref={previewRef} className="mx-auto block max-h-[56vh] max-w-full rounded-md" style={{ aspectRatio: `${outW} / ${outH}` }} aria-label="Preview of the exported video" />;
    }
  })();

  const controls = (() => {
    switch (step) {
      case 'sync':
        return (
          <div className="flex flex-col gap-3" data-testid="sync-step">
            {hv.store === 'audio' ? (
              <p className="text-[13px] text-ink-200">This video is the song’s own recording, so it’s already in sync. You can still fine-tune it.</p>
            ) : sync.status === 'running' ? (
              <div className="flex flex-col gap-2" aria-live="polite">
                <span className="flex items-center gap-2 text-[13px] text-ink-100">
                  <Loader2 size={14} className="animate-spin text-accent-400" /> {sync.what}
                </span>
                <ProgressBar value={sync.progress} />
                <Button size="sm" variant="ghost" className="self-start" onClick={() => syncAbort.current?.abort()}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="flex flex-col gap-1.5" aria-live="polite">
                {hv.sync && hv.sync.method !== 'manual' && hv.sync.method !== 'import' ? (
                  <>
                    <p className="text-[13px] text-ink-100" data-testid="sync-result">
                      {offsetSentence(found)} Match: <b className={hv.sync.level === 'low' ? 'text-warn' : 'text-ok'}>{LEVEL_LABEL[hv.sync.level]}</b>
                    </p>
                    <p className="text-[11.5px] text-ink-400">Lined up with {hv.sync.method === 'original' ? 'the song’s recording' : 'the song’s notes'}.</p>
                    {hv.sync.level === 'low' && <p className="text-[12px] text-warn">Couldn’t find a clear match. Line it up by ear with the slider.</p>}
                    {hv.sync.drift && (
                      <p className="text-[12px] text-warn">
                        Your video doesn’t follow the song’s timing. It may be a different performance. Import the video itself instead (Import &gt; Audio/Video) so the
                        notes come from your playing.
                      </p>
                    )}
                  </>
                ) : (
                  <p className="text-[13px] text-ink-200">{offsetSentence(hv.offset)}</p>
                )}
                {sync.status === 'error' && <p className="text-[12px] text-bad">{sync.message}</p>}
                {hv.store === 'handcam' && (
                  <Button size="sm" icon={<Wand2 size={14} />} className="self-start" disabled={!blob} onClick={() => void runSync()}>
                    {hv.sync ? 'Find the sync again' : 'Find the sync'}
                  </Button>
                )}
                {hv.store === 'handcam' && <p className="text-[11.5px] text-ink-400">Compared with {syncReference(song) === 'original' ? 'the song’s recording' : 'the song’s notes'}.</p>}
              </div>
            )}
            <Slider
              label="Nudge"
              min={found - 5}
              max={found + 5}
              step={0.01}
              value={hv.offset}
              onChange={(offset) => setHv((h) => ({ ...h, offset, sync: h.sync ? { ...h.sync, method: h.sync.method } : { method: 'manual', found: offset, confidence: 0, level: 'low' } }))}
              format={(x) => `${x - found >= 0 ? '+' : ''}${((x - found) * 1000).toFixed(0)} ms`}
            />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setHv((h) => ({ ...h, offset: Math.round((h.offset - 0.01) * 1000) / 1000 }))}>
                −10 ms
              </Button>
              <Button size="sm" onClick={() => setHv((h) => ({ ...h, offset: Math.round((h.offset + 0.01) * 1000) / 1000 }))}>
                +10 ms
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setHv((h) => ({ ...h, offset: found }))}>
                Reset to found
              </Button>
            </div>
            <Slider label="Song position" min={0} max={song.duration} step={0.01} value={songT} onChange={setSongT} format={formatTime} />
            <Button size="sm" icon={<Volume2 size={14} />} className="self-start" disabled={!blob || listening} onClick={() => void playListen()}>
              {listening ? 'Playing…' : 'Listen (your video + clicks on the notes)'}
            </Button>
            <p className="text-[11.5px] text-ink-400">{calibrated ? 'The notes should land on the keys as they go down.' : 'The dot lights up on every note: it should flash as a key goes down.'}</p>
          </div>
        );
      case 'frame':
        return (
          <div className="flex flex-col gap-3">
            <p className="text-[13px] text-ink-200">Pick a moment where the whole keyboard is easy to see.</p>
            <Slider label="Video position" min={0} max={Math.max(0.1, hv.duration)} step={0.04} value={cal.frameTime} onChange={(frameTime) => { setClean(null); setCal((c) => ({ ...c, frameTime })); }} format={formatTime} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={cleaning ? <Loader2 size={14} className="animate-spin" /> : <Eraser size={14} />} disabled={cleaning || !frames} onClick={() => void makeClean()}>
                Clean frame (hide hands)
              </Button>
              <Button size="sm" icon={<RotateCw size={14} />} onClick={() => setCal((c) => ({ ...c, turn: c.turn === 180 ? 0 : 180 }))} aria-pressed={cal.turn === 180}>
                Turn 180°
              </Button>
              <Button size="sm" icon={<FlipHorizontal2 size={14} />} onClick={() => setCal((c) => ({ ...c, mirror: !c.mirror }))} aria-pressed={cal.mirror}>
                Mirror
              </Button>
            </div>
            <p className="text-[11.5px] text-ink-400">The lowest keys should be on the left. If the camera faces you, use Turn 180°; for a selfie camera, Mirror.</p>
          </div>
        );
      case 'corners':
        return (
          <div className="flex flex-col gap-3">
            <p className="text-[13px] text-ink-200">Drag the 4 dots onto the corners of the keys: 1 and 2 where the keys meet the back of the piano, 3 and 4 at the front edge.</p>
            <ol className="flex flex-col gap-0.5 text-[12px] text-ink-300">
              {CORNER_LABELS.map((l, i) => (
                <li key={l}>
                  {i + 1}. {l}
                </li>
              ))}
            </ol>
            <Button size="sm" icon={<Crosshair size={14} />} className="self-start" onClick={() => detect(false)}>
              Find the keyboard
            </Button>
            {detectMsg && <p className="text-[12px] text-ink-300">{detectMsg}</p>}
            {!cornersValid(cal.corners) && <p className="text-[12px] text-warn">The dots cross over. Put them in order around the keys.</p>}
            <p className="text-[11.5px] text-ink-400">Below the photo: your keyboard straightened. The keys should look straight and even.</p>
          </div>
        );
      case 'keys':
        return (
          <div className="flex flex-col gap-3">
            <p className="text-[13px] text-ink-200">Which keys are between the dots?</p>
            <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Keyboard size">
              {KEY_PRESETS.map((p) => (
                <button
                  key={p.id}
                  role="radio"
                  aria-checked={!other && preset === p.id}
                  onClick={() => {
                    setOther(false);
                    setCal((c) => ({ ...c, lo: p.lo, hi: p.hi }));
                  }}
                  className={cn('focus-ring rounded-full border px-3 py-1.5 text-[12px]', !other && preset === p.id ? 'border-accent-400 bg-accent-500/15 text-ink-50' : 'border-ink-600 text-ink-200 hover:border-ink-400')}
                >
                  {p.label}
                </button>
              ))}
              <button role="radio" aria-checked={other} onClick={() => setOther(true)} className={cn('focus-ring rounded-full border px-3 py-1.5 text-[12px]', other ? 'border-accent-400 bg-accent-500/15 text-ink-50' : 'border-ink-600 text-ink-200 hover:border-ink-400')}>
                Other
              </button>
            </div>
            {other && (
              <div className="grid grid-cols-2 gap-2">
                <Select<number> label="Leftmost key" value={cal.lo} onChange={(lo) => setCal((c) => ({ ...c, lo: Math.min(lo, c.hi - 12) }))} options={whiteKeys().map((m) => ({ value: m, label: noteName(m) }))} />
                <Select<number> label="Rightmost key" value={cal.hi} onChange={(hi) => setCal((c) => ({ ...c, hi: Math.max(hi, c.lo + 12) }))} options={whiteKeys().map((m) => ({ value: m, label: noteName(m) }))} />
              </div>
            )}
            <Slider label="Match the keys" min={-EDGE_RANGE} max={EDGE_RANGE} step={0.01} value={move} onChange={(m) => setMoveStretch(m, stretch)} format={(x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)} keys`} />
            <Slider label="Key width" min={-0.03 * n} max={0.03 * n} step={0.01} value={stretch} onChange={(st) => setMoveStretch(move, st)} format={(x) => `${x >= 0 ? '+' : ''}${((-x / n) * 100).toFixed(1)}%`} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={<Sparkles size={14} />} onClick={runAutoMatch}>
                Auto-match
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCal((c) => ({ ...c, edgeL: 0, edgeR: 0 }))}>
                Reset
              </Button>
            </div>
            {detectMsg && step === 'keys' && <p className="text-[12px] text-ink-300">{detectMsg}</p>}
            {outside > 0 && <p className="text-[12px] text-warn">{outside} {outside === 1 ? 'note is' : 'notes are'} outside the keys in your video and won’t be shown.</p>}
            <p className="text-[11.5px] text-ink-400">Line up the lanes with the real keys. Zoom in to check both ends.</p>
          </div>
        );
      case 'framing':
        return (
          <div className="flex flex-col gap-3">
            <Segmented<HandsLayout>
              size="sm"
              className="w-full"
              ariaLabel="Layout"
              value={settings.handsLayout === 'pip' ? 'pip' : 'bottom'}
              onChange={setLayout}
              options={[
                { value: 'bottom', label: 'Hands at the bottom' },
                { value: 'pip', label: 'Picture-in-picture' },
              ]}
            />
            <Slider label="Where notes land" min={HIT_V_RANGE[0]} max={HIT_V_RANGE[1]} step={0.01} value={cal.hitV} onChange={(hitV) => setCal((c) => ({ ...c, hitV }))} format={(x) => (Math.abs(x) < 0.005 ? 'Back of the keys' : `${x > 0 ? '+' : ''}${Math.round(x * 100)}% of a key`)} />
            <Slider label="Hands area" min={HANDS_RANGE[0]} max={HANDS_RANGE[1]} step={0.05} value={cal.hands} onChange={(hands) => setCal((c) => ({ ...c, hands }))} format={(x) => `${x.toFixed(2)} key lengths`} />
            <Slider label="Key length" min={KEY_LENGTH_RANGE[0]} max={KEY_LENGTH_RANGE[1]} step={0.01} value={cal.keyLength} onChange={(keyLength) => setCal((c) => ({ ...c, keyLength }))} format={(x) => `${Math.round(x * 100)}%`} />
            <div className="flex flex-col gap-1">
              <span className="text-[12.5px] text-ink-200">Show keys</span>
              <Segmented<KeyboardCalibration['view']> size="sm" ariaLabel="Show keys" value={cal.view} onChange={(view) => setCal((c) => ({ ...c, view }))} options={[{ value: 'all', label: 'All' }, { value: 'song', label: 'Just the ones in this song' }]} />
            </div>
            <Slider label="Preview position" min={0} max={song.duration} step={0.01} value={songT} onChange={setSongT} format={formatTime} />
            {noteSpan(notes) === null && <p className="text-[12px] text-ink-400">This song has no notes yet.</p>}
          </div>
        );
    }
  })();

  return (
    <div className="fixed inset-0 z-[60] flex items-stretch justify-center bg-black/70 backdrop-blur-sm sm:items-center sm:p-5" role="dialog" aria-modal="true" aria-label="Set up your hands video" data-testid="hands-setup">
      <div className="panel flex h-full w-full flex-col overflow-hidden sm:h-auto sm:max-h-[94dvh] sm:max-w-6xl">
        <header className="flex items-center justify-between gap-3 border-b border-ink-700 px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-[15px] font-semibold text-ink-50">Set up your hands video</h2>
            <p className="text-[12px] text-ink-300" data-testid="hands-step">
              Step {si + 1} of {steps.length} · {STEP_TITLE[step]}
            </p>
          </div>
          <button className="focus-ring rounded-lg p-1.5 text-ink-300 hover:bg-ink-800 hover:text-ink-50" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="flex gap-1 px-4 pt-2" aria-hidden>
          {steps.map((s, i) => (
            <span key={s} className={cn('h-1 flex-1 rounded-full', i <= si ? 'bg-accent-500' : 'bg-ink-700')} />
          ))}
        </div>
        <div className="grid min-h-0 flex-1 content-start overflow-y-auto lg:grid-cols-[1fr_340px] lg:content-normal lg:overflow-hidden">
          <div className="min-w-0 p-3 sm:p-4 lg:overflow-y-auto">{media}</div>
          <div className="border-t border-ink-700 p-4 lg:overflow-y-auto lg:border-t-0 lg:border-l">{controls}</div>
        </div>
        <footer className="sticky bottom-0 flex items-center justify-between gap-2 border-t border-ink-700 bg-ink-900 px-4 py-3">
          <Button variant="ghost" icon={<ArrowLeft size={15} />} disabled={si === 0} onClick={() => setSi((i) => Math.max(0, i - 1))}>
            Back
          </Button>
          {si < steps.length - 1 ? (
            <Button variant="primary" icon={<ArrowRight size={15} />} disabled={!canNext} onClick={() => setSi((i) => i + 1)}>
              Next
            </Button>
          ) : (
            <Button variant="primary" icon={<Check size={15} />} onClick={save}>
              Save
            </Button>
          )}
        </footer>
      </div>
    </div>
  );
}
