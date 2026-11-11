"""
PianoVision processing server.

Optional companion to the web app: fetches YouTube audio (yt-dlp) and isolates the
piano / harmonic content of full mixes (Demucs). Note transcription itself runs in the
browser, so this server never needs a GPU to be useful.
"""
from __future__ import annotations

import os
import time
from collections import defaultdict, deque

from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from . import separation, youtube
from .audio import AudioError, decode, encode_m4a, has_audio_stream, probe_duration, transcode_m4a
from .auth import require_auth
from .config import settings
from .jobs import Job, manager

VERSION = "1.0.0"

app = FastAPI(title="PianoVision processing server", version=VERSION)
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


def _separate_into(job: Job, source_path: str, out_path: str) -> None:
    job.stage = "separating"
    job.progress = None  # demucs does not expose granular progress
    sr = 44100
    audio = decode(source_path, sr=sr, channels=2)
    out, desc = separation.separate(audio, sr, settings.demucs_model)
    job.detail = desc
    job.stage = "encoding"
    encode_m4a(out, sr, out_path)


@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "version": VERSION,
        "features": {"youtube": youtube.available(), "separation": separation_enabled()},
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
        out = os.path.join(d, "result.m4a")
        if separate:
            _separate_into(job, info["path"], out)
        else:
            job.stage = "encoding"
            job.progress = None
            transcode_m4a(info["path"], out)
        job.result_path = out

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
        out = os.path.join(d, "result.m4a")
        _separate_into(job, src, out)
        job.result_path = out

    return manager.create("separate", work).public()


@app.get("/api/jobs/{job_id}", dependencies=[Depends(require_auth)])
def get_job(job_id: str) -> dict:
    job = manager.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found (it may have expired).")
    return job.public()


@app.get("/api/jobs/{job_id}/audio", dependencies=[Depends(require_auth)])
def get_job_audio(job_id: str) -> FileResponse:
    job = manager.get(job_id)
    if not job or job.status != "done" or not job.result_path or not os.path.exists(job.result_path):
        raise HTTPException(status_code=404, detail="No processed audio for this job.")
    return FileResponse(job.result_path, media_type="audio/mp4", filename="audio.m4a")
