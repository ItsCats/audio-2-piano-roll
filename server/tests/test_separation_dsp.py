"""STFT / segmenting of app/separation.py without the model."""
import numpy as np
import pytest

from app import separation as sep


def test_stft_istft_round_trip():
    rng = np.random.default_rng(0)
    x = rng.standard_normal((2, sep.L))
    z = sep.stft(x)
    assert z.shape == (2, sep.F, sep.T)
    y = sep.istft(z)
    assert np.max(np.abs(y - x)) < 1e-9


def test_stft_matches_loop_reference():
    """Vectorised istft == the frame-by-frame overlap-add of the python/browser reference."""
    rng = np.random.default_rng(1)
    z = rng.standard_normal((sep.F, sep.T)) + 1j * rng.standard_normal((sep.F, sep.T))
    fr = np.fft.irfft(z.T / sep.SCALE, n=sep.N_FFT, axis=-1)
    out = np.zeros((sep.T - 1) * sep.HOP + sep.N_FFT)
    env = np.zeros_like(out)
    for m in range(sep.T):
        out[m * sep.HOP : m * sep.HOP + sep.N_FFT] += fr[m]
        env[m * sep.HOP : m * sep.HOP + sep.N_FFT] += 1
    p = sep.N_FFT // 2
    ref = out[p : p + sep.L] / env[p : p + sep.L]
    assert np.max(np.abs(sep.istft(z) - ref)) < 1e-9


def test_plan_matches_browser_layout():
    # 60 s at 44.1 kHz, step 0.9: border = 48 510, 7 segments (same as dsp.ts planSegments)
    starts, m, offset, fade = sep.plan_segments(60 * 44100, 0.9)
    assert offset == sep.L - int(sep.L * 0.9) == 48510
    assert m == 60 * 44100 + 2 * offset
    assert starts[1] == int(sep.L * 0.9) and starts[-1] + sep.L >= m and starts[-2] + sep.L < m
    assert fade == int(sep.L * 0.1)
    assert sep.plan_segments(5 * 44100, 0.9)[0] == [0]


def _identity_model(spec):
    """Every stem = the input mixture, so vocals = mix - DC and accomp (bass + other) = 2 * (mix - DC)."""
    return np.tile(spec, (1, 4, 1, 1))


@pytest.mark.parametrize("seconds", [3.0, 7.0, 23.0])
def test_separate_reconstructs_with_identity_model(seconds):
    rng = np.random.default_rng(2)
    n = int(seconds * sep.SR)
    t = np.arange(n) / sep.SR
    left = 0.3 * np.sin(2 * np.pi * 220 * t) + 0.05 * rng.standard_normal(n) + 0.01
    right = 0.3 * np.sin(2 * np.pi * 330 * t) + 0.05 * rng.standard_normal(n) + 0.01
    audio = np.stack([left, right]).astype(np.float32)
    progress = []
    out = sep.separate(audio, lambda d, total: progress.append((d, total)), step=0.9, run=_identity_model)
    mono = audio.astype(np.float64).mean(0)
    expect = mono - mono.mean()
    assert out["vocals"].shape == (n,) and out["vocals"].dtype == np.float32
    assert np.max(np.abs(out["vocals"] - expect)) < 1e-5
    assert np.max(np.abs(out["accomp"] - 2 * expect)) < 2e-5
    total = progress[-1][1]
    assert progress == [(k, total) for k in range(1, total + 1)]
    assert total == len(sep.plan_segments(n, 0.9)[0])
