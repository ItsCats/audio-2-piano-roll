"""
CREPE-tiny trial: parity with torchcrepe, independent pYIN references, and melody-line scoring.

    PY=server/.venv/bin/python
    # 1. the TypeScript port reproduces torchcrepe (same stem, frame by frame)
    $PY tests/accuracy/crepe_eval.py parity STEM.wav OUT/<id>.crepe.json [--seconds 60]
    # 2. pYIN references (cached .npz; librosa pYIN, fmin 65, fmax 1100, 16 kHz, hop 10 ms)
    $PY tests/accuracy/crepe_eval.py pyin OUTDIR id=STEM.wav ...
    # 3. score lines of crepe_track.mjs outputs against every reference
    $PY tests/accuracy/crepe_eval.py score --tracks DIR --work WORK --pyin-demucs DIR --pyin-scnet DIR [--json OUT] ids...

References (all 10 ms frames from t = 0):
  crepeRef   WORK/refs/vocal/<id>.vocals.f0.npz: torchcrepe-tiny + Viterbi on the DEMUCS stem
             (vocal_ref.py). NOT independent of CREPE on our SCNet stem: same network, same decoder,
             same voicing rule - a CREPE estimate is expected to score high against it.
  pyinDemucs librosa pYIN on the Demucs stem: independent tracker AND independent separator.
  pyinScnet  librosa pYIN on the SCNet stem the app uses: independent tracker, same stem
             (separation errors are shared by every estimate, so it isolates the tracker).
  agree      crepeRef restricted to frames where pyinDemucs agrees with it (both unvoiced, or both
             voiced within 50 cents): the frames two different trackers agree on.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from acclib import NoteArr, load_audio  # noqa: E402
from metrics import line_f0, melody_metrics, note_prf  # noqa: E402
from vocal_ref import segment as ref_segment  # noqa: E402

HOP = 0.01


def f32(s: str) -> np.ndarray:
    return np.frombuffer(base64.b64decode(s), dtype=np.float32)


def cents(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    return 1200 * np.abs(np.log2(np.maximum(a, 1e-6) / np.maximum(b, 1e-6)))


# ----------------------------------------------------------------------------- parity

def parity(a) -> None:
    import torch
    import torchcrepe

    torch.set_num_threads(2)
    d = json.load(open(a.json))["crepe"]
    raw, per = f32(d["rawF0"]), f32(d["periodicity"])
    y = load_audio(a.wav, 16000)
    if a.seconds:
        y = y[: int(a.seconds * 16000)]
    with torch.no_grad():
        f0, p = torchcrepe.predict(torch.from_numpy(y)[None], 16000, 160, 65, 1100, "tiny", batch_size=512, device="cpu",
                                   decoder=torchcrepe.decode.viterbi, return_periodicity=True)
    f0, p = f0[0].numpy(), p[0].numpy()
    n = min(len(f0), len(raw))
    f0, p, raw, per = f0[:n], p[:n], raw[:n], per[:n]
    ana = raw > 0  # frames the TS port analysed (the rest were too quiet)
    strong = ana & (p >= 0.5)
    c = cents(raw[strong], f0[strong])
    out = {
        "frames": int(n), "analysedFraction": round(float(ana.mean()), 4),
        "torchcrepeVoicedFrames(per>=0.5)": int(strong.sum()),
        "within50cents": round(float((c < 50).mean()), 4), "within20cents": round(float((c < 20).mean()), 4),
        "medianCents": round(float(np.median(c)), 2),
        "periodicityCorr": round(float(np.corrcoef(per[ana], p[ana])[0, 1]), 4),
        "periodicityMeanAbsDiff": round(float(np.abs(per[ana] - p[ana]).mean()), 4),
        "voicedAgreement(per>=0.5, analysed frames)": round(float(((per[ana] >= 0.5) == (p[ana] >= 0.5)).mean()), 4),
        "skippedFramesTorchcrepeVoiced": int(((~ana) & (p >= 0.5)).sum()),
    }
    print(json.dumps(out, indent=1))


# ----------------------------------------------------------------------------- pYIN

def pyin(a) -> None:
    import librosa

    os.makedirs(a.out, exist_ok=True)
    for spec in a.items:
        sid, path = spec.split("=", 1)
        dst = os.path.join(a.out, f"{sid}.pyin.npz")
        if os.path.exists(dst):
            print("cached", dst)
            continue
        y = load_audio(path, 16000)
        f0, vflag, vprob = librosa.pyin(y, fmin=65, fmax=1100, sr=16000, frame_length=1024, hop_length=160, center=True)
        f0 = np.where(vflag, np.nan_to_num(f0), 0.0)
        t = np.arange(len(f0)) * HOP
        np.savez_compressed(dst, times=t, f0=f0, vprob=vprob)
        print(sid, "voiced", round(float((f0 > 0).mean()), 3), flush=True)


# ----------------------------------------------------------------------------- scoring

def notes(lst) -> NoteArr:
    return NoteArr.from_list([{**n, "hand": n.get("hand", "R")} for n in lst]) if lst else NoteArr.empty()


def load_ref_notes(p: str) -> NoteArr:
    from acclib import load_notes
    return load_notes(p)[0]


def score(a) -> None:
    res = {}
    for sid in a.ids:
        tr = json.load(open(os.path.join(a.tracks, f"{sid}.crepe.json")))
        cr = np.load(os.path.join(a.work, "refs", "vocal", f"{sid}.vocals.f0.npz"))
        refs = {"crepeRef": (cr["times"], cr["f0"])}
        for key, d in (("pyinDemucs", a.pyin_demucs), ("pyinScnet", a.pyin_scnet)):
            p = os.path.join(d, f"{sid}.pyin.npz") if d else ""
            if p and os.path.exists(p):
                z = np.load(p)
                refs[key] = (z["times"], z["f0"])
        if "pyinDemucs" in refs:
            t, f = refs["crepeRef"]
            g = refs["pyinDemucs"][1]
            n = min(len(f), len(g))
            ok = ((f[:n] > 0) & (g[:n] > 0) & (cents(f[:n], g[:n]) < 50)) | ((f[:n] <= 0) & (g[:n] <= 0))
            refs["agree"] = (t[:n][ok], f[:n][ok])
            res.setdefault(sid, {})["agreeFraction"] = round(float(ok.mean()), 4)
        est = {}
        if "bp" in tr:
            est["bpLine"] = ("notes", notes(tr["bp"]["line"]))
        if "crepe" in tr:
            c = tr["crepe"]
            est["crepeLine"] = ("notes", notes(c["line"]))
            est["crepeNotes"] = ("notes", notes(c["notes"]))
            est["crepeF0"] = ("f0", f32(c["f0"]).astype(np.float64), float(c.get("hop", HOP)))
        for k, v in tr.get("extra", {}).items():
            est[k] = ("notes", notes(v))
        r = res.setdefault(sid, {})
        # how much the references themselves agree (the ceiling any estimate can show against them)
        base = refs["crepeRef"]
        for rk in ("pyinDemucs", "pyinScnet"):
            if rk in refs:
                t, f = refs[rk]
                n = min(len(f), len(base[1]))
                r.setdefault("refVsRef", {})[f"crepeRef_vs_{rk}"] = melody_metrics(t[:n], f[:n], base[1][:n])
        if "pyinDemucs" in refs and "pyinScnet" in refs:
            n = min(len(refs["pyinDemucs"][1]), len(refs["pyinScnet"][1]))
            r["refVsRef"]["pyinScnet_vs_pyinDemucs"] = melody_metrics(refs["pyinDemucs"][0][:n], refs["pyinDemucs"][1][:n], refs["pyinScnet"][1][:n])
        # note-level: onsets (100 ms, pitch class) vs the reference notes (vocal_ref.py segmentation
        # of the CREPE reference, and the same segmentation of pYIN on the Demucs stem)
        nrefs = {"crepeRefNotes": load_ref_notes(os.path.join(a.work, "refs", "vocal", f"{sid}.vocals.notes.json"))}
        if "pyinDemucs" in refs:
            nrefs["pyinDemucsNotes"] = ref_segment(*refs["pyinDemucs"])
        for nk, rn in nrefs.items():
            for ek, (kind, e, *_) in est.items():
                if kind == "notes":
                    r.setdefault("notes", {}).setdefault(nk, {})[ek] = note_prf(rn, e, 0.1, pitch_class=True)
        for rk, (t, f) in refs.items():
            r[rk] = {"voicedFraction": round(float((f > 0).mean()), 4)}
            for ek, (kind, e, *hop) in est.items():
                if kind == "notes":
                    ef = line_f0(e, t, None)
                else:
                    fi = np.round(t / hop[0]).astype(int)
                    ef = np.where(fi < len(e), e[np.clip(fi, 0, len(e) - 1)], 0.0)
                m = melody_metrics(t, f, ef)
                both = (f > 0) & (ef > 0)
                # pitch accuracy where reference and estimate are both voiced (pitch alone, no voicing)
                m["pitchGivenBothVoiced"] = round(float((cents(f[both], ef[both]) < 50).mean()), 4) if both.any() else 0.0
                r[rk][ek] = m
        # timing
        if "crepe" in tr:
            c = tr["crepe"]
            r["speed"] = {"crepeSecPerMin": round(c["ms"] / 1000 * 60 / c["duration"], 2), "crepeRssDeltaMb": c.get("rss", {}).get("deltaMb"),
                          "analysed": c["stats"]["inferred"] / c["stats"]["frames"]}
        if "bp" in tr:
            r.setdefault("speed", {})["bpSecPerMin"] = round(tr["bp"]["ms"] / 1000 * 60 / tr["bp"]["duration"], 2)
            r["speed"]["bpRssDeltaMb"] = tr["bp"].get("rss", {}).get("deltaMb")
    # means
    mean = {}
    for rk in ("crepeRef", "pyinDemucs", "pyinScnet", "agree"):
        for ek in sorted({k for s in res.values() if rk in s for k in s[rk] if k != "voicedFraction"}):
            vals = [s[rk][ek] for s in res.values() if rk in s and ek in s[rk]]
            if len(vals) == len(a.ids):
                mean.setdefault(rk, {})[ek] = {m: round(float(np.mean([v[m] for v in vals])), 4) for m in vals[0]}
    for nk in ("crepeRefNotes", "pyinDemucsNotes"):
        for ek in sorted({k for s in res.values() for k in s.get("notes", {}).get(nk, {})}):
            vals = [s["notes"][nk][ek] for s in res.values() if ek in s.get("notes", {}).get(nk, {})]
            if len(vals) == len(a.ids):
                mean.setdefault("notes:" + nk, {})[ek] = {m: round(float(np.mean([v[m] for v in vals])), 4) for m in ("p", "r", "f1")}
    rr = [s["refVsRef"] for s in res.values() if "refVsRef" in s]
    if rr:
        mean["refVsRef"] = {k: {m: round(float(np.mean([x[k][m] for x in rr if k in x])), 4) for m in rr[0][k]} for k in rr[0]}
    res["MEAN"] = mean
    f = lambda m: (f"{m['rawPitch']:.3f}/{m['rawChroma']:.3f}/{m['overall']:.3f} VR {m['voicingRecall']:.2f} VFA {m['voicingFalseAlarm']:.2f}"
                   + (f" P|V {m['pitchGivenBothVoiced']:.3f}" if "pitchGivenBothVoiced" in m else ""))
    show = set(a.show.split(",")) if a.show else None
    for rk, ests in mean.items():
        if rk.startswith("notes:"):
            print(f"== {rk}: note onsets within 100 ms, pitch class (p / r / F1)")
            for ek, m in ests.items():
                if not show or ek in show:
                    print(f"  {ek:18s} {m['p']:.3f} / {m['r']:.3f} / {m['f1']:.3f}")
            continue
        print(f"== vs {rk}: RPA/RCA/OA, voicing recall / false alarm, P|V = pitch accuracy where both are voiced")
        for ek, m in ests.items():
            if show and rk != "refVsRef" and ek not in show:
                continue
            per = "" if rk == "refVsRef" else "   RPA per song " + " ".join(f"{res[s][rk][ek]['rawPitch']:.3f}" for s in a.ids)
            print(f"  {ek:18s} {f(m)}{per}")
    if a.json:
        json.dump(res, open(a.json, "w"), indent=1)


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("parity")
    p.add_argument("wav")
    p.add_argument("json")
    p.add_argument("--seconds", type=float, default=0)
    p = sub.add_parser("pyin")
    p.add_argument("out")
    p.add_argument("items", nargs="+")
    p = sub.add_parser("score")
    p.add_argument("--tracks", required=True)
    p.add_argument("--work", required=True)
    p.add_argument("--pyin-demucs")
    p.add_argument("--pyin-scnet")
    p.add_argument("--json")
    p.add_argument("--show", help="comma-separated estimates to print (all by default)")
    p.add_argument("ids", nargs="+")
    a = ap.parse_args()
    {"parity": parity, "pyin": pyin, "score": score}[a.cmd](a)


if __name__ == "__main__":
    main()
