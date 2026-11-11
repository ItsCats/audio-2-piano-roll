"""
Cross-check a vocal reference (vocal_ref.py, torchcrepe) against an independent pitch tracker
(librosa pYIN) on the same stem: if the two disagree, the reference is not trustworthy there.

    server/.venv/bin/python tests/accuracy/vocal_ref_check.py STEMS_DIR/<song> REF.f0.npz [--seconds N]
"""
import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from acclib import load_audio  # noqa: E402
from metrics import melody_metrics  # noqa: E402


def main() -> None:
    import librosa

    ap = argparse.ArgumentParser()
    ap.add_argument("stem_dir")
    ap.add_argument("ref")
    ap.add_argument("--seconds", type=float, default=0)
    a = ap.parse_args()
    d = np.load(a.ref)
    t, f = d["times"], d["f0"]
    sr = 16000
    y = load_audio(os.path.join(a.stem_dir, "vocals.wav"), sr)
    if a.seconds:
        y = y[: int(a.seconds * sr)]
        k = t < a.seconds
        t, f = t[k], f[k]
    f0, vflag, vprob = librosa.pyin(y, fmin=65, fmax=1100, sr=sr, frame_length=1024, hop_length=160, center=True)
    f0 = np.where(vflag, f0, 0.0)
    n = min(len(f0), len(f))
    t, f, f0 = t[:n], f[:n], np.nan_to_num(f0[:n])
    both = (f > 0) & (f0 > 0)
    out = {
        "frames": int(n),
        "crepeVoiced": round(float((f > 0).mean()), 4),
        "pyinVoiced": round(float((f0 > 0).mean()), 4),
        "voicingAgreement": round(float(((f > 0) == (f0 > 0)).mean()), 4),
        "pyinVsCrepe": melody_metrics(t, f, f0),
        "within50centsWhereBothVoiced": round(float((np.abs(1200 * np.log2(f0[both] / f[both])) < 50).mean()), 4) if both.any() else None,
    }
    print(json.dumps(out))


if __name__ == "__main__":
    main()
