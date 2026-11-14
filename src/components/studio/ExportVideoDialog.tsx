import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, Film, Loader2, Save, Trash2, SquarePlay, Smartphone, Square, Zap, AlertTriangle } from 'lucide-react';
import { Button, Modal, ProgressBar, Segmented, Select, Slider, Toggle, Badge, cn } from '../ui';
import { useSettings } from '../../state/settingsStore';
import { useStudio } from '../../state/studioStore';
import { useTransport } from '../../state/transportStore';
import { EXPORT_PRESETS, outputSize, type ExportSettings, type ExportSound } from '../../lib/export/types';
import { exportRange, exportVideo, jobHandsLayout, webCodecsAvailable, type ExportProgress, type ExportResult } from '../../lib/export/videoExport';
import { effectiveRate, effectiveSound, exportTimeline, originalGain, soundWithoutPiano, usesHandsSound, usesOriginalRecording } from '../../lib/export/originalMix';
import { useShallow } from 'zustand/react/shallow';
import { useWatermark, watermarkSettings } from '../../state/watermarkStore';
import { watermarkActive, type WatermarkSettings } from '../../lib/watermark/types';
import type { HandsLayout } from '../../lib/handcam/types';
import { PreviewPainter } from '../handcam/previewPainter';
import { useHandFrames, useHeldFrame, useLogo, useVideoFrame } from '../handcam/hooks';
import { HandsSection } from '../handcam/HandsSection';
import { WatermarkSection } from '../handcam/WatermarkSection';
import { HandsSetup } from '../handcam/HandsSetup';
import { VISUAL_THEMES, applyTheme } from '../../lib/render/settings';
import { downloadBlob, safeFileName } from '../../lib/export/downloads';
import { showExportNoticeOnce } from '../../lib/exportNotice';
import { formatTime } from '../../lib/music/theory';
import { getMedia, hasStoredAudio } from '../../lib/storage/db';
import { newId } from '../../lib/storage/db';
import { useDecalImage } from './useDecalImage';
import { useCanvasRestored } from './useCanvasRestored';
import { TitleCardPanel, titleCardJob, useTitleCardSeconds } from './TitleCardPanel';
import type { TitleCardJob } from '../../lib/render/titleCard/exportHooks';

const presetIcons: Record<string, typeof SquarePlay> = { youtube: SquarePlay, shorts: Smartphone, square: Square, quick: Zap };

const PHASE_LABEL: Record<ExportProgress['phase'], string> = {
  preparing: 'Preparing encoders',
  original: 'Loading the original song',
  handsAudio: 'Reading your video’s sound',
  audio: 'Rendering the sound',
  video: 'Rendering frames',
  handsVideo: 'Drawing frames (decoding your video)',
  finalizing: 'Finalizing file',
};

const SOUND_LABEL: Record<ExportSound, string> = { piano: 'piano', original: 'original song', both: 'piano + original song', hands: 'video sound', 'hands+piano': 'video sound + piano' };

/** Whether the open song's original recording is still stored ('checking' while we look). */
function useStoredOriginal(songId: string | undefined, hasAudio: boolean | undefined, open: boolean): 'checking' | 'yes' | 'no' {
  const [state, setState] = useState<{ id: string; has: boolean } | null>(null);
  useEffect(() => {
    if (!open || !songId || !hasAudio) return;
    let alive = true;
    void hasStoredAudio(songId)
      .catch(() => false)
      .then((has) => alive && setState({ id: songId, has }));
    return () => {
      alive = false;
    };
  }, [songId, hasAudio, open]);
  if (!songId || !hasAudio) return 'no';
  if (!state || state.id !== songId) return 'checking';
  return state.has ? 'yes' : 'no';
}

/** `active` false (the setup screen is open, an export runs): the hands video file is let go of and the last frame stays. */
function CompositionPreview({ settings, previewTime, layout, watermark, active }: { settings: ExportSettings; previewTime: number; layout: HandsLayout; watermark: WatermarkSettings | null; active: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const song = useStudio((s) => s.song)!;
  const difficulty = useStudio((s) => s.difficulty);
  const visual = useSettings((s) => s.visual);
  const { width, height } = outputSize(settings);
  const [bgSource, setBgSource] = useState<CanvasImageSource | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let alive = true;
    const b = visual.background;
    if (!b.mediaId || (b.kind !== 'image' && b.kind !== 'video')) {
      setBgSource(null);
      return;
    }
    void getMedia(b.mediaId).then((m) => {
      if (!m || !alive) return;
      url = URL.createObjectURL(m.blob);
      if (m.kind === 'image') {
        const img = new Image();
        img.onload = () => alive && setBgSource(img);
        img.src = url;
      } else {
        const v = document.createElement('video');
        v.muted = true;
        v.src = url;
        v.onloadeddata = () => alive && setBgSource(v);
      }
    });
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [visual.background]);
  const decalImg = useDecalImage(visual.decal);
  const restored = useCanvasRestored(ref);
  const hv = layout !== 'off' ? (song.handVideo ?? null) : null;
  const { frames } = useHandFrames(song, !!hv && active);
  const frame = useHeldFrame(useVideoFrame(frames, hv ? previewTime + hv.offset : null, 60), hv ? `${song.id}|${hv.addedAt}|${previewTime + hv.offset}` : '');
  const logo = useLogo(watermark?.logo?.mediaId);
  const painter = useRef<PreviewPainter | null>(null);
  useEffect(
    () => () => {
      painter.current?.dispose();
      painter.current = null;
    },
    [],
  );
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    painter.current ??= new PreviewPainter(720);
    painter.current.paint(c, {
      song,
      difficulty,
      visual,
      settings,
      time: previewTime,
      layout,
      hv,
      frame: frame?.canvas ?? null,
      frameW: frame?.w,
      frameH: frame?.h,
      watermark,
      logo,
      bg: bgSource ? { source: bgSource, kind: visual.background.kind === 'video' ? 'video' : 'image' } : null,
      decal: decalImg ? { source: decalImg.source, width: decalImg.width, height: decalImg.height } : null,
    });
  }, [settings, visual, song, difficulty, previewTime, width, height, bgSource, decalImg, restored, layout, hv, frame, watermark, logo]);
  return (
    <div className="flex h-full min-h-[220px] items-center justify-center rounded-xl bg-[repeating-conic-gradient(#15151b_0_25%,#101014_0_50%)] bg-[length:20px_20px] p-3">
      <canvas
        ref={ref}
        className="max-h-[48vh] max-w-full rounded-md shadow-2xl ring-1 ring-white/10"
        style={{ aspectRatio: `${width} / ${height}` }}
        aria-label="Video composition preview"
        data-testid="export-preview"
      />
    </div>
  );
}

/** A title page warning from a run that was cancelled or replaced must not show for the new one. */
function gateWarnings(tc: TitleCardJob | undefined, current: () => boolean): TitleCardJob | undefined {
  if (!tc?.onWarning) return tc;
  const warn = tc.onWarning;
  return { ...tc, onWarning: (message) => current() && warn(message) };
}

export function ExportVideoDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const song = useStudio((s) => s.song);
  const difficulty = useStudio((s) => s.difficulty);
  const loop = useTransport((s) => (s.loopEnabled ? s.loop : null));
  const settings = useSettings((s) => s.exportSettings);
  const setExport = useSettings((s) => s.setExport);
  const presets = useSettings((s) => s.exportPresets);
  const setSettings = useSettings((s) => s.set);
  const visual = useSettings((s) => s.visual);
  const replaceVisual = useSettings((s) => s.replaceVisual);
  const setLabels = useSettings((s) => s.setLabels);
  const audio = useSettings((s) => s.audio);
  const titleSeconds = useTitleCardSeconds(song, settings.fps); // title page + end card
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [previewFrac, setPreviewFrac] = useState(0.15);
  const abort = useRef<AbortController | null>(null);
  // a cancelled export can still be finishing (decoding the original can't be stopped part-way);
  // Render stays off until it has, so two exports never run at once
  const [stopping, setStopping] = useState(false);
  const running = useRef<Promise<void> | null>(null);
  const stored = useStoredOriginal(song?.id, song?.hasAudio, open);
  const updateSong = useStudio((s) => s.updateSong);
  const wmAll = useWatermark(useShallow(watermarkSettings));
  const watermark = watermarkActive(wmAll) ? wmAll : null;
  const [setup, setSetup] = useState<{ autoStart: boolean } | null>(null);
  /** the setup screen's own close (it asks before throwing away unsaved changes) */
  const setupClose = useRef<(() => void) | null>(null);

  useEffect(() => () => {
    if (resultUrl) URL.revokeObjectURL(resultUrl);
  }, [resultUrl]);

  const webCodecs = webCodecsAvailable();
  const hasHandsSound = song?.handVideo?.store === 'handcam';
  const sound = effectiveSound(settings, { hasOriginal: stored === 'yes', webCodecs, hasHandsSound });
  const handsLayout = song ? jobHandsLayout({ song, settings }) : 'off';
  const range = useMemo(() => (song ? exportRange({ song, settings, loop }, sound) : { start: 0, end: 0 }), [song, settings, loop, sound]);
  if (!song) return null;
  const { width, height } = outputSize(settings);
  const usesOriginal = sound !== 'piano';
  /** the song was imported from a video of the user playing: its "original" is their own playing */
  const ownVideo = song.handVideo?.store === 'audio';
  const rate = effectiveRate(settings, sound, handsLayout !== 'off');
  const soundOptions: { value: ExportSound; label: string }[] = [{ value: 'piano', label: 'Piano' }];
  if (stored !== 'no') soundOptions.push({ value: 'original', label: ownVideo ? 'Your playing' : 'Original song' }, { value: 'both', label: ownVideo ? 'Your playing + piano' : 'Both' });
  if (hasHandsSound) soundOptions.push({ value: 'hands', label: 'Video sound' }, { value: 'hands+piano', label: 'Video sound + piano' });
  const outDur = exportTimeline(settings, range, rate).duration;
  const origVolume = originalGain(settings, audio.originalVolume);
  const waitingForCheck = stored === 'checking' && usesOriginalRecording(settings.sound);
  const previewTime = range.start + previewFrac * (range.end - range.start);
  const rendering = progress !== null && !result && !error;
  const busy = rendering || stopping;
  const longExport = outDur + titleSeconds > 600;

  const start = async () => {
    if (running.current) return;
    setError(null);
    setResult(null);
    if (resultUrl) URL.revokeObjectURL(resultUrl);
    setResultUrl(null);
    const ac = new AbortController();
    abort.current = ac;
    // only the current run may update the dialog
    const current = () => abort.current === ac && !ac.signal.aborted;
    setProgress({ phase: 'preparing', fraction: 0 });
    const run = (async () => {
      try {
        const r = await exportVideo({
          song,
          difficulty,
          visual,
          audio,
          settings: { ...settings, sound },
          loop,
          signal: ac.signal,
          watermark: watermark ?? undefined,
          onProgress: (p) => current() && setProgress(p),
          titleCard: gateWarnings(titleCardJob(song, visual), current),
        });
        if (!current()) return;
        setResult(r);
        setResultUrl(URL.createObjectURL(r.blob));
      } catch (e) {
        if (!current()) return;
        if ((e as Error).name === 'AbortError') {
          setProgress(null);
          return;
        }
        setError((e as Error).message);
      }
    })();
    running.current = run;
    await run;
    running.current = null;
    setStopping(false);
  };

  /** stops the current export; Render comes back once it has really stopped */
  const stop = () => {
    abort.current?.abort();
    abort.current = null;
    if (running.current) setStopping(true);
  };

  const cancel = () => {
    stop();
    setProgress(null);
  };

  const close = () => {
    if (rendering && !confirm('Stop the export in progress?')) return;
    stop();
    setProgress(null);
    setResult(null);
    setError(null);
    onClose();
  };

  const fileName = `${safeFileName(song.title)} - ${difficulty} - ${width}x${height}.${result?.extension ?? settings.format}`;

  return (
    // while the hands video setup covers the screen, the dialog under it is not drawn (a blurred backdrop
    // redrawn under it slows everything else that needs the graphics process) and Escape closes the setup only
    <Modal open={open} onClose={setup ? () => (setupClose.current ? setupClose.current() : setSetup(null)) : close} title="Export video" wide hidden={!!(setup && song.handVideo)} noBlur>
      <div className="grid gap-0 lg:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-3 border-b border-ink-700 p-4 lg:border-r lg:border-b-0">
          {result && resultUrl ? (
            <div className="flex flex-col gap-3">
              <video src={resultUrl} controls className="max-h-[52vh] w-full rounded-xl bg-black" aria-label="Rendered video preview" />
              <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-300">
                <Badge tone="ok">Done</Badge>
                <span>
                  {result.width}×{result.height} · {formatTime(result.duration)} · {(result.blob.size / 1024 / 1024).toFixed(1)} MB · {result.videoCodec.toUpperCase()} + {result.audioCodec.toUpperCase()} · {SOUND_LABEL[result.sound]}
                </span>
              </div>
              {result.extension === 'mp4' && result.videoCodec !== 'avc' && (
                <p className="text-[12px] text-warn">This browser couldn’t encode H.264, so the MP4 uses {result.videoCodec.toUpperCase()}. It plays in modern browsers, VLC and YouTube, but some older players may not support it.</p>
              )}
              <div className="flex gap-2">
                <Button variant="primary" icon={<Download size={16} />} onClick={() => { downloadBlob(result.blob, fileName); showExportNoticeOnce(); }}>
                  Download {result.extension.toUpperCase()}
                </Button>
                <Button variant="ghost" onClick={() => { setResult(null); setProgress(null); }}>
                  Back to settings
                </Button>
              </div>
            </div>
          ) : (
            <>
              <CompositionPreview settings={settings} previewTime={previewTime} layout={handsLayout} watermark={watermark} active={!setup && !busy} />
              <div className="flex items-center gap-3">
                <span className="w-10 font-mono text-[11.5px] text-ink-300">{formatTime(previewTime)}</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.001}
                  value={previewFrac}
                  onChange={(e) => setPreviewFrac(parseFloat(e.target.value))}
                  aria-label="Preview position"
                  style={{ ['--fill' as string]: `${previewFrac * 100}%` }}
                />
              </div>
              {rendering && progress && (
                <div className="flex flex-col gap-2 rounded-xl border border-ink-700 bg-ink-900 p-3" aria-live="polite">
                  <div className="flex items-center justify-between text-[12.5px]">
                    <span className="flex items-center gap-2 text-ink-100">
                      <Loader2 size={14} className="animate-spin text-accent-400" />
                      {PHASE_LABEL[progress.phase]}
                    </span>
                    <span className="font-mono text-ink-300">{Math.round(progress.fraction * 100)}%</span>
                  </div>
                  <ProgressBar value={progress.fraction} />
                  {progress.framesDone !== undefined && (
                    <p className="font-mono text-[11.5px] text-ink-300">
                      frame {progress.framesDone}/{progress.framesTotal}
                      {progress.renderFps !== undefined && ` · ${progress.renderFps.toFixed(0)} fps · ~${formatTime(progress.etaSeconds ?? 0)} left`}
                    </p>
                  )}
                  <Button size="sm" variant="ghost" onClick={cancel} className="self-start">
                    Cancel
                  </Button>
                </div>
              )}
              {error && (
                <p className="flex gap-2 rounded-lg border border-bad/30 bg-bad/10 px-3 py-2 text-[12.5px] text-bad">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {error}
                </p>
              )}
            </>
          )}
        </div>

        <div className={cn('flex max-h-[70vh] flex-col overflow-y-auto', rendering && 'pointer-events-none opacity-50')}>
          <div className="flex flex-col gap-3 border-b border-ink-700 p-4">
            <span className="text-[11px] font-semibold tracking-[0.08em] text-ink-300 uppercase">Presets</span>
            <div className="grid grid-cols-2 gap-2">
              {EXPORT_PRESETS.map((p) => {
                const Icon = presetIcons[p.id] ?? Film;
                return (
                  <button
                    key={p.id}
                    onClick={() => setExport(p.patch)}
                    className="focus-ring flex flex-col gap-0.5 rounded-xl border border-ink-700 bg-ink-800 p-2.5 text-left hover:border-ink-500"
                  >
                    <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-ink-50">
                      <Icon size={14} className={p.id === 'youtube' ? 'text-bad' : 'text-accent-400'} /> {p.name}
                    </span>
                    <span className="text-[11px] text-ink-300">{p.description}</span>
                  </button>
                );
              })}
            </div>
            {presets.length > 0 && (
              <ul className="flex flex-col gap-1">
                {presets.map((p) => (
                  <li key={p.id} className="flex items-center gap-2 text-[12.5px]">
                    <button className="flex-1 truncate rounded-md px-2 py-1 text-left text-ink-100 hover:bg-ink-800" onClick={() => setExport(p.settings)}>
                      {p.name}
                    </button>
                    <button aria-label={`Delete preset ${p.name}`} className="text-ink-400 hover:text-bad" onClick={() => setSettings({ exportPresets: presets.filter((x) => x.id !== p.id) })}>
                      <Trash2 size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <Button
              size="sm"
              variant="ghost"
              icon={<Save size={14} />}
              onClick={() => {
                const name = prompt('Name this export preset', `${settings.orientation} ${settings.resolution}p${settings.fps}`);
                if (name) setSettings({ exportPresets: [...presets, { id: newId(), name, settings }] });
              }}
            >
              Save current as preset
            </Button>
          </div>

          <div className="flex flex-col gap-3 border-b border-ink-700 p-4">
            <span className="text-[11px] font-semibold tracking-[0.08em] text-ink-300 uppercase">Format</span>
            <Segmented<ExportSettings['orientation']>
              size="sm"
              value={settings.orientation}
              onChange={(orientation) => setExport({ orientation })}
              options={[
                { value: 'landscape', label: '16:9' },
                { value: 'portrait', label: '9:16' },
                { value: 'square', label: '1:1' },
              ]}
            />
            <div className="grid grid-cols-2 gap-2">
              <Select<ExportSettings['resolution']>
                label="Resolution"
                value={settings.resolution}
                onChange={(resolution) => setExport({ resolution })}
                options={[
                  { value: 720, label: '720p' },
                  { value: 1080, label: '1080p' },
                  { value: 1440, label: '1440p' },
                ]}
              />
              <Select<ExportSettings['fps']>
                label="Frame rate"
                value={settings.fps}
                onChange={(fps) => setExport({ fps })}
                options={[
                  { value: 30, label: '30 FPS' },
                  { value: 60, label: '60 FPS' },
                ]}
              />
              <Select<ExportSettings['format']>
                label="Container"
                value={settings.format}
                onChange={(format) => setExport({ format })}
                options={[
                  { value: 'mp4', label: 'MP4' },
                  { value: 'webm', label: 'WebM' },
                ]}
              />
              <Select<ExportSettings['quality']>
                label="Quality"
                value={settings.quality}
                onChange={(quality) => setExport({ quality })}
                options={[
                  { value: 'high', label: 'High' },
                  { value: 'standard', label: 'Standard' },
                ]}
              />
            </div>
            <p className="font-mono text-[11px] text-ink-400">
              {width}×{height} · {formatTime(outDur + titleSeconds)} · {(Math.ceil(outDur * settings.fps) + Math.round(titleSeconds * settings.fps)).toLocaleString()} frames
            </p>
            {!webCodecs && <p className="text-[12px] text-warn">WebCodecs isn’t available in this browser: the video will be recorded in real time as WebM.</p>}
            {longExport && <p className="text-[12px] text-warn">Long export — rendering can take several minutes. Keep this tab open.</p>}
          </div>

          <HandsSection song={song} settings={settings} setExport={setExport} updateSong={updateSong} onSetup={(autoStart) => setSetup({ autoStart })} webCodecs={webCodecs} paused={!!setup || busy} />
          <div className="flex flex-col gap-3 border-b border-ink-700 p-4">
            <span className="text-[11px] font-semibold tracking-[0.08em] text-ink-300 uppercase">Content</span>
            <div className="flex flex-col gap-2">
              <span className="text-[12.5px] text-ink-200">Sound</span>
              {!webCodecs ? (
                <p className="text-[12px] text-ink-400">This browser can only add the piano sound.</p>
              ) : soundOptions.length === 1 ? (
                <p className="text-[12px] text-ink-400">This song has no saved recording, so the video uses the piano sound.</p>
              ) : soundOptions.length <= 3 ? (
                <Segmented<ExportSound>
                  size="sm"
                  className="w-full"
                  ariaLabel="Sound"
                  value={stored === 'checking' ? settings.sound : sound}
                  onChange={(next) => setExport({ sound: next })}
                  options={soundOptions}
                />
              ) : (
                <Select<ExportSound> value={stored === 'checking' ? settings.sound : sound} onChange={(next) => setExport({ sound: next })} options={soundOptions} />
              )}
              {usesOriginal && (
                <>
                  <Slider
                    label={usesHandsSound(sound) ? 'Video sound volume' : ownVideo ? 'Your playing volume' : 'Original song volume'}
                    min={0.05}
                    max={1.5}
                    value={origVolume}
                    onChange={(originalVolume) => setExport({ originalVolume })}
                    format={(x) => `${Math.round(x * 100)}%`}
                  />
                  {usesOriginalRecording(sound) && !ownVideo && <p className="text-[12px] text-warn">Includes the original recording — only share it if you have the rights.</p>}
                </>
              )}
            </div>
            <Segmented<ExportSettings['range']>
              size="sm"
              value={settings.range}
              onChange={(range) => setExport({ range })}
              options={[
                { value: 'full', label: 'Full song' },
                { value: 'loop', label: loop ? 'Loop A–B' : 'Loop (none)' },
                { value: 'custom', label: 'Custom' },
              ]}
            />
            {settings.range === 'custom' && (
              <div className="grid grid-cols-2 gap-2">
                <Slider label="Start" min={0} max={song.duration} step={0.1} value={Math.min(settings.customStart, song.duration)} onChange={(customStart) => setExport({ customStart })} format={formatTime} />
                <Slider label="End" min={0} max={song.duration} step={0.1} value={Math.min(settings.customEnd, song.duration)} onChange={(customEnd) => setExport({ customEnd })} format={formatTime} />
              </div>
            )}
            <div className="flex flex-col gap-1">
              <Slider label="Playback speed" min={0.5} max={1.5} step={0.05} value={rate} disabled={usesOriginal || handsLayout !== 'off'} onChange={(rate) => setExport({ rate })} format={(x) => `${x.toFixed(2)}×`} />
              {handsLayout !== 'off' ? (
                <p className="text-[11.5px] text-ink-400">Speed stays at 100% with a hands video.</p>
              ) : (
                usesOriginal && <p className="text-[11.5px] text-ink-400">Speed stays at 100% when a recording is included.</p>
              )}
            </div>
            {!soundWithoutPiano(sound) && (
              <Slider label={sound === 'both' || sound === 'hands+piano' ? 'Piano volume' : 'Volume'} min={0.2} max={1.5} value={settings.volume} onChange={(volume) => setExport({ volume })} format={(x) => `${Math.round(x * 100)}%`} />
            )}
            <Slider label="Lead-in" min={0} max={6} step={0.5} value={settings.leadIn} onChange={(leadIn) => setExport({ leadIn })} format={(x) => `${x}s`} />
            <Slider label="Fade in" min={0} max={4} step={0.25} value={settings.fadeIn} onChange={(fadeIn) => setExport({ fadeIn })} format={(x) => `${x}s`} />
            <Slider label="Fade out" min={0} max={6} step={0.25} value={settings.fadeOut} onChange={(fadeOut) => setExport({ fadeOut })} format={(x) => `${x}s`} />
          </div>

          <div className="flex flex-col gap-3 p-4">
            <span className="text-[11px] font-semibold tracking-[0.08em] text-ink-300 uppercase">Look</span>
            <Select
              label="Theme"
              value=""
              onChange={(id) => id && replaceVisual(applyTheme(visual, id))}
              options={[{ value: '', label: 'Current Studio look' }, ...VISUAL_THEMES.map((t) => ({ value: t.id, label: t.name }))]}
            />
            <Toggle label="Show keyboard" checked={settings.showKeyboard} onChange={(showKeyboard) => setExport({ showKeyboard })} />
            <Select<ExportSettings['keyboardRange']>
              label="Keyboard range"
              value={settings.keyboardRange}
              onChange={(keyboardRange) => setExport({ keyboardRange })}
              options={[
                { value: 'match', label: 'Same as Studio' },
                { value: 'auto', label: 'Fit to song (bigger keys)' },
                { value: 'full', label: 'Full 88 keys' },
              ]}
            />
            <Toggle label="Note labels" checked={visual.labels.style !== 'none'} onChange={(on) => setLabels({ style: on ? 'letter' : 'none' })} />
            {song.arrangements[difficulty]?.notes.some((n) => n.finger) && (
              <Toggle label="Fingering" hint="The finger numbers added on the sheet music" checked={visual.labels.fingering !== false} onChange={(fingering) => setLabels({ fingering })} />
            )}
            <p className="text-[11.5px] leading-relaxed text-ink-400">Colors, effects, labels and backgrounds come from the Studio’s Look and Labels tabs.</p>
          </div>
          <WatermarkSection />
          <TitleCardPanel song={song} exportSettings={settings} visual={visual} />
        </div>
      </div>
      {!result && (
        <footer className="flex items-center justify-between gap-2 border-t border-ink-700 px-5 py-3">
          <span className="text-[12px] text-ink-300">
            {song.title} · <span className="capitalize">{difficulty}</span>
          </span>
          <Button variant="primary" disabled={busy || waitingForCheck || (settings.range === 'loop' && !loop)} onClick={() => void start()} icon={busy ? <Loader2 size={16} className="animate-spin" /> : <Film size={16} />}>
            {rendering ? 'Rendering…' : stopping ? 'Stopping…' : 'Render video'}
          </Button>
        </footer>
      )}
      {setup && song.handVideo && (
        <HandsSetupHost song={song} difficulty={difficulty} visual={visual} settings={settings} watermark={watermark} autoStart={setup.autoStart} closeRef={setupClose} setLayout={(handsLayout) => setExport({ handsLayout })} onClose={() => setSetup(null)} onSave={(hv) => { updateSong({ handVideo: hv }); if (settings.handsLayout === 'off') setExport({ handsLayout: hv.calibration ? 'bottom' : 'pip' }); setSetup(null); }} />
      )}
    </Modal>
  );
}

function HandsSetupHost(props: Omit<Parameters<typeof HandsSetup>[0], 'logo'>) {
  const logo = useLogo(props.watermark?.logo?.mediaId);
  // on the page itself: inside the dialog (which animates with a transform) "fixed" would not cover the screen
  return createPortal(<HandsSetup {...props} logo={logo} />, document.body);
}
