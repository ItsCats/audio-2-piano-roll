"""Melody / bass line evaluation of vocal-song arrangements against the pitch-tracked stem references.

    melody_eval.py --work WORK [--out OUT.json] [--label NAME] RUN.json ...

RUN.json: an app run or a melody_regen.mjs output (base / easy / medium / hard notes; song id = the
file name up to the first '.'). References from WORK/refs/vocal/<id>.{vocals,bass}.f0.npz and
<id>.vocals.notes.json (vocal_ref.py).

Per song and mean:
  Easy RH / Medium RH / melody line (role 'melody' notes of the base) / ceiling (the reference's
  own note segmentation) vs the vocal f0: RPA (raw pitch), RCA (raw chroma: octave-tolerant;
  the score for Easy/Medium, whose melody is moved into the right-hand register), OA (overall);
  Easy LH vs the bass f0: RCA of the lowest left-hand note (bottom line).
Also: register of the Easy / Medium RH melody (duration-weighted median MIDI), the fraction of RH
melody time sounding < 5 semitones above the left hand's top note, and `sungRPA/RCA`: RPA/RCA on
reference frames whose CREPE periodicity is stable (median filtered >= 0.7), i.e. clearly sung.
"""
import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from acclib import NoteArr, load_notes  # noqa: E402
from metrics import line_f0, melody_metrics  # noqa: E402

KEYS = ("rawPitch", "rawChroma", "overall")


def ref(work: str, sid: str, stem: str):
    p = f"{work}/refs/vocal/{sid}.{stem}.f0.npz"
    if not os.path.exists(p):
        return None
    d = np.load(p)
    return d["times"], d["f0"], d["periodicity"] if "periodicity" in d.files else None


def notes_of(d: dict, key: str) -> NoteArr:
    return NoteArr.from_list(d.get(key) or [])


def weighted_median(pitch: np.ndarray, dur: np.ndarray) -> float | None:
    if not len(pitch):
        return None
    o = np.argsort(pitch)
    c = np.cumsum(dur[o])
    return float(pitch[o][np.searchsorted(c, c[-1] / 2)])


def clearance(arr: list[dict], times: np.ndarray) -> float | None:
    """Fraction of frames with a sounding RH note where the RH top note is < 5 st above the LH top note."""
    rh = NoteArr.from_list([n for n in arr if n.get("hand") == "R"])
    lh = NoteArr.from_list([n for n in arr if n.get("hand") == "L"])
    r = line_f0(rh, times, None)
    l_ = line_f0(lh, times, None)
    both = (r > 0) & (l_ > 0)
    if not (r > 0).any():
        return None
    gap = 12 * np.log2(np.where(both, r, 1) / np.where(both, l_, 1))
    return float(((gap < 4.5) & both).sum() / (r > 0).sum())


def stable_mask(f0: np.ndarray, per: np.ndarray | None) -> np.ndarray:
    v = f0 > 0
    if per is None:
        return v
    k = 7
    pad = np.pad(per, k // 2, mode="edge")
    med = np.median(np.lib.stride_tricks.sliding_window_view(pad, k), axis=1)
    return v & (med >= 0.7)


def masked(times, f0, est, mask):
    f = np.where(mask, f0, 0.0)
    return melody_metrics(times, f, est)


def overall_chroma(f0: np.ndarray, est: np.ndarray) -> float:
    """Overall accuracy with octave errors forgiven: unvoiced frames correct when the estimate is
    silent, voiced frames correct when the estimate is within 50 cents of the reference modulo 12."""
    rv, ev = f0 > 0, est > 0
    ok = ~rv & ~ev
    both = rv & ev
    c = 1200 * np.log2(np.where(both, est, 1) / np.where(both, f0, 1))
    ok |= both & (np.abs((c + 600) % 1200 - 600) <= 50)
    return float(ok.mean())


def in_sections(times: np.ndarray, sections) -> np.ndarray:
    m = np.zeros(len(times), bool)
    for a, b in sections or []:
        m |= (times >= a) & (times < b)
    return m


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--out")
    ap.add_argument("--label", default="")
    ap.add_argument("runs", nargs="+")
    a = ap.parse_args()
    rows = {}
    for f in a.runs:
        sid = os.path.basename(f).split(".")[0]
        v = ref(a.work, sid, "vocals")
        if not v:
            continue
        d = json.load(open(f))
        t, f0, per = v
        r: dict = {}
        ests = {
            "easy": line_f0(notes_of(d, "easy"), t, "R"),
            "medium": line_f0(notes_of(d, "medium"), t, "R"),
            "line": line_f0(NoteArr.from_list([n for n in d["base"] if n.get("role") == "melody"]), t, None),
            "ceiling": line_f0(load_notes(f"{a.work}/refs/vocal/{sid}.vocals.notes.json")[0], t, None),
        }
        sung = stable_mask(f0, per)
        for k, est in ests.items():
            m = melody_metrics(t, f0, est)
            s = masked(t, f0, est, sung)
            r[k] = {**{x: m[x] for x in KEYS}, "overallChroma": round(overall_chroma(f0, est), 4), "voicingRecall": m["voicingRecall"],
                    "voicingFalseAlarm": m["voicingFalseAlarm"], "sungRPA": s["rawPitch"], "sungRCA": s["rawChroma"]}
        for k in ("easy", "medium"):
            rh = [n for n in d[k] if n.get("hand") == "R"]
            na = NoteArr.from_list(rh)
            r[k]["medianMidi"] = weighted_median(na.pitch, na.offset - na.onset)
            r[k]["closeToLH"] = clearance(d[k], t)
        b = ref(a.work, sid, "bass")
        if b:
            bt, bf, _ = b
            r["easyBassRCA"] = melody_metrics(bt, bf, line_f0(notes_of(d, "easy"), bt, "L", mode="bottom"))["rawChroma"]
        r["sungFrameShare"] = float(sung.sum() / max(1, (f0 > 0).sum()))
        sp = in_sections(t, d.get("speech"))
        r["speech"] = {"sections": len(d.get("speech") or []), "seconds": round(float(sum(b - a for a, b in d.get("speech") or [])), 1),
                       "sungFramesInSpeech": round(float((sp & sung).sum() / max(1, sung.sum())), 4),
                       "voicedFramesInSpeech": round(float((sp & (f0 > 0)).sum() / max(1, (f0 > 0).sum())), 4),
                       "unstableFramesInSpeech": round(float((sp & (f0 > 0) & ~sung).sum() / max(1, ((f0 > 0) & ~sung).sum())), 4)}
        rows[sid] = r
    if not rows:
        print("no runs with references", file=sys.stderr)
        sys.exit(1)
    mean = {}
    for k in ("easy", "medium", "line", "ceiling"):
        mean[k] = {m: float(np.mean([r[k][m] for r in rows.values()])) for m in (*KEYS, "overallChroma", "sungRPA", "sungRCA")}
    mean["easyBassRCA"] = float(np.mean([r["easyBassRCA"] for r in rows.values() if "easyBassRCA" in r]))
    f4 = lambda m: f"{m['rawPitch']:.3f}/{m['rawChroma']:.3f}/{m['overall']:.3f}/{m['overallChroma']:.3f}"  # noqa: E731
    sg = lambda m: f"{m['sungRPA']:.3f}/{m['sungRCA']:.3f}"  # noqa: E731
    print(f"{a.label}  RPA/RCA/OA/OA-chroma vs vocal reference; sung = RPA/RCA on stable-periodicity frames; "
          "reg = RH median MIDI; close = RH time < 5 st above LH; speech = s removed (share of sung frames in it)")
    print(f"{'song':19s} {'Easy RH':24s} {'Medium RH':24s} {'melody line':24s} {'ceiling':24s} {'sung E':12s} {'sung line':12s} "
          f"{'reg E/M':8s} {'close':6s} {'E bass':6s} speech")
    for sid, r in rows.items():
        reg = f"{r['easy']['medianMidi'] or 0:.0f}/{r['medium']['medianMidi'] or 0:.0f}"
        sp = r["speech"]
        print(f"{sid:19s} {f4(r['easy']):24s} {f4(r['medium']):24s} {f4(r['line']):24s} {f4(r['ceiling']):24s} {sg(r['easy']):12s} {sg(r['line']):12s} "
              f"{reg:8s} {r['easy']['closeToLH'] or 0:.3f}  {r.get('easyBassRCA', float('nan')):.3f}  {sp['seconds']:.0f}s ({sp['sungFramesInSpeech']:.3f})")
    print(f"{'MEAN':19s} {f4(mean['easy']):24s} {f4(mean['medium']):24s} {f4(mean['line']):24s} {f4(mean['ceiling']):24s} {sg(mean['easy']):12s} {sg(mean['line']):12s} "
          f"{'':8s} {'':6s} {mean['easyBassRCA']:.3f}")
    if a.out:
        json.dump({"label": a.label, "rows": rows, "mean": mean}, open(a.out, "w"), indent=1)


if __name__ == "__main__":
    main()
