"""
Piano2Vision processing server.

Optional companion to the web app: fetches YouTube audio (yt-dlp) and separates full mixes
into a vocal stem and a drum-less accompaniment (SCNet, int8 ONNX on onnxruntime CPU) — the same
model the browser runs, just faster on a multi-core server. Note transcription itself runs in the
browser, so this server never needs a GPU to be useful.
"""
from __future__ import annotations

import os
import time
from collections import defaultdict, deque

from fastapi import Depends, FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import separation, youtube
from .audio import AudioError, decode, encode_flac, has_audio_stream, probe_duration, transcode_m4a
from .auth import require_auth
from .config import settings
from .jobs import Job, manager

VERSION = "2.0.0"
STEMS = ("vocals", "accomp", "mix")

app = FastAPI(title="Piano2Vision processing server", version=VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.allowed_origins,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
    max_age=3600,
)

_hits: dict[str, deque] = defaultdict(deque)


def rate_limit(request: Request) -> None:
    ip = request.headers.get("x-forwarded-for", request.client.host if request.client else "?").split(",")[0].strip()
    q = _hits[ip]
    now = time.time()
    while q and q[0] < now - 3600:
        q.popleft()
    if len(q) >= settings.jobs_per_hour_per_ip:
        raise HTTPException(status_code=429, detail="Too many jobs from this address — try again later.")
    q.append(now)


def separation_enabled() -> bool:
    return settings.enable_separation and separation.available()


def _separate_into(job: Job, source_path: str, out_dir: str) -> None:
    """SCNet -> vocals.flac + accomp.flac (mono 22.05 kHz, sample-aligned with the source)."""
    t0 = time.perf_counter()
    job.stage = "decoding"
    job.progress = None
    audio = decode(source_path, sr=separation.SR, channels=2)
    job.stage = "separating"
    job.progress = 0.0

    def on_progress(done: int, total: int) -> None:
        job.progress = done / total
        job.detail = f"segment {done}/{total}"

    stems = separation.separate(audio, on_progress)
    del audio
    job.stage = "encoding"
    job.progress = None
    # one common gain for both stems (keeps their ratio, so vocal-presence measurements stay valid)
    peak = max(float(abs(v).max()) if v.size else 0.0 for v in stems.values())
    gain = 0.98 / peak if peak > 0.98 else 1.0
    for name, data in stems.items():
        path = os.path.join(out_dir, f"{name}.flac")
        encode_flac(data * gain if gain != 1.0 else data, separation.SR, path)
        job.stems[name] = path
    job.detail = "vocals + accompaniment (SCNet)"
    job.result_path = job.stems["accomp"]
    job.separation_ms = round((time.perf_counter() - t0) * 1000)


@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "version": VERSION,
        # stems: separation returns ?stem=vocals|accomp (SCNet); older servers returned one "piano part" file
        "features": {"youtube": youtube.available(), "separation": separation_enabled(), "stems": True},
        "separationModel": "scnet-int8" if separation_enabled() else None,
        "maxDurationSec": settings.max_duration_sec,
    }


class YouTubeRequest(BaseModel):
    url: str
    separate: bool = False


@app.post("/api/jobs/youtube", dependencies=[Depends(require_auth), Depends(rate_limit)])
def create_youtube_job(req: YouTubeRequest) -> dict:
    if not youtube.available():
        raise HTTPException(status_code=501, detail="YouTube fetching is disabled on this server.")
    try:
        url = youtube.validate_url(req.url)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    separate = req.separate and separation_enabled()

    def work(job: Job) -> None:
        d = manager.job_dir(job.id)
        job.stage = "downloading"

        def on_progress(p: float) -> None:
            job.progress = p

        info = youtube.download_audio(url, d, on_progress)
        job.title, job.artist, job.duration = info["title"], info["artist"], info["duration"]
        mix = os.path.join(d, "mix.m4a")
        job.stage = "encoding"
        job.progress = None
        transcode_m4a(info["path"], mix)
        job.stems["mix"] = mix
        job.result_path = mix
        if separate:
            try:
                _separate_into(job, info["path"], d)  # default download becomes the accompaniment
            except Exception as e:  # noqa: BLE001 - the download is still useful: the client separates it itself
                # keep the job done with the mix only, so the client can fetch it instead of making
                # the server download the video a second time
                for name in ("vocals", "accomp"):
                    path = job.stems.pop(name, None)
                    if path and os.path.exists(path):
                        os.remove(path)
                job.result_path = mix
                job.separation_ms = None
                job.separation_error = str(e) or type(e).__name__
                job.detail = "separation failed; the audio is available without it"

    return manager.create("youtube", work).public()


@app.post("/api/jobs/separate", dependencies=[Depends(require_auth), Depends(rate_limit)])
async def create_separation_job(file: UploadFile = File(...)) -> dict:
    if not separation_enabled():
        raise HTTPException(status_code=501, detail="Source separation is not installed on this server.")
    tmp_dir = os.path.join(settings.data_dir, "uploads")
    os.makedirs(tmp_dir, exist_ok=True)
    tmp_path = os.path.join(tmp_dir, f"{time.time_ns()}")
    limit = settings.max_upload_mb * 1024 * 1024
    size = 0
    with open(tmp_path, "wb") as fh:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > limit:
                fh.close()
                os.remove(tmp_path)
                raise HTTPException(status_code=413, detail=f"File too large (max {settings.max_upload_mb} MB).")
            fh.write(chunk)
    try:
        if not has_audio_stream(tmp_path):
            raise AudioError("The upload contains no audio stream.")
        duration = probe_duration(tmp_path)
        if duration > settings.max_duration_sec:
            raise AudioError(f"Audio is {round(duration / 60)} min long; the limit is {settings.max_duration_sec // 60} min.")
    except AudioError as e:
        os.remove(tmp_path)
        raise HTTPException(status_code=400, detail=str(e)) from e

    def work(job: Job) -> None:
        d = manager.job_dir(job.id)
        src = os.path.join(d, "source")
        os.replace(tmp_path, src)
        job.duration = duration
        _separate_into(job, src, d)
        os.remove(src)

    return manager.create("separate", work).public()


@app.get("/api/jobs/{job_id}", dependencies=[Depends(require_auth)])
def get_job(job_id: str) -> dict:
    job = manager.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found (it may have expired).")
    return job.public()


@app.get("/api/jobs/{job_id}/audio", dependencies=[Depends(require_auth)])
def get_job_audio(job_id: str, stem: str | None = Query(default=None, max_length=16)) -> FileResponse:
    """Processed audio. ?stem=vocals|accomp (separation) or mix (YouTube); without it: the accompaniment for
    separation jobs (what pre-2.0 clients expect) or the mix for plain YouTube jobs."""
    if stem is not None and stem not in STEMS:
        raise HTTPException(status_code=400, detail=f"Unknown stem; use one of {', '.join(STEMS)}.")
    job = manager.get(job_id)
    if not job or job.status != "done":
        raise HTTPException(status_code=404, detail="No processed audio for this job.")
    path = job.stems.get(stem) if stem else job.result_path
    if not path or not os.path.exists(path):
        raise HTTPException(status_code=404, detail="No processed audio for this job." if not stem else f"This job has no {stem} stem.")
    flac = path.endswith(".flac")
    name = f"{stem or ('accomp' if flac else 'audio')}.{'flac' if flac else 'm4a'}"
    return FileResponse(path, media_type="audio/flac" if flac else "audio/mp4", filename=name)
