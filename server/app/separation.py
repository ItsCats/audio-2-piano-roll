"""
Source separation with SCNet (starrytong, MIT) as an int8 ONNX graph (audiojs export) on onnxruntime CPU.

The graph maps a spectrogram to four stem spectrograms (drums, bass, other, vocals); the STFT/iSTFT and the
segmenting run here in numpy, exactly like the browser worker (src/lib/separation/dsp.ts), so both engines
produce the same stems:
  * STFT n_fft 4096, hop 1024, rectangular window, centred reflect padding, scaled by 1/sqrt(4096);
    input `mix_spec` [1, 4, 2049, 476] = 11 s of 44.1 kHz stereo as (L re, L im, R re, R im);
    output [1, 16, 2049, 476] = 4 stems x 2 channels x (re, im).
  * The mono downmix's mean / std normalise the input; 11 s segments every `step` x 11 s (default 0.9,
    i.e. 10 % overlap) with 1.1 s linear cross-fades; a long track is reflect-extended by the overlap
    on both sides (Music-Source-Separation-Training demix()).

We only need two mono stems, so the stereo channels and bass + other are summed in the spectral domain
(the iSTFT is linear): 2 inverse transforms per segment instead of 16, and two mono accumulators.
  vocals = stem 3,  accomp = stem 1 (bass) + stem 2 (other)  -> no drums, no vocals.
"""
from __future__ import annotations

import os
import threading
from typing import Callable

import numpy as np

from . import model as model_file
from .config import settings

SR = 44100
N_FFT, HOP = 4096, 1024
F = N_FFT // 2 + 1
T = 476  # frames per segment
L = 485_100  # samples per segment (11 s)
SCALE = 1 / np.sqrt(N_FFT)
PADDED = max(L, (T - 1) * HOP)  # the graph's frame count implies zero padding to 486 400 before centring

_session = None
_lock = threading.Lock()


def model_path() -> str:
    return settings.scnet_model or os.path.join(settings.data_dir, "models", "scnet.int8.onnx")


def available() -> bool:
    """onnxruntime is installed and the model is present (or may be fetched on first use)."""
    try:
        import onnxruntime  # noqa: F401
    except Exception:  # noqa: BLE001
        return False
    return os.path.isfile(model_path()) or settings.scnet_auto_download


def _get_session():
    global _session
    with _lock:
        if _session is None:
            import onnxruntime as ort

            path = model_file.ensure(model_path(), settings.scnet_auto_download)
            so = ort.SessionOptions()
            so.intra_op_num_threads = settings.scnet_threads or (os.cpu_count() or 1)
            so.inter_op_num_threads = 1
            # memory-pattern planning keeps every intermediate of the 476-frame graph alive: ~2.2 GB peak RSS
            # with it, ~1.3 GB without, at the same speed (measured on 4 cores)
            so.enable_mem_pattern = False
            _session = ort.InferenceSession(path, so, providers=["CPUExecutionProvider"])
        return _session


def _onnx_runner() -> Callable[[np.ndarray], np.ndarray]:
    sess = _get_session()
    name = sess.get_inputs()[0].name
    return lambda spec: sess.run(None, {name: spec})[0]


# ------------------------------------------------------------------------------------------ DSP


def reflect_index(i: np.ndarray, n: int) -> np.ndarray:
    """numpy 'reflect' (edge sample not repeated), valid for -n < i < 2n - 1."""
    i = np.abs(i)
    return np.where(i >= n, 2 * (n - 1) - i, i)


_FRAME_IDX = np.arange(T)[:, None] * HOP - N_FFT // 2 + np.arange(N_FFT)[None]
_FRAME_IDX = reflect_index(_FRAME_IDX, PADDED)


def stft(x: np.ndarray) -> np.ndarray:
    """x (..., L) -> complex (..., F, T)."""
    padded = np.zeros(x.shape[:-1] + (PADDED,))
    padded[..., : x.shape[-1]] = x
    frames = padded[..., _FRAME_IDX]  # (..., T, N_FFT)
    return np.swapaxes(np.fft.rfft(frames, axis=-1) * SCALE, -1, -2)


_ENV = None


def istft(z: np.ndarray, length: int = L) -> np.ndarray:
    """z complex (..., F, T) -> (..., length). Overlap-add of rectangular frames divided by the frame count."""
    global _ENV
    fr = np.fft.irfft(np.swapaxes(z, -1, -2) / SCALE, n=N_FFT, axis=-1)  # (..., T, N_FFT)
    k = N_FFT // HOP
    blocks = np.zeros(fr.shape[:-2] + (T + k - 1, HOP))
    for j in range(k):
        blocks[..., j : j + T, :] += fr[..., :, j * HOP : (j + 1) * HOP]
    out = blocks.reshape(fr.shape[:-2] + (-1,))
    if _ENV is None:
        env = np.zeros((T + k - 1, HOP))
        for j in range(k):
            env[j : j + T] += 1
        _ENV = env.reshape(-1)
    p = N_FFT // 2
    return out[..., p : p + length] / _ENV[p : p + length]


def plan_segments(n: int, step: float) -> tuple[list[int], int, int, int]:
    """(segment starts in the extended signal, extended length m, offset, fade length) — as dsp.ts planSegments()."""
    step_n = int(L * step)
    border = L - step_n
    wide = n > 2 * border
    m = n + 2 * border if wide else n
    starts = []
    s = 0
    while True:
        starts.append(s)
        if s + L >= m:
            break
        s += step_n
    return starts, m, (border if wide else 0), int(L * settings.scnet_fade)


def _weights(ln: int, k: int, count: int, fade: int) -> np.ndarray:
    i = np.arange(ln)
    w = np.ones(ln)
    if k > 0:
        w = np.where(i < fade, i / (fade - 1), w)
    if k < count - 1:
        w = np.minimum(w, np.where(i >= L - fade, (L - 1 - i) / (fade - 1), 1.0))
    return w


def separate(
    audio: np.ndarray,
    on_progress: Callable[[int, int], None] | None = None,
    step: float | None = None,
    run: Callable[[np.ndarray], np.ndarray] | None = None,
) -> dict[str, np.ndarray]:
    """audio: (2, n) float32 at 44.1 kHz. Returns mono 44.1 kHz float32 {'vocals', 'accomp'} (DC removed, like the
    browser). `run` maps mix_spec [1,4,F,T] float32 -> [1,16,F,T]; defaults to the SCNet ONNX session."""
    if audio.ndim != 2 or audio.shape[0] != 2:
        raise ValueError("expected stereo audio shaped (2, n)")
    run = run or _onnx_runner()
    step = min(1.0, max(0.25, step or settings.scnet_step))
    n = audio.shape[1]
    mono = audio.astype(np.float64).mean(0)
    mean = float(mono.mean()) if n else 0.0
    std = float(mono.std(ddof=1)) + 1e-8 if n > 1 else 1.0
    del mono
    starts, m, offset, fade = plan_segments(n, step)
    acc = np.zeros((2, m), np.float32)  # vocals, accomp
    ws = np.zeros(m, np.float32)
    spec = np.zeros((1, 4, F, T), np.float32)
    for k, st in enumerate(starts):
        ln = min(L, m - st)
        if ln > L / 2:
            pos = st + reflect_index(np.arange(L), ln)
            valid = np.ones(L, bool)
        else:
            valid = np.arange(L) < ln
            pos = st + np.minimum(np.arange(L), ln - 1)  # zero-padded tail (masked below)
        src = reflect_index(pos - offset, n) if offset else np.minimum(pos, n - 1)
        seg = np.where(valid, (audio[:, src].astype(np.float64) - mean) / std, 0.0)  # (2, L)
        z = stft(seg)  # (2, F, T)
        spec[0, 0], spec[0, 1], spec[0, 2], spec[0, 3] = z[0].real, z[0].imag, z[1].real, z[1].imag
        y = run(spec)[0].astype(np.float64)  # (16, F, T)
        # index 2 * (stem * 2 + channel) = re, +1 = im; mono = mean of L and R
        voc = (y[12] + y[14]) + 1j * (y[13] + y[15])
        acc_z = (y[4] + y[6] + y[8] + y[10]) + 1j * (y[5] + y[7] + y[9] + y[11])
        out = istft(np.stack([voc, acc_z])) * (0.5 * std)  # (2, L)
        w = _weights(ln, k, len(starts), fade)
        acc[:, st : st + ln] += (out[:, :ln] * w).astype(np.float32)
        ws[st : st + ln] += w.astype(np.float32)
        if on_progress:
            on_progress(k + 1, len(starts))
    res = acc[:, offset : offset + n] / np.maximum(ws[offset : offset + n], 1e-12)
    return {"vocals": res[0].astype(np.float32), "accomp": res[1].astype(np.float32)}
