/**
 * Client for the optional self-hosted processing server (server/). It fetches audio for
 * YouTube URLs (yt-dlp) and isolates the piano/harmonic part of full mixes (Demucs).
 * Transcription itself always runs in the browser.
 */
export interface BackendHealth {
  ok: boolean;
  version: string;
  features: { youtube: boolean; separation: boolean };
  maxDurationSec: number;
}

export interface BackendJob {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  stage: string;
  progress: number | null;
  error?: string;
  title?: string;
  artist?: string;
  duration?: number;
}

function base(url: string): string {
  return url.replace(/\/+$/, '');
}

let cachedToken: { token: string; exp: number } | null = null;

/** Short-lived token minted by the Netlify function (keeps the shared secret server-side). */
async function token(): Promise<string | null> {
  if (cachedToken && cachedToken.exp - 30 > Date.now() / 1000) return cachedToken.token;
  try {
    const res = await fetch('/.netlify/functions/backend-token', { method: 'POST' });
    if (!res.ok) return null;
    const j = await res.json();
    if (typeof j.token !== 'string') return null;
    cachedToken = { token: j.token, exp: j.exp };
    return j.token;
  } catch {
    return null;
  }
}

async function headers(): Promise<HeadersInit> {
  const t = await token();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `Server error ${res.status}`;
    try {
      const j = await res.json();
      msg = j.detail || j.error || msg;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json();
}

export async function health(url: string): Promise<BackendHealth> {
  const res = await fetch(`${base(url)}/api/health`, { headers: await headers(), signal: AbortSignal.timeout(6000) });
  return handle(res);
}

export async function createYouTubeJob(url: string, videoUrl: string, separate: boolean): Promise<BackendJob> {
  const res = await fetch(`${base(url)}/api/jobs/youtube`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await headers()) },
    body: JSON.stringify({ url: videoUrl, separate }),
  });
  return handle(res);
}

export async function createSeparationJob(url: string, file: Blob, name: string): Promise<BackendJob> {
  const fd = new FormData();
  fd.append('file', file, name);
  const res = await fetch(`${base(url)}/api/jobs/separate`, { method: 'POST', headers: await headers(), body: fd });
  return handle(res);
}

export async function getJob(url: string, id: string): Promise<BackendJob> {
  return handle(await fetch(`${base(url)}/api/jobs/${id}`, { headers: await headers() }));
}

export async function getJobAudio(url: string, id: string): Promise<Blob> {
  const res = await fetch(`${base(url)}/api/jobs/${id}/audio`, { headers: await headers() });
  if (!res.ok) throw new Error(`Could not download processed audio (${res.status})`);
  return res.blob();
}

export async function waitForJob(
  url: string,
  id: string,
  onUpdate: (j: BackendJob) => void,
  signal?: AbortSignal,
): Promise<BackendJob> {
  for (;;) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const j = await getJob(url, id);
    onUpdate(j);
    if (j.status === 'done') return j;
    if (j.status === 'error') throw new Error(j.error || 'Processing failed on the server');
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export function configuredBackendUrl(userUrl: string): string {
  return userUrl.trim() || (import.meta.env.VITE_PROCESSING_URL as string | undefined) || '';
}
