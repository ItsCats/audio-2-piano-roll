"""
Align a score MIDI to a real recording and write time-warped reference notes.

    server/.venv/bin/python tests/accuracy/align_score.py SCORE.mid RECORDING.mp3 OUT.json [--no-refine]
        [--truth PERFORMANCE.midi]   # validation only: compare the aligned notes with exact MIDI

Method
  1. Render the score with a simple additive synth (acclib.synth).
  2. Features for both signals: CQT chroma + onset chroma (locally normalised positive
     semitone-spectrum differences folded to 12 pitch classes); cost = sum of cosine distances.
  3. Coarse full DTW at 186 ms hop, then banded DTW at 23 ms hop within +-1.5 s of the coarse path.
  4. Warp every note onset/offset through the (monotone, interpolated) path.
  5. Optional refinement (default on): every score chord (notes sharing a score onset) is moved to
     the strongest rise of the recording's semitone spectrum at the chord's pitches (+ octave
     partials) within +-90 ms, with a Gaussian prior toward the DTW time, if that rise is salient.
     Model-free (CQT only), so it does not bias toward the transcriber.
  6. Quality report: residual between aligned chord onsets and librosa-detected audio onsets
     (overall + per 30 s segment) — segments with a large residual are flagged unreliable.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from acclib import (SR, NoteArr, chroma, dtw_path, load_audio, midi_notes, onset_chroma,  # noqa: E402
                    save_notes, semitone_spec, synth)


def active_range(y: np.ndarray, sr: int, thr_db: float = -45) -> tuple[float, float]:
    hop = 512
    n = len(y) // hop
    rms = np.sqrt((y[: n * hop].reshape(n, hop) ** 2).mean(1) + 1e-12)
    db = 20 * np.log10(rms / rms.max())
    idx = np.where(db > thr_db)[0]
    return idx[0] * hop / sr, (idx[-1] + 1) * hop / sr


def features(y: np.ndarray, hop: int) -> np.ndarray:
    c = chroma(y, SR, hop)
    o = onset_chroma(y, SR, hop)
    T = min(c.shape[1], o.shape[1])
    return np.vstack([c[:, :T], o[:, :T]])


W_ONSET = 0.7


def weighted(F: np.ndarray) -> np.ndarray:
    """Scale feature groups so that 1.7 - <a, b> = cosdist(chroma) + 0.7 * cosdist(onset chroma)."""
    return np.vstack([F[:12], np.sqrt(W_ONSET) * F[12:]])


def warp_function(path: np.ndarray, hop_s: float):
    """score time -> audio time from a DTW path (rows = score frames, cols = audio frames)."""
    rows, cols = path[:, 0], path[:, 1]
    ur = np.unique(rows)
    mean_col = np.array([cols[rows == r].mean() for r in ur])
    xs = ur * hop_s
    ys = np.maximum.accumulate(mean_col * hop_s)
    return lambda t: np.interp(t, xs, ys)


def refine(notes: NoteArr, score_onsets: np.ndarray, y: np.ndarray, win: float = 0.09, sigma: float = 0.05):
    hop = 256
    S = semitone_spec(y, SR, hop)
    nov = np.maximum(0, np.diff(S, axis=1, prepend=S[:, :1]))
    fps = SR / hop
    out = notes.onset.copy()
    moved = []
    keys = np.round(score_onsets, 3)
    for k in np.unique(keys):
        idx = np.where(keys == k)[0]
        t0 = float(np.median(notes.onset[idx]))
        i0, i1 = int((t0 - win) * fps), int((t0 + win) * fps) + 1
        if i0 < 1 or i1 >= nov.shape[1]:
            continue
        curve = np.zeros(i1 - i0)
        for p in set(int(x) for x in notes.pitch[idx]):
            r = p - 21
            if 0 <= r < 88:
                curve += nov[r, i0:i1]
            if 0 <= r + 12 < 88:
                curve += 0.5 * nov[r + 12, i0:i1]
        ctx = []
        for p in set(int(x) for x in notes.pitch[idx]):
            r = p - 21
            if 0 <= r < 88:
                ctx.append(nov[r, max(0, i0 - int(fps)): i1 + int(fps)])
        base = np.median(np.concatenate(ctx)) if ctx else 0
        ts = (np.arange(i0, i1) / fps) - t0
        score = curve * np.exp(-0.5 * (ts / sigma) ** 2)
        j = int(np.argmax(score))
        if curve[j] > 3 * base + 0.05:
            dt = ts[j]
            out[idx] = notes.onset[idx] + dt
            moved.append(dt)
    res = NoteArr(out, np.maximum(notes.offset + (out - notes.onset), out + 0.03), notes.pitch, notes.vel, notes.hand)
    return res, np.array(moved)


def onset_residuals(notes: NoteArr, y: np.ndarray, seg: float = 30.0) -> dict:
    """Distance from each aligned chord onset to the nearest librosa-detected audio onset."""
    import librosa

    det = librosa.onset.onset_detect(y=y, sr=SR, hop_length=256, units="time", backtrack=False)
    cl = np.unique(np.round(np.sort(notes.onset), 2))
    # merge cluster times closer than 30 ms
    keep = [cl[0]] if len(cl) else []
    for t in cl[1:]:
        if t - keep[-1] > 0.03:
            keep.append(t)
    cl = np.array(keep)
    j = np.clip(np.searchsorted(det, cl), 1, len(det) - 1)
    d = np.minimum(np.abs(cl - det[j - 1]), np.abs(cl - det[j]))
    segs = []
    for s in np.arange(0, cl.max() + seg if len(cl) else 0, seg):
        m = (cl >= s) & (cl < s + seg)
        if m.sum() >= 5:
            segs.append({"start": float(s), "n": int(m.sum()), "medianMs": round(float(np.median(d[m]) * 1000), 1),
                         "within50": round(float((d[m] <= 0.05).mean()), 3)})
    return {
        "nClusters": int(len(cl)),
        "medianMs": round(float(np.median(d) * 1000), 1),
        "within50": round(float((d <= 0.05).mean()), 3),
        "within100": round(float((d <= 0.1).mean()), 3),
        "segments": segs,
        "suspectSegments": [s["start"] for s in segs if s["medianMs"] > 60 or s["within50"] < 0.4],
    }


def compare_with_truth(est: NoteArr, truth: NoteArr) -> dict:
    import mir_eval

    def iv(n):
        return np.stack([n.onset, np.maximum(n.offset, n.onset + 0.01)], 1)

    out = {}
    for tol in (0.05, 0.1, 0.2):
        p, r, f, _ = mir_eval.transcription.precision_recall_f1_overlap(
            iv(truth), mir_eval.util.midi_to_hz(truth.pitch), iv(est), mir_eval.util.midi_to_hz(est.pitch),
            onset_tolerance=tol, offset_ratio=None)
        out[f"f1@{int(tol*1000)}"] = round(f, 3)
        out[f"p@{int(tol*1000)}"] = round(p, 3)
        out[f"r@{int(tol*1000)}"] = round(r, 3)
    m = mir_eval.transcription.match_notes(iv(truth), mir_eval.util.midi_to_hz(truth.pitch), iv(est),
                                           mir_eval.util.midi_to_hz(est.pitch), onset_tolerance=0.3, offset_ratio=None)
    err = np.array([est.onset[j] - truth.onset[i] for i, j in m])
    out["matched@300"] = len(m)
    out["medianAbsErrMs"] = round(float(np.median(np.abs(err)) * 1000), 1)
    out["p90AbsErrMs"] = round(float(np.percentile(np.abs(err), 90) * 1000), 1)
    out["meanErrMs"] = round(float(err.mean() * 1000), 1)
    return out


def align(score_path: str, audio_path: str, do_refine: bool = True, log=print) -> tuple[NoteArr, NoteArr, dict]:
    score = midi_notes(score_path, pedal_extend=True)
    y = load_audio(audio_path)
    a0, a1 = active_range(y, SR)
    s0 = float(score.onset.min())
    s1 = float(score.offset.max())
    sc = score.shifted(-s0)
    ys = synth(sc, s1 - s0 + 0.5)
    ya = y[int(a0 * SR): int(a1 * SR)]
    log(f"score {len(score)} notes {s1 - s0:.1f}s; audio active {a0:.1f}-{a1:.1f}s")
    # coarse
    hc = 4096
    Fs, Fa = features(ys, hc), features(ya, hc)
    pc = dtw_path(weighted(Fs), weighted(Fa), 1 + W_ONSET)
    # fine
    hf = 512
    Fs2, Fa2 = features(ys, hf), features(ya, hf)
    r = hc // hf
    N, M = Fs2.shape[1], Fa2.shape[1]
    lo = np.full(N, M, np.int64)
    hi = np.zeros(N, np.int64)
    for i, j in pc:
        for di in range(-1, r + 1):
            ii = i * r + di
            if 0 <= ii < N:
                lo[ii] = min(lo[ii], j * r)
                hi[ii] = max(hi[ii], (j + 1) * r)
    rad = int(1.5 * SR / hf)
    lo = np.clip(lo - rad, 0, M - 1)
    hi = np.clip(hi + rad, 1, M)
    lo = np.minimum.accumulate(lo[::-1])[::-1]  # non-decreasing & reachable
    hi = np.maximum.accumulate(hi)
    lo[0] = 0
    hi[-1] = M
    pf = dtw_path(weighted(Fs2), weighted(Fa2), 1 + W_ONSET, lo, hi)
    warp = warp_function(pf, hf / SR)
    on = warp(sc.onset) + a0
    off = np.maximum(warp(sc.offset) + a0, on + 0.03)
    aligned = NoteArr(on, off, sc.pitch, sc.vel, sc.hand)
    info = {"scoreNotes": len(score), "scoreSpan": round(s1 - s0, 2), "audioActive": [round(a0, 2), round(a1, 2)],
            "tempoRatio": round((a1 - a0) / (s1 - s0), 3)}
    final = aligned
    if do_refine:
        final, moved = refine(aligned, sc.onset, y)
        info["refine"] = {"chordsMoved": int(len(moved)), "medianAbsShiftMs": round(float(np.median(np.abs(moved)) * 1000), 1) if len(moved) else 0}
    return aligned, final, info


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("score")
    ap.add_argument("audio")
    ap.add_argument("out")
    ap.add_argument("--no-refine", action="store_true")
    ap.add_argument("--truth", help="exact performance MIDI of the recording (validation)")
    a = ap.parse_args()
    dtw_only, final, info = align(a.score, a.audio, not a.no_refine)
    y = load_audio(a.audio)
    info["residualDTW"] = onset_residuals(dtw_only, y)
    info["residualFinal"] = onset_residuals(final, y)
    if a.truth:
        truth = midi_notes(a.truth, pedal_extend=True)
        info["truthResidual"] = onset_residuals(truth, y)
        info["vsTruthDTW"] = compare_with_truth(dtw_only, truth)
        info["vsTruthFinal"] = compare_with_truth(final, truth)
    info["score"] = os.path.abspath(a.score)
    info["audio"] = os.path.abspath(a.audio)
    save_notes(a.out, final, info)
    save_notes(a.out.replace(".json", ".dtw.json"), dtw_only, info)
    print(json.dumps({k: v for k, v in info.items() if k not in ("residualDTW", "residualFinal", "truthResidual")}, indent=1))
    for k in ("residualDTW", "residualFinal", "truthResidual"):
        if k in info:
            d = info[k]
            print(k, {x: d[x] for x in ("nClusters", "medianMs", "within50", "within100")}, "suspect:", d["suspectSegments"])


if __name__ == "__main__":
    main()
