# Deployment, hosting & costs

## Frontend on Netlify (required)

The web app is a static build plus one tiny function, so it fits Netlify's free plan for personal use.

1. Create a **private** GitHub repository and push this project.
2. Netlify → *Add new site* → *Import an existing project* → GitHub → select the repo. Settings are read from `netlify.toml` (build `npm run build`, publish `dist`, Node 22, functions in `netlify/functions`).
3. Deploy. Every push to the production branch redeploys; pull requests get deploy previews.

What the CDN serves: the app (~0.8 MB gzipped for the first page; the transcription worker ≈ 0.45 MB gzipped + WASM loads on first import), piano samples (9.4 MB, loaded on first playback, cached 30 days) and the AI model (0.9 MB).

**Bandwidth**: a first-time visitor who imports and plays one song downloads roughly 12 MB; returning visitors mostly hit their browser cache.

### Cross-origin isolation (other static hosts)

In-browser separation runs multi-threaded only when the page is cross-origin isolated (SharedArrayBuffer).
`netlify.toml` sends, on every app route:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

* **Not** on `/import/youtube`: the YouTube player iframe sends no COEP header, so an isolated page cannot
  embed it. The app reloads the page when entering or leaving that route (`src/lib/isolation.ts`).
* Each route must receive exactly one copy of each header (overlapping rules can send two, which browsers
  treat as invalid). `tests/e2e/isolation.mjs app` checks every route against `netlify.toml`.
* The route list lives in `src/lib/isolation.ts` (`ISOLATED_ROUTES`) and in `netlify.toml`; keep them in sync.

On another static host, set the same headers per route. Without them everything still works, but separation
falls back to one thread (about 2–3× slower).

## Optional processing server

Needed only for YouTube fetching and for faster source separation. Transcription never needs it, and the
"Separate vocals & drums" import option also runs in the browser (SCNet, about 2–3× real time single-threaded);
a server runs the same SCNet model on several cores (about 0.4–0.6× real time) and returns the same two stems:
the vocals and the accompaniment without drums.

### Security model

* The browser calls `/.netlify/functions/backend-token`, which returns a 10-minute HMAC token signed with `PROCESSING_SHARED_SECRET` (requests from other origins are refused).
* The server verifies the token with the same secret (`SHARED_SECRET`), restricts CORS to `ALLOWED_ORIGINS`, rate-limits jobs per IP, limits upload size and duration, validates media with ffprobe, only accepts YouTube hosts (no SSRF), and deletes job files after `JOB_TTL_SEC`.
* This keeps random sites and bots off your server; it does not make a public deployment safe from a determined user of your own site — keep the rate limit sensible.

### Where to run it

| Option | Good for | Approximate cost* |
| --- | --- | --- |
| **Your own computer** (`docker run …` or `uvicorn`) | Personal use. **The only option that reliably works for YouTube**, because YouTube blocks most cloud/datacenter IPs (verified: HTTP 403 from a cloud VM). | Free |
| **Google Cloud Run** (CPU, scale to zero, 2–4 vCPU/4 GB, concurrency 1) | Occasional separation jobs | Pay per use; a 4-minute song ≈ 3–5 vCPU-minutes ≈ a few US cents. Free tier covers light use. |
| **Fly.io / Railway / Render** (2–4 shared vCPU, 3–4 GB RAM) | Always-on small server | ~US$10–30 per month always-on; less with auto-stop |

\* Indicative 2025–26 list prices; check the provider's current pricing.

Measured on a shared 4-core cloud VM (CPU only), SCNet int8 via onnxruntime, 20 s excerpt end to end (upload, decode,
separation, FLAC encoding): 12.1 s with 2 threads, 8.4 s with 4 threads; peak RAM ≈ 1.7 GB per job for a short song, plus roughly 50–100 MB per minute of audio (give the server 3 GB for typical songs, 4 GB for the 20-minute limit). Separation scales
linearly with song length (one 11 s segment every 9.9 s), so a 4-minute song (≈ 26 segments of 2.5–3.7 s each here) takes roughly 1–1.6 minutes on 2–4 cores.
The image no longer contains PyTorch (≈ 70 MB for onnxruntime plus the 12.9 MB model instead of ≈ 0.8 GB for torch and Demucs).

The server used Demucs before version 2.0; Demucs' pretrained weights are research-only
([facebookresearch/demucs#327](https://github.com/facebookresearch/demucs/issues/327)), SCNet's are MIT
([starrytong/SCNet#35](https://github.com/starrytong/SCNet/issues/35)).

### Deploying with Docker

```bash
cd server
```

```bash
docker build -t piano2vision-server .
```

```bash
docker run -p 8000:8000 -e SHARED_SECRET=$(openssl rand -hex 32) -e ALLOWED_ORIGINS=https://your-site.netlify.app piano2vision-server
```

The build downloads the SCNet model from a pinned Hugging Face revision and verifies its SHA-256. Build with
`--build-arg WITH_SEPARATION=0` for a YouTube-only image without onnxruntime and the model.

Then in Netlify set `PROCESSING_SHARED_SECRET` (same value) and optionally `VITE_PROCESSING_URL=https://your-server.example`, and redeploy. Users can also enter a server URL under **Settings → Processing server**.

### Local development with the server

```bash
cd server && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-separation.txt
```

```bash
cd server && ALLOW_ANONYMOUS=1 ALLOWED_ORIGINS=http://localhost:5173 .venv/bin/uvicorn app.main:app --port 8000
```

`ALLOW_ANONYMOUS=1` is for local use only (there is no Netlify function in `vite dev`).

## Storage

User data lives in the browser (IndexedDB): songs, arrangements, original audio and backgrounds. The app requests persistent storage so the browser doesn't evict it under pressure. Users back up or move songs with *Export → Project file* and *Library → Import project*. Clearing site data deletes the library.
