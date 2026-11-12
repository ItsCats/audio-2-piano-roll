"""Configuration from environment variables (see server/README.md)."""
import os
from dataclasses import dataclass, field


def _bool(name: str, default: bool) -> bool:
    v = os.environ.get(name)
    return default if v is None else v.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    shared_secret: str = os.environ.get("SHARED_SECRET", "")
    allow_anonymous: bool = _bool("ALLOW_ANONYMOUS", False)
    allowed_origins: list[str] = field(
        default_factory=lambda: [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "http://localhost:5173").split(",") if o.strip()]
    )
    data_dir: str = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(__file__), "..", "data"))
    max_upload_mb: int = int(os.environ.get("MAX_UPLOAD_MB", "200"))
    max_duration_sec: int = int(os.environ.get("MAX_DURATION_SEC", str(20 * 60)))
    job_ttl_sec: int = int(os.environ.get("JOB_TTL_SEC", "3600"))
    enable_youtube: bool = _bool("ENABLE_YOUTUBE", True)
    enable_separation: bool = _bool("ENABLE_SEPARATION", True)
    # SCNet separation (see app/separation.py). SCNET_MODEL: path to scnet.int8.onnx (default DATA_DIR/models/...;
    # the Docker image bakes it in). Missing files are downloaded from the pinned URL and SHA-256-verified.
    scnet_model: str = os.environ.get("SCNET_MODEL", "")
    scnet_auto_download: bool = _bool("SCNET_AUTO_DOWNLOAD", True)
    scnet_threads: int = int(os.environ.get("SCNET_THREADS", "0"))  # 0 = all cores
    scnet_step: float = float(os.environ.get("SCNET_STEP", "0.9"))  # segment hop / 11 s; 0.9 = same as the browser
    scnet_fade: float = 0.1
    jobs_per_hour_per_ip: int = int(os.environ.get("JOBS_PER_HOUR_PER_IP", "20"))
    workers: int = int(os.environ.get("WORKERS", "1"))


settings = Settings()
