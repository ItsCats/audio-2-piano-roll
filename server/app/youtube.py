"""
YouTube audio retrieval with yt-dlp.

Only enable this for content you own or have permission to use, in line with YouTube's
Terms of Service and copyright law. URLs are restricted to YouTube hosts (no arbitrary
fetching / SSRF), playlists are disabled and duration is capped.
"""
from __future__ import annotations

import glob
import os
from urllib.parse import urlparse

from .config import settings

ALLOWED_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}


def available() -> bool:
    try:
        import yt_dlp  # noqa: F401

        return settings.enable_youtube
    except Exception:  # noqa: BLE001
        return False


def validate_url(url: str) -> str:
    u = urlparse(url.strip())
    if u.scheme not in ("http", "https") or (u.hostname or "").lower() not in ALLOWED_HOSTS:
        raise ValueError("Only youtube.com / youtu.be video URLs are accepted.")
    return url.strip()


def friendly_error(msg: str) -> str:
    m = msg.lower()
    if "403" in m or "sign in to confirm" in m or "not a bot" in m:
        return (
            "YouTube refused the download from this server. YouTube blocks most cloud/datacenter IP addresses — "
            "run the processing server on your own computer (home connection), use 'Record from this tab', "
            "or upload an audio file you have rights to."
        )
    if "private video" in m or "members-only" in m:
        return "This video is private or members-only."
    if "age" in m and "restrict" in m:
        return "This video is age-restricted and cannot be fetched."
    if "unavailable" in m:
        return "This video is unavailable (removed, region-locked or private)."
    return msg.replace("ERROR: ", "")


def download_audio(url: str, out_dir: str, on_progress) -> dict:
    import yt_dlp

    def hook(d: dict) -> None:
        if d.get("status") == "downloading":
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            if total:
                on_progress(min(1.0, d.get("downloaded_bytes", 0) / total))

    def match_filter(info: dict, *, incomplete: bool = False):
        dur = info.get("duration")
        if dur and dur > settings.max_duration_sec:
            return f"Video is {round(dur / 60)} min long; the limit is {settings.max_duration_sec // 60} min."
        if info.get("is_live"):
            return "Live streams are not supported."
        return None

    opts = {
        "format": "bestaudio/best",
        "outtmpl": os.path.join(out_dir, "source.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [hook],
        "match_filter": match_filter,
        "max_filesize": settings.max_upload_mb * 1024 * 1024 * 2,
        "socket_timeout": 30,
        "retries": 3,
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except yt_dlp.utils.DownloadError as e:
        raise RuntimeError(friendly_error(str(e))) from e
    if info is None:
        raise RuntimeError("Could not retrieve this video.")
    files = glob.glob(os.path.join(out_dir, "source.*"))
    if not files:
        reason = info.get("__skip_reason") if isinstance(info, dict) else None
        raise RuntimeError(reason or "The video could not be downloaded (it may be private, age-restricted or too long).")
    return {"path": files[0], "title": info.get("title"), "artist": info.get("artist") or info.get("uploader"), "duration": info.get("duration")}
