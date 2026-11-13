/**
 * Record the sound of another browser tab (or, where the browser offers it, the whole computer)
 * with getDisplayMedia, the same mechanism as screen sharing. The user picks what to share in the
 * browser's own dialog and must turn on its "Share tab audio" / "Share system audio" switch; only
 * the sound is kept (the shared picture is never recorded).
 *
 * Desktop Chrome and Edge can share a tab's sound. Safari and Firefox share the screen without
 * sound, and phone browsers (every iPhone / iPad browser, Chrome on Android) cannot share at all, so
 * there the Import page explains the other ways (a screen recording uploaded as a video, or the
 * microphone).
 */

export type TabAudioSupport = 'ok' | 'iphone' | 'phone' | 'browser';

interface UAData {
  brands?: { brand: string }[];
  mobile?: boolean;
}

/** Whether this browser can record another tab's sound, and if not, which advice to give. */
export function tabAudioSupport(nav: Navigator | undefined = typeof navigator === 'undefined' ? undefined : navigator): TabAudioSupport {
  if (!nav) return 'browser';
  const ua = nav.userAgent ?? '';
  // iPadOS Safari says "Macintosh"; touch points give it away
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1)) return 'iphone';
  const data = (nav as Navigator & { userAgentData?: UAData }).userAgentData;
  if (data?.mobile || /Android|Mobi/.test(ua)) return 'phone';
  const chromium = !!data?.brands?.some((b) => /Chromium|Google Chrome|Microsoft Edge/.test(b.brand));
  if (!chromium || !nav.mediaDevices?.getDisplayMedia || typeof MediaRecorder === 'undefined') return 'browser';
  return 'ok';
}

export interface TabAudioCapture {
  /** stop and return the recording (also after the user pressed the browser's "Stop sharing") */
  stop: () => Promise<Blob>;
  /** stop and throw the recording away */
  cancel: () => void;
  /** called once when sharing ends from outside the page (the browser's "Stop sharing" button) */
  onEnded: (fn: () => void) => void;
}

/** Shown on the Computer sound tab (and its how-to on phones and other browsers). */
export const TERMS_NOTE =
  'Check the terms of the website or app you’re playing from (for example a social media app) before recording its audio, and only record music you have the rights to use.';

export const NO_SOUND_SHARED = 'No sound was shared. Pick the tab that plays the music and turn on “Share tab audio”, then try again.';

/** Ask the user what to share (with sound) and start recording its sound. */
export async function startTabAudioCapture(): Promise<TabAudioCapture> {
  const opts = {
    video: true, // required by the API; the picture is dropped right away
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
    // offer other tabs first; recording this page itself would only record silence
    preferCurrentTab: false,
    selfBrowserSurface: 'exclude',
    systemAudio: 'include',
    surfaceSwitching: 'include',
  } as DisplayMediaStreamOptions;
  const stream = await navigator.mediaDevices.getDisplayMedia(opts);
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error(NO_SOUND_SHARED);
  }
  // only the sound is recorded; the picture track stays open (stopping it can end the whole share)
  const audioStream = new MediaStream(audioTracks);
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
  const rec = new MediaRecorder(audioStream, mime ? { mimeType: mime, audioBitsPerSecond: 192000 } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  rec.start(1000);
  const cleanup = () => stream.getTracks().forEach((t) => t.stop());
  let ended: (() => void) | null = null;
  let endedFired = false;
  for (const t of stream.getTracks()) {
    t.addEventListener('ended', () => {
      if (endedFired) return;
      endedFired = true;
      ended?.();
    });
  }
  return {
    onEnded: (fn) => {
      ended = fn;
    },
    stop: () =>
      new Promise<Blob>((resolve) => {
        const done = () => {
          cleanup();
          resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
        };
        if (rec.state !== 'inactive') {
          rec.onstop = done;
          rec.stop();
        } else done();
      }),
    cancel: () => {
      endedFired = true;
      rec.onstop = null;
      try {
        if (rec.state !== 'inactive') rec.stop();
      } catch {
        /* already stopped */
      }
      chunks.length = 0;
      cleanup();
    },
  };
}
