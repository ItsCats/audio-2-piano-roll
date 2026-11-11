"""In-process job queue with on-disk results and time-based cleanup."""
from __future__ import annotations

import os
import shutil
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Callable

from .config import settings


@dataclass
class Job:
    id: str
    kind: str
    status: str = "queued"  # queued | running | done | error
    stage: str = "queued"
    progress: float | None = None
    error: str | None = None
    title: str | None = None
    artist: str | None = None
    duration: float | None = None
    detail: str | None = None
    result_path: str | None = None
    created: float = field(default_factory=time.time)

    def public(self) -> dict:
        return {
            "id": self.id,
            "status": self.status,
            "stage": self.stage,
            "progress": self.progress,
            "error": self.error,
            "title": self.title,
            "artist": self.artist,
            "duration": self.duration,
            "detail": self.detail,
        }


class JobManager:
    def __init__(self) -> None:
        self.jobs: dict[str, Job] = {}
        self.lock = threading.Lock()
        self.pool = ThreadPoolExecutor(max_workers=max(1, settings.workers))
        os.makedirs(settings.data_dir, exist_ok=True)
        threading.Thread(target=self._janitor, daemon=True).start()

    def job_dir(self, job_id: str) -> str:
        d = os.path.join(settings.data_dir, job_id)
        os.makedirs(d, exist_ok=True)
        return d

    def create(self, kind: str, fn: Callable[[Job], None]) -> Job:
        job = Job(id=uuid.uuid4().hex, kind=kind)
        with self.lock:
            self.jobs[job.id] = job

        def run() -> None:
            job.status = "running"
            try:
                fn(job)
                job.status = "done"
                job.stage = "done"
                job.progress = 1.0
            except Exception as e:  # noqa: BLE001 - surfaced to the client
                job.status = "error"
                job.error = str(e) or e.__class__.__name__

        self.pool.submit(run)
        return job

    def get(self, job_id: str) -> Job | None:
        with self.lock:
            return self.jobs.get(job_id)

    def _janitor(self) -> None:
        while True:
            time.sleep(60)
            cutoff = time.time() - settings.job_ttl_sec
            with self.lock:
                old = [j for j in self.jobs.values() if j.created < cutoff and j.status in ("done", "error")]
                for j in old:
                    self.jobs.pop(j.id, None)
            for j in old:
                shutil.rmtree(os.path.join(settings.data_dir, j.id), ignore_errors=True)


manager = JobManager()
