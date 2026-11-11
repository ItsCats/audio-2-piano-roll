"""
Reference melody (and bass line) from Demucs stems, for songs without note ground truth.

    server/.venv/bin/python tests/accuracy/vocal_ref.py STEMS_DIR/<song> OUT_PREFIX [--stem vocals] [--fmin 65 --fmax 1100]

Pitch tracking: torchcrepe ('full' model, 10 ms hop, Viterbi decoding). A frame is voiced when
CREPE periodicity >= 0.5 (median-filtered over 30 ms) AND the stem's local RMS is within 35 dB of
its 95th percentile (separation bleed is quiet). Notes: voiced runs are split where the pitch
leaves the running segment median by > 0.75 semitone for >= 40 ms; segments >= 100 ms keep the
rounded median pitch; equal-pitch segments separated by < 60 ms are merged.

Outputs OUT_PREFIX.f0.npz (times, f0 Hz with 0 = unvoiced, periodicity) and OUT_PREFIX.notes.json.
This is a strong PROXY: separation artefacts, backing vocals / harmonies, vibrato and portamento
all leak into it.
"""
from __future__ import annotations

import argparse
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from acclib import NoteArr, load_audio, save_notes  # noqa: E402

HOP_S = 0.01


def track(path: str, fmin: float, fmax: float, per_thr: float = 0.5, rms_db: float = -35):
    import torch
    import torchcrepe

    torch.set_num_threads(os.cpu_count() or 4)
    sr = 16000
    y = load_audio(path, sr)
    hop = int(HOP_S * sr)
    with torch.no_grad():
        f0, per = torchcrepe.predict(torch.from_numpy(y)[None], sr, hop, fmin, fmax, "full", batch_size=1024,
                                     device="cpu", decoder=torchcrepe.decode.viterbi, return_periodicity=True)
    per = torchcrepe.filter.median(per, 3)
    f0 = f0[0].numpy()
    per = per[0].numpy()
    n = len(f0)
    frames = np.lib.stride_tricks.sliding_window_view(np.pad(y, (512, 512 + n * hop)), 1024)[::hop][:n]
    rms = np.sqrt((frames ** 2).mean(1) + 1e-12)
    ref = np.percentile(rms, 95)
    loud = 20 * np.log10(rms / ref + 1e-12) > rms_db
    voiced = (per >= per_thr) & loud
    times = np.arange(n) * HOP_S
    return times, np.where(voiced, f0, 0.0), per


def segment(times: np.ndarray, f0: np.ndarray, split_st: float = 0.75, min_dur: float = 0.1) -> NoteArr:
    midi = np.where(f0 > 0, 69 + 12 * np.log2(np.maximum(f0, 1e-6) / 440), np.nan)
    segs = []
    i, n = 0, len(midi)
    while i < n:
        if np.isnan(midi[i]):
            i += 1
            continue
        start = i
        vals = [midi[i]]
        dev = 0
        j = i + 1
        while j < n and not np.isnan(midi[j]):
            med = np.median(vals[-30:])
            if abs(midi[j] - med) > split_st:
                dev += 1
                if dev >= 4:
                    j -= dev - 1
                    break
            else:
                dev = 0
            vals.append(midi[j])
            j += 1
        end = j
        seg = midi[start:end]
        if (end - start) * HOP_S >= min_dur:
            segs.append([times[start], times[end - 1] + HOP_S, int(np.round(np.median(seg)))])
        i = max(end, start + 1)
    merged = []
    for s in segs:
        if merged and merged[-1][2] == s[2] and s[0] - merged[-1][1] < 0.06:
            merged[-1][1] = s[1]
        else:
            merged.append(s)
    if not merged:
        return NoteArr.empty()
    a = np.array(merged)
    return NoteArr(a[:, 0], a[:, 1], a[:, 2].astype(int), np.full(len(a), 0.8), np.array(["R"] * len(a)))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("stem_dir")
    ap.add_argument("out_prefix")
    ap.add_argument("--stem", default="vocals")
    ap.add_argument("--fmin", type=float, default=65)
    ap.add_argument("--fmax", type=float, default=1100)
    a = ap.parse_args()
    t0 = time.time()
    times, f0, per = track(os.path.join(a.stem_dir, f"{a.stem}.wav"), a.fmin, a.fmax)
    notes = segment(times, f0)
    np.savez_compressed(a.out_prefix + ".f0.npz", times=times, f0=f0, periodicity=per)
    v = f0 > 0
    meta = {"stem": a.stem, "voicedFraction": round(float(v.mean()), 3), "nNotes": len(notes),
            "medianMidi": float(np.median(69 + 12 * np.log2(f0[v] / 440))) if v.any() else None, "seconds": round(time.time() - t0, 1)}
    save_notes(a.out_prefix + ".notes.json", notes, meta)
    print(os.path.basename(a.stem_dir), a.stem, meta, flush=True)


if __name__ == "__main__":
    main()
