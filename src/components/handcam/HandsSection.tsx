/**
 * "Hands video" section of the Export video dialog: add a video of your hands playing (synced
 * automatically), set it up, choose the layout (under the falling notes, or a picture-in-picture).
 */
import { useRef, useState } from 'react';
import { Loader2, RefreshCw, SlidersHorizontal, Trash2, Video } from 'lucide-react';
import { Button, Segmented, Slider, Toggle, cn } from '../ui';
import type { Song } from '../../lib/music/types';
import type { ExportSettings } from '../../lib/export/types';
import type { Corner, HandVideo, HandsLayout } from '../../lib/handcam/types';
import { keyRangeLabel } from '../../lib/handcam/calibration';
import { offsetSentence } from '../../lib/handcam/syncRun';
import { HEVC_MESSAGE, handVideoFrom, probeVideo } from '../../lib/handcam/media';
import { deleteHandVideoBlob, requestPersistence, saveHandVideoBlob, storageEstimate } from '../../lib/storage/db';
import { isMemoryConstrained, pageDeviceInfo } from '../../lib/transcription/backendChoice';
import { checkVideoForKeeping } from '../import/HandsVideoImport';
import { useHandFrames, useVideoFrame } from './hooks';
import { formatTime } from '../../lib/music/theory';

const LEVEL_LABEL = { high: 'High', medium: 'Medium', low: 'Low' } as const;
const CORNERS: { value: Corner; label: string }[] = [
  { value: 'tl', label: 'Top left' },
  { value: 'tr', label: 'Top right' },
  { value: 'bl', label: 'Bottom left' },
  { value: 'br', label: 'Bottom right' },
];

export function isPhone(): boolean {
  const d = pageDeviceInfo();
  return !!d && isMemoryConstrained(d);
}

/** A one-line sync summary for a song's hands video. */
export function syncSummary(hv: HandVideo): string {
  if (hv.store === 'audio') return 'In sync: it’s the song’s own recording.';
  const s = hv.sync;
  if (!s) return `Not synced yet. ${offsetSentence(hv.offset)}`;
  if (s.method === 'manual') return `Lined up by hand. ${offsetSentence(hv.offset)}`;
  return `${offsetSentence(hv.offset)} Match: ${LEVEL_LABEL[s.level]}.`;
}

function Thumb({ song }: { song: Song }) {
  const { frames, error } = useHandFrames(song);
  const hv = song.handVideo!;
  const t = hv.calibration?.frameTime ?? Math.min(hv.duration / 2, 2);
  const img = useVideoFrame(frames, t, 0);
  const url = img ? (img.canvas as HTMLCanvasElement).toDataURL('image/jpeg', 0.7) : null;
  return (
    <div className="flex h-[54px] w-[96px] shrink-0 items-center justify-center overflow-hidden rounded-md bg-black ring-1 ring-white/10">
      {url ? <img src={url} alt="Your hands video" className="h-full w-full object-cover" /> : error ? <Video size={16} className="text-ink-400" /> : <Loader2 size={14} className="animate-spin text-ink-400" />}
    </div>
  );
}

export function HandsSection({
  song,
  settings,
  setExport,
  updateSong,
  onSetup,
  webCodecs,
}: {
  song: Song;
  settings: ExportSettings;
  setExport: (p: Partial<ExportSettings>) => void;
  updateSong: (p: Partial<Song>) => void;
  /** open the setup screen (autoStart: run the automatic sync first) */
  onSetup: (autoStart: boolean) => void;
  webCodecs: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hv = song.handVideo;
  const layout: HandsLayout = hv ? (settings.handsLayout ?? 'off') : 'off';
  const phone = isPhone();

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    const est = await storageEstimate().catch(() => null);
    if (est && est.quota && file.size > (est.quota - est.usage) * 0.9) {
      setError('There isn’t enough room in this browser to keep this video. Free some space or use a shorter video.');
      return;
    }
    if ((await checkVideoForKeeping(file, { phone, free: null, confirm: (m) => window.confirm(m) })) !== 'keep') return;
    setAdding('Reading your video…');
    try {
      const probe = await probeVideo(file);
      if (!probe.canDecode) throw new Error(HEVC_MESSAGE);
      setAdding('Saving your video…');
      void requestPersistence();
      await saveHandVideoBlob(song.id, file, file.name);
      const next = handVideoFrom(file, probe, { store: 'handcam', offset: 0 });
      // a new video keeps the old keyboard setup only if it is the same size (often the same camera)
      if (hv?.calibration && hv.displayW === next.displayW && hv.displayH === next.displayH) next.calibration = hv.calibration;
      updateSong({ handVideo: next });
      const patch: Partial<ExportSettings> = { handsLayout: settings.handsLayout === 'pip' ? 'pip' : 'bottom' };
      // phones: 720p 30 FPS is faster and safer
      if (phone) Object.assign(patch, { resolution: 720, fps: 30 });
      setExport(patch);
      onSetup(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAdding(null);
    }
  };

  const remove = async () => {
    if (!hv) return;
    if (!window.confirm(hv.store === 'audio' ? 'Stop using this video as a hands video? The song keeps its sound.' : 'Remove the hands video from this song?')) return;
    if (hv.store === 'handcam') await deleteHandVideoBlob(song.id).catch(() => {});
    updateSong({ handVideo: undefined });
    setExport({ handsLayout: 'off' });
  };

  const setLayout = (l: HandsLayout) => {
    const patch: Partial<ExportSettings> = { handsLayout: l };
    if (phone && l !== 'off' && (settings.resolution > 720 || settings.fps > 30)) Object.assign(patch, { resolution: 720, fps: 30 });
    setExport(patch);
    if (l === 'bottom' && hv && !hv.calibration) onSetup(false);
  };

  const fileInput = (
    <input
      ref={input}
      type="file"
      accept="video/*,.mp4,.mov,.m4v,.webm,.mkv"
      className="hidden"
      aria-label="Hands video file"
      data-testid="hands-video-file"
      onChange={(e) => {
        void pick(e.target.files?.[0]);
        e.target.value = '';
      }}
    />
  );
  const longOut = song.duration > 4 * 60;
  const bigSource = !!hv && Math.max(hv.displayW, hv.displayH) > 2000;

  return (
    <div className="flex flex-col gap-3 border-b border-ink-700 p-4" data-testid="hands-section">
      <span className="text-[11px] font-semibold tracking-[0.08em] text-ink-300 uppercase">Hands video</span>
      {fileInput}
      {!webCodecs ? (
        <p className="text-[12px] text-ink-400">Hands videos need a browser that can encode video (Chrome, Edge, Firefox, or Safari 16.4 or later).</p>
      ) : !hv ? (
        <div className="flex flex-col gap-2">
          <p className="text-[12.5px] leading-relaxed text-ink-200">Add a video of your hands playing. The notes fall onto your real keys, like the big piano channels.</p>
          <Button size="sm" className="self-start" icon={adding ? <Loader2 size={14} className="animate-spin" /> : <Video size={14} />} disabled={!!adding} onClick={() => input.current?.click()}>
            {adding ?? 'Choose video'}
          </Button>
          <p className="text-[11.5px] text-ink-400">Tip: film from above with the keyboard straight across the frame, and use a tripod.</p>
        </div>
      ) : (
        <>
          <div className="flex items-start gap-3">
            <Thumb song={song} />
            <div className="flex min-w-0 flex-col gap-0.5 text-[12px]">
              <span className="truncate text-ink-100" title={hv.fileName}>
                {hv.fileName}
              </span>
              <span className="text-ink-300" data-testid="hands-sync-summary">
                {syncSummary(hv)}
              </span>
              <span className="text-ink-400">
                {hv.calibration ? `Keys: ${keyRangeLabel(hv.calibration.lo, hv.calibration.hi)}` : 'Keyboard not set up yet'} · {formatTime(hv.duration)}
              </span>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="primary" icon={<SlidersHorizontal size={14} />} onClick={() => onSetup(false)} data-testid="hands-setup-open">
              {hv.calibration ? 'Adjust' : 'Set up'}
            </Button>
            <Button size="sm" icon={adding ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} disabled={!!adding} onClick={() => input.current?.click()}>
              {adding ?? 'Change video'}
            </Button>
            <Button size="sm" variant="ghost" icon={<Trash2 size={14} />} onClick={() => void remove()}>
              Remove
            </Button>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[12.5px] text-ink-200">Layout</span>
            <Segmented<HandsLayout>
              size="sm"
              className="w-full"
              ariaLabel="Hands video layout"
              value={layout}
              onChange={setLayout}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'bottom', label: 'At the bottom' },
                { value: 'pip', label: 'Corner' },
              ]}
            />
            <p className="text-[11.5px] text-ink-400">
              {layout === 'bottom'
                ? 'Your video fills the bottom, and the notes land on your real keys.'
                : layout === 'pip'
                  ? 'A small video of your hands over the normal piano roll.'
                  : 'The video isn’t shown.'}
            </p>
          </div>
          {layout === 'bottom' && !hv.calibration && <p className="text-[12px] text-warn">Set up the keyboard first (Set up), so the notes land on your keys.</p>}
          {layout === 'pip' && (
            <>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Corner">
                {CORNERS.map((c) => (
                  <button
                    key={c.value}
                    role="radio"
                    aria-checked={settings.pipCorner === c.value}
                    onClick={() => setExport({ pipCorner: c.value })}
                    className={cn('focus-ring rounded-full border px-2.5 py-1 text-[12px]', settings.pipCorner === c.value ? 'border-accent-400 bg-accent-500/15 text-ink-50' : 'border-ink-600 text-ink-200 hover:border-ink-400')}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              <Slider label="Size" min={0.15} max={0.5} step={0.01} value={settings.pipSize} onChange={(pipSize) => setExport({ pipSize })} format={(x) => `${Math.round(x * 100)}% wide`} />
            </>
          )}
          {layout === 'bottom' && (
            <>
              <Toggle label="Light up the keys in the video" checked={settings.handsKeyLight !== false} onChange={(handsKeyLight) => setExport({ handsKeyLight })} />
              <Toggle label="Sparkles" checked={settings.handsSparkles !== false} onChange={(handsSparkles) => setExport({ handsSparkles })} />
            </>
          )}
          {layout !== 'off' && <p className="text-[11.5px] text-ink-400">Speed stays at 100% with a hands video.</p>}
          {layout !== 'off' && phone && (
            <p className="text-[12px] text-warn" data-testid="hands-phone-note">
              Phones: 720p is faster and safer. Long or 4K videos may be slow or stop. A computer works best.
              {longOut || bigSource ? ` ${longOut ? 'This song is over 4 minutes.' : 'Your video is 4K.'}` : ''}
            </p>
          )}
          {layout !== 'off' && !phone && bigSource && <p className="text-[11.5px] text-ink-400">Your video is 4K, so the export may take a while.</p>}
        </>
      )}
      {error && <p className="text-[12px] text-bad">{error}</p>}
    </div>
  );
}
