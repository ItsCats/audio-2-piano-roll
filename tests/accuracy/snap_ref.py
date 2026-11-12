"""
Score-informed reference: snap score-aligned notes (align_score.py output) to the onsets of a
strong piano transcriber run on the same recording (pti_transcribe.py output).

    server/.venv/bin/python tests/accuracy/snap_ref.py ALIGNED.json PTI.json OUT.json [--truth PERF.midi]

  1. Confident pairs (same pitch, |dt| < 100 ms, one-to-one, nearest first) estimate the residual
     DTW offset as a running median over +-3 s; all aligned notes are corrected by it.
  2. Second one-to-one same-pitch matching within 120 ms: matched score notes take the
     transcriber's onset/offset ("verified"); unmatched score notes keep the corrected time.
The note CONTENT comes from the score (what should be played), the TIMING from the recording.
Unverified notes (score notes the transcriber could not confirm: ornaments played differently,
very soft notes, alignment failures) are listed in meta.unverified so metrics can be reported on
the verified subset too.
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from acclib import NoteArr, load_notes, midi_notes, save_notes  # noqa: E402


def match(a: NoteArr, b: NoteArr, tol: float) -> list[tuple[int, int, float]]:
    pairs = []
    for p in np.unique(a.pitch):
        ia = np.where(a.pitch == p)[0]
        ib = np.where(b.pitch == p)[0]
        if not len(ib):
            continue
        tb = b.onset[ib]
        for i in ia:
            d = tb - a.onset[i]
            for k in np.where(np.abs(d) <= tol)[0]:
                pairs.append((abs(d[k]), i, ib[k], d[k]))
    pairs.sort()
    ua, ub, out = set(), set(), []
    for _, i, j, d in pairs:
        if i in ua or j in ub:
            continue
        ua.add(i)
        ub.add(j)
        out.append((i, j, d))
    return out


def snap(aligned: NoteArr, pti: NoteArr, tol1: float = 0.1, tol2: float = 0.12, win: float = 3.0):
    m1 = match(aligned, pti, tol1)
    if m1:
        t = np.array([aligned.onset[i] for i, _, _ in m1])
        d = np.array([x for _, _, x in m1])
        o = np.argsort(t)
        t, d = t[o], d[o]
        corr = np.zeros(len(aligned))
        for k, x in enumerate(aligned.onset):
            lo, hi = np.searchsorted(t, x - win), np.searchsorted(t, x + win)
            corr[k] = np.median(d[lo:hi]) if hi - lo >= 3 else 0
    else:
        corr = np.zeros(len(aligned))
    base = NoteArr(aligned.onset + corr, aligned.offset + corr, aligned.pitch, aligned.vel, aligned.hand)
    m2 = match(base, pti, tol2)
    on, off = base.onset.copy(), base.offset.copy()
    verified = np.zeros(len(base), bool)
    for i, j, _ in m2:
        on[i], off[i] = pti.onset[j], max(pti.offset[j], pti.onset[j] + 0.03)
        verified[i] = True
    out = NoteArr(on, off, base.pitch, base.vel, base.hand)
    o = np.lexsort((out.pitch, out.onset))
    segs = []
    for s0 in np.arange(0, float(out.onset.max()) + 30, 30.0):
        k = (base.onset >= s0) & (base.onset < s0 + 30)
        if k.sum() >= 10:
            segs.append({"start": float(s0), "n": int(k.sum()), "verified": round(float(verified[k].mean()), 3)})
    return out.select(o), verified[o], {"verifiedFraction": round(float(verified.mean()), 4),
                                         "segments": segs, "weakSegments": [x["start"] for x in segs if x["verified"] < 0.6],
                                         "medianCorrectionMs": round(float(np.median(np.abs(corr)) * 1000), 1),
                                         "ptiNotes": len(pti), "ptiUnmatched": int(len(pti) - len(m2))}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("aligned")
    ap.add_argument("pti")
    ap.add_argument("out")
    ap.add_argument("--truth")
    a = ap.parse_args()
    aligned, meta = load_notes(a.aligned)
    pti, _ = load_notes(a.pti)
    out, verified, info = snap(aligned, pti)
    meta = {**meta, "snap": info, "unverified": [int(i) for i in np.where(~verified)[0]], "pti": os.path.abspath(a.pti)}
    if a.truth:
        from align_score import compare_with_truth

        truth = midi_notes(a.truth, pedal_extend=True)
        meta["vsTruthSnapped"] = compare_with_truth(out, truth)
        meta["vsTruthSnappedVerifiedOnly"] = compare_with_truth(out.select(verified), truth)
        meta["vsTruthPTI"] = compare_with_truth(pti, truth)
        print(json.dumps({k: meta[k] for k in ("snap", "vsTruthSnapped", "vsTruthSnappedVerifiedOnly", "vsTruthPTI")}, indent=1))
    else:
        print(json.dumps(info))
    save_notes(a.out, out, meta)


if __name__ == "__main__":
    main()
