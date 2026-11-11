"""
SCNet int8 ONNX model file: pinned download + SHA-256 verification (standard library only, so the
Dockerfile can run this file on its own at build time:  python model.py /srv/models/scnet.int8.onnx).

Model: SCNet by starrytong (https://github.com/starrytong/SCNet, MIT; redistribution of format-converted
weights confirmed in starrytong/SCNet#35), ONNX export and int8 compaction by audiojs
(https://huggingface.co/audiojs/scnet). Same file the web app ships in public/models/scnet/.
"""
from __future__ import annotations

import hashlib
import os
import sys
import tempfile
import urllib.request

MODEL_URL = "https://huggingface.co/audiojs/scnet/resolve/e71bcdb42bce1d62b7fae25ba90fcbcf90f73f46/scnet.int8.onnx"
MODEL_SHA256 = "98228931494151762a1c4ab1ec7899a894b1f81fd4a509921a9d2f9bacc50845"
MODEL_BYTES = 12_900_277


class ModelError(RuntimeError):
    pass


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def verify(path: str) -> None:
    if not os.path.isfile(path):
        raise ModelError(f"SCNet model not found at {path}")
    digest = sha256_file(path)
    if digest != MODEL_SHA256:
        raise ModelError(f"SCNet model at {path} has SHA-256 {digest}, expected {MODEL_SHA256}")


def download(path: str, url: str = MODEL_URL, timeout: float = 120) -> None:
    """Download to a temporary file next to `path`, verify the hash, then move it into place atomically."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".scnet-", suffix=".part", dir=os.path.dirname(os.path.abspath(path)))
    try:
        h = hashlib.sha256()
        size = 0
        req = urllib.request.Request(url, headers={"User-Agent": "piano2vision-server"})
        with urllib.request.urlopen(req, timeout=timeout) as res, os.fdopen(fd, "wb") as out:  # noqa: S310 - pinned https URL
            while chunk := res.read(1 << 20):
                size += len(chunk)
                if size > MODEL_BYTES * 2:
                    raise ModelError("SCNet model download is larger than expected")
                h.update(chunk)
                out.write(chunk)
        if h.hexdigest() != MODEL_SHA256:
            raise ModelError(f"SCNet model download has SHA-256 {h.hexdigest()}, expected {MODEL_SHA256}")
        os.chmod(tmp, 0o644)  # mkstemp creates 0600; the Docker image downloads as root and runs as `app`
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def ensure(path: str, allow_download: bool = True) -> str:
    """Return `path` once it holds the verified model, downloading it first if allowed."""
    if not os.path.isfile(path):
        if not allow_download:
            raise ModelError(f"SCNet model not found at {path} (set SCNET_MODEL or enable SCNET_AUTO_DOWNLOAD)")
        download(path)
    verify(path)
    return path


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "scnet.int8.onnx"
    ensure(target)
    print(f"{target}: OK ({MODEL_SHA256})")
