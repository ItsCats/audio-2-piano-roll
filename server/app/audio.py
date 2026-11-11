"""ffmpeg/ffprobe helpers."""
import json
import subprocess

import numpy as np


class AudioError(RuntimeError):
    pass


def probe_duration(path: str) -> float:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", path],
            check=True, capture_output=True, text=True, timeout=60,
        ).stdout
        return float(json.loads(out)["format"]["duration"])
    except Exception as e:  # noqa: BLE001
        raise AudioError("The file is not a readable audio/video file.") from e


def has_audio_stream(path: str) -> bool:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "json", path],
        capture_output=True, text=True, timeout=60,
    ).stdout
    try:
        return bool(json.loads(out).get("streams"))
    except json.JSONDecodeError:
        return False


def decode(path: str, sr: int = 44100, channels: int = 2) -> np.ndarray:
    """Decode to float32 array shaped (channels, samples)."""
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", str(channels), "-ar", str(sr), "-"],
        capture_output=True, timeout=600,
    )
    if proc.returncode != 0:
        raise AudioError(proc.stderr.decode(errors="ignore")[-300:] or "ffmpeg failed to decode the audio")
    data = np.frombuffer(proc.stdout, dtype=np.float32)
    return data.reshape(-1, channels).T.copy()


def encode_m4a(audio: np.ndarray, sr: int, out_path: str) -> None:
    """Encode (channels, samples) float32 to AAC in M4A (decodable by every browser)."""
    interleaved = np.ascontiguousarray(np.clip(audio, -1, 1).T).astype(np.float32).tobytes()
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ac", str(audio.shape[0]), "-ar", str(sr), "-i", "-",
         "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out_path],
        input=interleaved, capture_output=True, timeout=600,
    )
    if proc.returncode != 0:
        raise AudioError("Could not encode the processed audio")


def encode_flac(mono: np.ndarray, sr: int, out_path: str, out_sr: int = 22050) -> None:
    """Encode a mono float32 stem as 16-bit FLAC at `out_sr` (lossless, no encoder delay, so stems stay
    sample-aligned with the mixture; every current browser decodes FLAC). Callers keep |x| <= 1."""
    data = np.ascontiguousarray(np.clip(mono, -1, 1)).astype(np.float32).tobytes()
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "f32le", "-ac", "1", "-ar", str(sr), "-i", "-",
         "-ar", str(out_sr), "-sample_fmt", "s16", "-c:a", "flac", "-compression_level", "5", out_path],
        input=data, capture_output=True, timeout=600,
    )
    if proc.returncode != 0:
        raise AudioError("Could not encode the separated stems")


def transcode_m4a(in_path: str, out_path: str) -> None:
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", in_path, "-vn", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out_path],
        capture_output=True, timeout=900,
    )
    if proc.returncode != 0:
        raise AudioError("Could not convert the downloaded audio")
