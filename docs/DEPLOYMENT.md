# Deployment, hosting & costs

## Frontend on Netlify (required)

The web app is a static build plus one tiny function, so it fits Netlify's free plan for personal use.

1. Create a **private** GitHub repository and push this project.
2. Netlify → *Add new site* → *Import an existing project* → GitHub → select the repo. Settings are read from `netlify.toml` (build `npm run build`, publish `dist`, Node 22, functions in `netlify/functions`).
3. Deploy. Every push to the production branch redeploys; pull requests get deploy previews.

What the CDN serves: the app (~0.8 MB gzipped for the first page; the transcription worker ≈ 0.45 MB gzipped + WASM loads on first import), piano samples (9.4 MB, loaded on first playback, cached 30 days) and the AI model (0.9 MB).

**Bandwidth**: a first-time visitor who imports and plays one song downloads roughly 12 MB; returning visitors mostly hit their browser cache.

## Optional processing server

Needed only for YouTube fetching and Demucs source separation. Transcription never needs it.

### Security model

* The browser calls `/.netlify/functions/backend-token`, which returns a 10-minute HMAC token signed with `PROCESSING_SHARED_SECRET` (requests from other origins are refused).
* The server verifies the token with the same secret (`SHARED_SECRET`), restricts CORS to `ALLOWED_ORIGINS`, rate-limits jobs per IP, limits upload size and duration, validates media with ffprobe, only accepts YouTube hosts (no SSRF), and deletes job files after `JOB_TTL_SEC`.
* This keeps random sites and bots off your server; it does not make a public deployment safe from a determined user of your own site — keep the rate limit sensible.

### Where to run it

| Option | Good for | Approximate cost* |
| --- | --- | --- |
| **Your own computer** (`docker run …` or `uvicorn`) | Personal use. **The only option that reliably works for YouTube**, because YouTube blocks most cloud/datacenter IPs (verified: HTTP 403 from a cloud VM). | Free |
| **Google Cloud Run** (CPU, scale to zero, 4 vCPU/8 GB, concurrency 1) | Occasional separation jobs | Pay per use; a 4-minute song ≈ 2–4 CPU-minutes ≈ a few US cents. Free tier covers light use. |
| **Fly.io / Railway / Render** (2–4 shared vCPU, 4–8 GB RAM) | Always-on small server | ~US$15–40 per month always-on; less with auto-stop |
| **GPU (Modal, RunPod, Replicate-style)** | Many users, fast separation | ~US$0.5–1.5 per GPU-hour; Demucs takes ~10–20 s per song on a GPU |

\* Indicative 2025–26 list prices; check the provider's current pricing.

Measured on a 4-core cloud VM (CPU only): Demucs `htdemucs_6s` separated a 60 s recording in 25 s including first-time model download. Expect roughly 0.3–0.6× real time on 4 modern cores.

### Deploying with Docker

```bash
cd server
```

```bash
docker build -t pianovision-server .
```

```bash
docker run -p 8000:8000 -e SHARED_SECRET=$(openssl rand -hex 32) -e ALLOWED_ORIGINS=https://your-site.netlify.app pianovision-server
```

Build with `--build-arg WITH_SEPARATION=0` for a ~150 MB image without PyTorch/Demucs (YouTube only).

Then in Netlify set `PROCESSING_SHARED_SECRET` (same value) and optionally `VITE_PROCESSING_URL=https://your-server.example`, and redeploy. Users can also enter a server URL under **Settings → Processing server**.

### Local development with the server

```bash
cd server && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

```bash
cd server && ALLOW_ANONYMOUS=1 ALLOWED_ORIGINS=http://localhost:5173 .venv/bin/uvicorn app.main:app --port 8000
```

`ALLOW_ANONYMOUS=1` is for local use only (there is no Netlify function in `vite dev`).

## Storage

User data lives in the browser (IndexedDB): songs, arrangements, original audio and backgrounds. The app requests persistent storage so the browser doesn't evict it under pressure. Users back up or move songs with *Export → Project file* and *Library → Import project*. Clearing site data deletes the library.
