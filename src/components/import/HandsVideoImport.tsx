import { useRef } from 'react';
import { Video } from 'lucide-react';
import { Button } from '../ui';
import { useSettings } from '../../state/settingsStore';
import { storageEstimate, requestPersistence } from '../../lib/storage/db';
import { isMemoryConstrained, pageDeviceInfo } from '../../lib/transcription/backendChoice';
import { BIG_VIDEO_BYTES, MAX_VIDEO_BYTES_DESKTOP, MAX_VIDEO_BYTES_PHONE } from '../../lib/handcam/media';
import { isVideoFile } from '../../lib/transcription/decode';
import { toast } from '../../state/toastStore';

const gb = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);

/** What to do with a chosen video before importing it: 'keep' (with the video), 'notes' (notes only) or null (stop). */
export async function checkVideoForKeeping(file: File, opts: { phone: boolean; free: number | null; confirm: (msg: string) => boolean }): Promise<'keep' | 'notes' | null> {
  if (!isVideoFile(file)) {
    toast.warn('That’s not a video', 'Choose a video file (MP4, MOV or WebM). For a sound file, use the box above.');
    return null;
  }
  const max = opts.phone ? MAX_VIDEO_BYTES_PHONE : MAX_VIDEO_BYTES_DESKTOP;
  if (file.size > max) {
    toast.error('This video is too large', `It is ${gb(file.size)}. The limit${opts.phone ? ' on phones' : ''} is ${gb(max)}. Trim it or record at 1080p, 30 FPS.`);
    return null;
  }
  if (opts.free !== null && file.size > opts.free * 0.9) {
    return opts.confirm(`There isn’t enough room in this browser to keep this ${gb(file.size)} video. Import the notes only?`) ? 'notes' : null;
  }
  if (file.size > BIG_VIDEO_BYTES && !opts.confirm(`This video is ${gb(file.size)}. It’s saved in this browser, so make sure your device has room. Tip: record at 1080p, 30 FPS. Continue?`)) return null;
  return 'keep';
}

/**
 * "Import a video of you playing": the notes come from the video's sound and the video is kept with the
 * song (as its original recording), already in sync, for a hands video export.
 */
export function HandsVideoImport({ busy, pianoModelOn, onVideo }: { busy: boolean; pianoModelOn: boolean; onVideo: (f: File, keep: boolean) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const setSettings = useSettings((s) => s.set);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    const device = pageDeviceInfo();
    const est = await storageEstimate().catch(() => null);
    const what = await checkVideoForKeeping(file, { phone: !!device && isMemoryConstrained(device), free: est && est.quota ? est.quota - est.usage : null, confirm: (m) => window.confirm(m) });
    if (!what) return;
    if (what === 'keep') void requestPersistence();
    // a video of one person playing: the solo piano settings
    setSettings({ detectionPreset: 'piano' });
    onVideo(file, what === 'keep');
  };
  return (
    <div className="flex flex-col gap-2.5 rounded-xl border border-ink-700 bg-ink-900/60 p-4" data-testid="hands-video-import">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-ink-800 text-accent-400">
          <Video size={18} />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[13.5px] font-medium text-ink-50">Filmed yourself playing?</span>
          <span className="text-[12.5px] leading-relaxed text-ink-300">
            Import the video: the notes come from your playing, and the video is kept with the song so you can export it with the falling notes on top, like
            the big piano channels.
          </span>
          {!pianoModelOn && <span className="text-[12px] text-ink-400">Tip: for solo piano, turn on “High-accuracy piano model” below.</span>}
        </div>
      </div>
      <input ref={input} type="file" accept="video/*,.mp4,.mov,.m4v,.webm,.mkv" className="hidden" aria-label="Video of you playing" data-testid="hands-video-input" onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ''; }} />
      <Button className="self-start" icon={<Video size={15} />} disabled={busy} onClick={() => input.current?.click()}>
        Import a video of you playing
      </Button>
    </div>
  );
}
