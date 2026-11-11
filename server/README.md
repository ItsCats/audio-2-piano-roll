# Piano2Vision processing server (optional)

A small FastAPI service that adds two capabilities the browser can't provide:

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | version and enabled features |
| `POST /api/jobs/youtube` `{url, separate}` | fetch a YouTube video's audio with yt-dlp (optionally separate it) |
| `POST /api/jobs/separate` (multipart `file`) | Demucs `htdemucs_6s`: returns the **piano stem** if the song has a piano (≥12 % of the energy), otherwise **everything except drums** |
| `GET /api/jobs/{id}` | status, stage, progress |
| `GET /api/jobs/{id}/audio` | processed audio (AAC/M4A) |

The web app still does the transcription; the server only prepares audio.

> **Rights & terms**: only process content you own or are licensed to use. Fetching YouTube media may be restricted by YouTube's Terms of Service — enabling it is your decision (`ENABLE_YOUTUBE=0` disables it). YouTube blocks most datacenter IPs, so YouTube fetching is reliable mainly when this server runs on a home connection.

## Run locally

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

Optional separation (CPU build of PyTorch first):

```bash
.venv/bin/pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu && .venv/bin/pip install -r requirements-separation.txt
```

```bash
ALLOW_ANONYMOUS=1 ALLOWED_ORIGINS=http://localhost:5173 .venv/bin/uvicorn app.main:app --port 8000
```

Requires `ffmpeg` on the PATH. Then set **Settings → Processing server** to `http://localhost:8000` in the app.

## Docker

```bash
docker build -t piano2vision-server .
```

```bash
docker run -p 8000:8000 -e SHARED_SECRET=change-me -e ALLOWED_ORIGINS=https://your-site.netlify.app piano2vision-server
```

`--build-arg WITH_SEPARATION=0` builds a small image without PyTorch/Demucs.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SHARED_SECRET` | – | HMAC secret; must equal `PROCESSING_SHARED_SECRET` on Netlify |
| `ALLOW_ANONYMOUS` | `0` | accept requests without a token (local use only) |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | CORS allow-list (comma-separated) |
| `ENABLE_YOUTUBE` / `ENABLE_SEPARATION` | `1` | feature switches |
| `DEMUCS_MODEL` | `htdemucs_6s` | Demucs model name |
| `MAX_UPLOAD_MB` | `200` | upload limit |
| `MAX_DURATION_SEC` | `1200` | longest accepted audio |
| `JOBS_PER_HOUR_PER_IP` | `20` | simple rate limit |
| `JOB_TTL_SEC` | `3600` | results are deleted after this |
| `WORKERS` | `1` | concurrent jobs (Demucs is CPU/RAM heavy) |
| `DATA_DIR` | `./data` | working directory for job files |

See [../docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md) for hosting options and costs.
