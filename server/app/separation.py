"""
Source separation with Demucs (Meta, MIT licence). Optional: only used when the `demucs`
package is installed.

Strategy for "make a piano arrangement of this song":
  * htdemucs_6s splits drums / bass / other / vocals / guitar / piano.
  * If the piano stem carries a meaningful share of the energy, we return the piano stem.
  * Otherwise (a band arrangement without piano) we return everything except drums —
    drums add broadband noise that confuses pitch detection, while vocals carry the melody.
"""
from __future__ import annotations

import threading

import numpy as np

_model = None
_lock = threading.Lock()


def available() -> bool:
    try:
        import demucs  # noqa: F401
        import torch  # noqa: F401

        return True
    except Exception:  # noqa: BLE001
        return False


def _get_model(name: str):
    global _model
    with _lock:
        if _model is None:
            from demucs.pretrained import get_model

            _model = get_model(name)
            _model.eval()
        return _model


def separate(audio: np.ndarray, sr: int, model_name: str) -> tuple[np.ndarray, str]:
    """audio: (2, n) float32 at the model sample rate. Returns (stereo audio, description)."""
    import torch
    from demucs.apply import apply_model

    model = _get_model(model_name)
    if sr != model.samplerate:
        raise ValueError(f"expected {model.samplerate} Hz audio")
    wav = torch.from_numpy(audio)
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    with torch.no_grad():
        sources = apply_model(model, ((wav - mean) / std)[None], split=True, overlap=0.25, progress=False)[0]
    sources = sources * std + mean
    names = list(model.sources)
    energy = {n: float((sources[i] ** 2).mean()) for i, n in enumerate(names)}
    total = sum(energy.values()) or 1.0
    if "piano" in names and energy["piano"] / total > 0.12:
        out = sources[names.index("piano")]
        desc = "piano stem"
    else:
        keep = [i for i, n in enumerate(names) if n != "drums"]
        out = sources[keep].sum(0)
        desc = "mix without drums"
    peak = float(out.abs().max()) or 1.0
    out = out / max(1.0, peak / 0.98)
    return out.cpu().numpy().astype(np.float32), desc
