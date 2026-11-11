"""
Separate songs into stems with Demucs (server-side, reference building only).

    server/.venv/bin/python tests/accuracy/separate.py OUT_DIR song1.mp3 [song2.mp3 ...]

Writes OUT_DIR/<stem-name>/<source>.wav (44.1 kHz stereo float) for vocals, bass, piano,
guitar, other, drums. Already separated songs are skipped. Output is derived from the
input audio: keep it out of the repository.
"""
from __future__ import annotations

import os
import subprocess
import sys
import time

import numpy as np
import soundfile as sf
import torch


def load(path: str, sr: int) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "2", "-ar", str(sr), "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, 2).T.copy()


def main() -> None:
    out_dir, songs = sys.argv[1], sys.argv[2:]
    model_name = os.environ.get("DEMUCS_MODEL", "htdemucs_6s")
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    torch.set_num_threads(os.cpu_count() or 4)
    model = get_model(model_name)
    model.eval()
    for song in songs:
        name = os.path.splitext(os.path.basename(song))[0]
        d = os.path.join(out_dir, name)
        if os.path.exists(os.path.join(d, "vocals.wav")):
            print(f"skip {name}")
            continue
        os.makedirs(d, exist_ok=True)
        t0 = time.time()
        wav = torch.from_numpy(load(song, model.samplerate))
        ref = wav.mean(0)
        mean, std = ref.mean(), ref.std() + 1e-8
        with torch.no_grad():
            src = apply_model(model, ((wav - mean) / std)[None], split=True, overlap=0.25, progress=False)[0]
        src = src * std + mean
        for i, s in enumerate(model.sources):
            sf.write(os.path.join(d, f"{s}.wav"), src[i].cpu().numpy().T, model.samplerate, subtype="FLOAT")
        print(f"{name}: {time.time() - t0:.1f}s", flush=True)


if __name__ == "__main__":
    main()
