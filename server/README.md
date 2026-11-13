# Piano2Vision processing server (optional)

A small FastAPI service that adds two capabilities to the web app:

| Endpoint | Purpose |
| --- | --- |
| `GET /` | name, version, license (`AGPL-3.0-or-later`) and a link to the source code |
| `GET /api/health` | version, license, source link and enabled features (`features.separation`, `features.stems`, `features.youtube`) |
| `POST /api/jobs/youtube` `{url, separate}` | fetch a YouTube video's audio with yt-dlp; with `separate: true` also split it into stems |
| `POST /api/jobs/separate` (multipart `file`) | SCNet source separation: a **vocal stem** and the **accompaniment without drums or vocals** (bass + other) |
| `GET /api/jobs/{id}` | status, stage (`decoding` → `separating` → `encoding`), real per-segment progress, available `stems`, `separationMs` (the server's separation time). A YouTube job whose separation fails still finishes as `done` with only the `mix` stem and the reason in `separationError`, so the client can separate that audio itself without a second download. |
| `GET /api/jobs/{id}/audio?stem=vocals\|accomp\|mix` | a result file. Stems are mono 22.05 kHz FLAC, sample-aligned with the mixture; `mix` (YouTube) is AAC/M4A. Without `stem`: the accompaniment for separation jobs, the mix for plain YouTube jobs (what pre-2.0 clients expect). |

The web app still does the transcription: it puts the sung melody (vocal stem) on the right hand and
transcribes the drum-less accompaniment for the rest. The browser can run the same separation itself
(the "Separate vocals & drums" import option); a server is simply faster — about 0.4–0.6× real time on
2–4 CPU cores versus 2–3× real time single-threaded in the browser.

> **Rights & terms**: only process content you own or are licensed to use.
>
> **YouTube downloads are off by default and are a self-host option only.** YouTube's Terms of Service and developer policies do not allow downloading or storing its videos or audio without permission, so the web app no longer offers YouTube links and never calls this endpoint. `ENABLE_YOUTUBE=1` turns it on for your own private server; use it only for videos you own or have written permission to use, never on a public site. YouTube blocks most datacenter IPs, so it works mainly on a home connection.

## Separation model

[SCNet](https://github.com/starrytong/SCNet) (Tong et al., ICASSP 2024; MIT license, MUSDB18-HQ checkpoint)
as the int8 ONNX export by [audiojs](https://huggingface.co/audiojs/scnet) (12.9 MB), run with onnxruntime on
the CPU. The STFT/iSTFT (n_fft 4096, hop 1024) and the 11 s segmenting run in numpy (`app/separation.py`) and
mirror the browser worker, so server and browser produce the same stems (measured 51–55 dB agreement).
The weights' author confirmed redistribution of format-converted weights under MIT in
[starrytong/SCNet#35](https://github.com/starrytong/SCNet/issues/35).

The model is downloaded from a pinned Hugging Face revision and checked against its SHA-256
(`98228931494151762a1c4ab1ec7899a894b1f81fd4a509921a9d2f9bacc50845`, see `app/model.py`): at Docker build
time, or — outside Docker — on first use into `DATA_DIR/models/`. You can also point `SCNET_MODEL` at a copy
(the web app ships the identical file in `public/models/scnet/`).

Earlier versions used Demucs; its pretrained weights are for research use only
([facebookresearch/demucs#327](https://github.com/facebookresearch/demucs/issues/327)), so it was replaced.
PyTorch is no longer needed.

## Run locally

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -r requirements-separation.txt
```

```bash
ALLOW_ANONYMOUS=1 ALLOWED_ORIGINS=http://localhost:5173 .venv/bin/uvicorn app.main:app --port 8000
```

Requires `ffmpeg` on the PATH. Then set **Settings → Processing server** to `http://localhost:8000` in the app.
Leave out `requirements-separation.txt` for a YouTube-only server.

Tests (SCNet is mocked, no model download):

```bash
.venv/bin/pip install -r requirements-dev.txt && .venv/bin/python -m pytest tests
```

## Docker

```bash
docker build -t piano2vision-server .
```

```bash
docker run -p 8000:8000 -e SHARED_SECRET=change-me -e ALLOWED_ORIGINS=https://your-site.netlify.app piano2vision-server
```

`--build-arg WITH_SEPARATION=0` builds a YouTube-only image without onnxruntime and the model.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `SHARED_SECRET` | – | HMAC secret; must equal `PROCESSING_SHARED_SECRET` on Netlify |
| `ALLOW_ANONYMOUS` | `0` | accept requests without a token (local use only) |
| `ALLOWED_ORIGINS` | `http://localhost:5173` | CORS allow-list (comma-separated) |
| `ENABLE_YOUTUBE` | `0` | YouTube downloads (`POST /api/jobs/youtube`). Off by default: the web app no longer offers YouTube links |
| `ENABLE_SEPARATION` | `1` | separation jobs |
| `SCNET_MODEL` | `DATA_DIR/models/scnet.int8.onnx` (Docker: `/srv/models/scnet.int8.onnx`) | model file |
| `SCNET_AUTO_DOWNLOAD` | `1` | download (and verify) the model when the file is missing |
| `SCNET_THREADS` | `0` (all cores) | onnxruntime intra-op threads per job |
| `SCNET_STEP` | `0.9` | segment hop as a fraction of 11 s (0.9 = 10 % overlap, identical to the browser; smaller values add overlap and work: 0.5 ≈ 1.8× the segments) |
| `MAX_UPLOAD_MB` | `200` | upload limit |
| `MAX_DURATION_SEC` | `1200` | longest accepted audio |
| `JOBS_PER_HOUR_PER_IP` | `20` | simple rate limit |
| `JOB_TTL_SEC` | `3600` | results are deleted after this |
| `WORKERS` | `1` | concurrent jobs (each separation needs ≈ 1.7 GB RAM plus 50–100 MB per minute of audio) |
| `DATA_DIR` | `./data` | working directory for job files |
| `SOURCE_CODE_URL` | `https://github.com/ItsCats/audio-2-piano-roll` | source link returned by `GET /` and `/api/health`. If you run a modified server, set it to where your modified source is published (AGPL-3.0 section 13) |

See [../docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md) for hosting options and costs.

## Licenses

Server code: same license as the app, GNU AGPL-3.0-or-later (see [../LICENSE](../LICENSE)); source: <https://github.com/ItsCats/audio-2-piano-roll>.
Because of the AGPL, a server that other people use must offer them its source; `GET /` and `/api/health` return the
link (`SOURCE_CODE_URL`). Third-party components: [../THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). SCNet weights and code: MIT, © 2024 starrytong (ONNX export: audiojs).
onnxruntime: MIT (Microsoft). FastAPI, Starlette, uvicorn: MIT/BSD. numpy: BSD. yt-dlp: Unlicense. ffmpeg: LGPL/GPL (system package).
