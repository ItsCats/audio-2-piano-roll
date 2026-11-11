/**
 * YouTube support without violating YouTube's terms in the browser:
 *  - metadata via the public oEmbed endpoint,
 *  - playback via the official IFrame Player API,
 *  - audio for transcription either from the user's optional self-hosted processing server
 *    (their responsibility to use for content they have rights to), or by recording the
 *    audio of this browser tab while the official player plays it (getDisplayMedia, the
 *    same mechanism as screen recording; requires the user to pick the tab and share audio).
 */
export function parseYouTubeId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s.startsWith('http') ? s : `https://${s}`);
    const host = u.hostname.replace(/^www\.|^m\.|^music\./, '');
    if (host === 'youtu.be') return /^[\w-]{11}/.exec(u.pathname.slice(1))?.[0] ?? null;
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      const v = u.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const m = /^\/(?:embed|shorts|live|v)\/([\w-]{11})/.exec(u.pathname);
      if (m) return m[1];
    }
  } catch {
    return null;
  }
  return null;
}

export interface VideoMeta {
  title: string;
  author: string;
  thumbnail: string;
}

export async function fetchVideoMeta(id: string): Promise<VideoMeta | null> {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}&format=json`);
    if (!res.ok) return null;
    const j = await res.json();
    return { title: j.title, author: j.author_name, thumbnail: j.thumbnail_url };
  } catch {
    return null;
  }
}

/* ---------- IFrame player API ---------- */

interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(s: number, allow: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  setVolume(v: number): void;
  unMute(): void;
  destroy(): void;
}
interface YTNamespace {
  Player: new (el: HTMLElement, opts: unknown) => YTPlayer;
  PlayerState: { ENDED: number; PLAYING: number; PAUSED: number };
}
declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<YTNamespace> | null = null;
export function loadYouTubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (!apiPromise) {
    apiPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prev?.();
        resolve(window.YT!);
      };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => {
        apiPromise = null;
        reject(new Error('Could not load the YouTube player (blocked by the network or an extension?)'));
      };
      document.head.appendChild(s);
    });
  }
  return apiPromise;
}

export async function createPlayer(el: HTMLElement, videoId: string, onState?: (state: number) => void): Promise<YTPlayer> {
  const YT = await loadYouTubeApi();
  return new Promise((resolve, reject) => {
    const player = new YT.Player(el, {
      videoId,
      width: '100%',
      height: '100%',
      playerVars: { rel: 0, modestbranding: 1, playsinline: 1 },
      events: {
        onReady: () => resolve(player),
        onStateChange: (e: { data: number }) => onState?.(e.data),
        onError: (e: { data: number }) => {
          const msg =
            e.data === 101 || e.data === 150
              ? 'The owner of this video does not allow it to be played in other websites.'
              : e.data === 100
                ? 'Video not found or private.'
                : `YouTube player error ${e.data}.`;
          reject(new Error(msg));
        },
      },
    });
  });
}

export type { YTPlayer };

/* ---------- tab audio capture ---------- */

export function tabCaptureSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia && typeof MediaRecorder !== 'undefined';
}

export interface TabCapture {
  stop: () => Promise<Blob>;
  cancel: () => void;
  stream: MediaStream;
}

/** Ask the user to share this tab (with audio) and start recording its audio. */
export async function startTabCapture(): Promise<TabCapture> {
  const opts = {
    video: true,
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
    systemAudio: 'include',
  } as DisplayMediaStreamOptions;
  const stream = await navigator.mediaDevices.getDisplayMedia(opts);
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('No audio was shared. Choose "This tab" and turn on "Share tab audio", then try again.');
  }
  const audioStream = new MediaStream(audioTracks);
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
  const rec = new MediaRecorder(audioStream, mime ? { mimeType: mime, audioBitsPerSecond: 192000 } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start(1000);
  const cleanup = () => stream.getTracks().forEach((t) => t.stop());
  return {
    stream,
    stop: () =>
      new Promise<Blob>((resolve) => {
        rec.onstop = () => {
          cleanup();
          resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
        };
        if (rec.state !== 'inactive') rec.stop();
        else {
          cleanup();
          resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
        }
      }),
    cancel: () => {
      try {
        rec.stop();
      } catch {
        /* noop */
      }
      cleanup();
    },
  };
}
