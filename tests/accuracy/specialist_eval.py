"""
Score the high-accuracy piano model engine (the ByteDance piano model running in the browser,
transcribe.mjs --presets specialist) next to the Basic Pitch presets, on the same recordings.

    server/.venv/bin/python tests/accuracy/specialist_eval.py --work WORK [--trans WORK/specialist]
        [--manifest tests/accuracy/songs.json] [--presets piano,sensitive,specialist] --out OUT AUDIO...

Writes OUT.json and OUT.md. evaluate.py's scoring is not changed; this script adds what matters for
a piano specialist and reuses metrics.note_prf for the onset and onset+offset numbers:

* headline: MAESTRO pieces with exact performance MIDI (noteRef 'exact'), mean over the pieces in
  the MAESTRO TEST split only. The model was trained on the MAESTRO v2.0.0 train split, so 'train'
  pieces (songs.json maestroSplit) are listed but kept out of the mean;
* per run: note F1 onset ±50 ms, onset+offset (offset within max(50 ms, 20 %), reference offsets
  extended by the sustain pedal, the MAESTRO convention the model was trained on), onset+offset+
  velocity (mir_eval.transcription_velocity, tolerance 0.1 after its linear velocity fit), Pearson
  correlation of matched notes' velocities, and the median |onset error| of matched notes;
* parity: the browser specialist against the Python package on the same audio (refs/pti/<id>.pti.json
  from pti_transcribe.py, i.e. the original PyTorch model + post-processor). This checks the port
  (ONNX fp16 weights + TypeScript post-processing), it is not an accuracy number;
* recordings without exact MIDI: 'vs PTI' is CIRCULAR for the specialist (the reference is the same
  model), and the 'snapped' score references carry that model's timing, so they are circular too.
  Those rows are reported as parity, never as accuracy. Basic Pitch's vs-PTI numbers stay a proxy;
* speed and memory of each run (transcribe.mjs records them): wall time, seconds per audio minute,
  model-load and analysis stages, WASM threads, peak tab RSS.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from acclib import NoteArr, load_notes, midi_notes, midi_to_hz  # noqa: E402
from metrics import _iv, matched_pairs, note_prf  # noqa: E402


def as_heard(est: NoteArr, pedal: list[dict]) -> NoteArr:
    """music/noteLength.ts asHeard: a key let go while the pedal is down sounds until the pedal comes up, or
    until the same key is struck again."""
    off = est.offset.copy()
    for i, up in enumerate(est.offset):
        for p in pedal:
            if p["start"] <= up < p["end"]:
                off[i] = p["end"]
                break
    order = np.lexsort((est.onset, est.pitch))
    for a, b in zip(order[:-1], order[1:]):
        if est.pitch[a] == est.pitch[b] and off[a] > est.onset[b]:
            off[a] = max(est.offset[a], min(off[a], est.onset[b]))
    return NoteArr(est.onset, off, est.pitch, est.vel, est.hand)


def velocity_prf(ref: NoteArr, est: NoteArr, offsets: bool) -> dict:
    """mir_eval onset(+offset)+velocity note F1 (velocity_tolerance 0.1)."""
    from mir_eval import transcription_velocity as tv

    if not len(ref) or not len(est):
        return {"p": 0.0, "r": 0.0, "f1": 0.0}
    p, r, f, _ = tv.precision_recall_f1_overlap(
        _iv(ref), midi_to_hz(ref.pitch), ref.vel, _iv(est), midi_to_hz(est.pitch), est.vel,
        onset_tolerance=0.05, offset_ratio=0.2 if offsets else None, offset_min_tolerance=0.05, velocity_tolerance=0.1)
    return {"p": round(p, 4), "r": round(r, 4), "f1": round(f, 4)}


def matched_stats(ref: NoteArr, est: NoteArr) -> dict:
    """Onset error and velocity agreement of the notes matched at ±50 ms (pitch exact)."""
    pairs = matched_pairs(ref, est, 0.05)
    if not len(pairs):
        return {"matched": 0}
    ri = np.array([a for a, _ in pairs])
    ei = np.array([b for _, b in pairs])
    err = np.abs(est.onset[ei] - ref.onset[ri])
    rv, ev = ref.vel[ri], est.vel[ei]
    corr = float(np.corrcoef(rv, ev)[0, 1]) if len(pairs) > 2 and rv.std() > 0 and ev.std() > 0 else None
    return {
        "matched": int(len(pairs)),
        "onsetErrMedianMs": round(float(np.median(err)) * 1000, 2),
        "velocityPearson": None if corr is None else round(corr, 4),
    }


def suite(ref: NoteArr, est: NoteArr) -> dict:
    return {
        "onset50": note_prf(ref, est, 0.05),
        "onsetOffset50": note_prf(ref, est, 0.05, offsets=True),
        "onsetVelocity": velocity_prf(ref, est, offsets=False),
        "onsetOffsetVelocity": velocity_prf(ref, est, offsets=True),
        **matched_stats(ref, est),
    }


def parity(py: NoteArr, br: NoteArr) -> dict:
    """Browser specialist vs the Python package on the same audio (same model: should be ~1)."""
    out = {"onset50": note_prf(py, br, 0.05), "onsetOffset50": note_prf(py, br, 0.05, offsets=True),
           "nPython": len(py), "nBrowser": len(br)}
    pairs = matched_pairs(py, br, 0.05)
    if len(pairs):
        pi = np.array([a for a, _ in pairs])
        bi = np.array([b for _, b in pairs])
        out["onsetDiffMedianMs"] = round(float(np.median(np.abs(br.onset[bi] - py.onset[pi]))) * 1000, 2)
        out["offsetDiffMedianMs"] = round(float(np.median(np.abs(br.offset[bi] - py.offset[pi]))) * 1000, 2)
        # app velocity is 0..1 (MIDI velocity / 128 in the port, / 127 in pti_transcribe.py): compare in MIDI units
        out["velocityDiffMeanMidi"] = round(float(np.mean(np.abs(br.vel[bi] * 128 - py.vel[pi] * 127))), 2)
    return out


def run_info(tr: dict) -> dict:
    stages = tr.get("timing", {}).get("stagesMs", {})
    dur = tr["duration"]
    t = tr["timing"]["transcribeMs"] / 1000
    mem = tr.get("memory") or {}
    return {
        "transcribeSec": round(t, 1),
        "secPerAudioMin": round(t / dur * 60, 1),
        "loadingModelSec": round(stages.get("loading-model", 0) / 1000, 1),
        "analyzingSec": round(stages.get("analyzing", 0) / 1000, 1),
        "backend": tr["info"].get("backend"),
        "coi": tr.get("coi"),
        "peakTabRssMB": mem.get("peakProcRssMB"),
        "peakTreePssMB": mem.get("peakTreePssMB"),
        "loadavg": tr.get("host", {}).get("loadavg1Before"),
    }


def mean(xs):
    xs = [x for x in xs if x is not None]
    return round(float(np.mean(xs)), 4) if xs else None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--trans")
    ap.add_argument("--manifest", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "songs.json"))
    ap.add_argument("--presets", default="piano,sensitive,specialist")
    ap.add_argument("--out", required=True)
    ap.add_argument("audio", nargs="+")
    a = ap.parse_args()
    trans = a.trans or os.path.join(a.work, "specialist")
    presets = a.presets.split(",")
    songs = json.load(open(a.manifest))["songs"]
    rows = []
    for audio in a.audio:
        sid = os.path.splitext(os.path.basename(audio))[0]
        cfg = songs.get(sid)
        if cfg is None:
            print("not in manifest:", sid)
            continue
        res = {"song": sid, "kind": cfg["kind"], "noteRef": cfg.get("noteRef"), "maestroSplit": cfg.get("maestroSplit"), "runs": {}}
        exact = midi_notes(os.path.splitext(audio)[0] + ".midi", pedal_extend=True) if cfg.get("noteRef") == "exact" else None
        p = os.path.join(a.work, "refs", "pti", f"{sid}.pti.json")
        pti = load_notes(p)[0] if os.path.exists(p) else None
        if exact is not None:
            res["nRef"] = len(exact)
            if pti is not None:
                res["runs"]["pti-python"] = {"vsExact": suite(exact, pti), "note": "original PyTorch model (pti_transcribe.py)"}
        for pr in presets:
            f = os.path.join(trans, f"{sid}.{pr}.json")
            if not os.path.exists(f):
                print(f"  missing {f}")
                continue
            tr = json.load(open(f))
            est = NoteArr.from_list(tr["base"])
            if tr.get("pedal"):
                # the specialist's notes are "as played" with the pedal heard in the recording (music/noteLength.ts,
                # since 2026-11-14): score them as heard, the pedal-extended convention the model and the references use
                est = as_heard(est, tr["pedal"])
            r = {"nNotes": len(est), **run_info(tr)}
            if exact is not None:
                r["vsExact"] = suite(exact, est)
            if pti is not None:
                if pr == "specialist":
                    r["parityWithPython"] = parity(pti, est)
                else:
                    r["vsPTI_proxy"] = note_prf(pti, est, 0.05)
            res["runs"][pr] = r
        rows.append(res)
        print("scored", sid, flush=True)

    # ---- summary: MAESTRO test-split mean (headline), train-split pieces separately
    summary = {}
    # the same pieces for every engine: the test-split pieces every requested preset ran on
    test = [s for s in rows if s["noteRef"] == "exact" and s.get("maestroSplit") == "test" and all(pr in s["runs"] for pr in presets)]
    summary["_pieces"] = [s["song"] for s in test]
    for pr in ["pti-python", *presets]:
        got = [s["runs"][pr]["vsExact"] for s in test if pr in s["runs"] and "vsExact" in s["runs"][pr]]
        if not got:
            continue
        summary[pr] = {
            "n": len(got),
            "onset50F1": mean([g["onset50"]["f1"] for g in got]),
            "onset50P": mean([g["onset50"]["p"] for g in got]),
            "onset50R": mean([g["onset50"]["r"] for g in got]),
            "onsetOffset50F1": mean([g["onsetOffset50"]["f1"] for g in got]),
            "onsetOffsetVelocityF1": mean([g["onsetOffsetVelocity"]["f1"] for g in got]),
            "velocityPearson": mean([g.get("velocityPearson") for g in got]),
            "onsetErrMedianMs": mean([g.get("onsetErrMedianMs") for g in got]),
        }
        runs = [s["runs"][pr] for s in test if pr in s["runs"] and "secPerAudioMin" in s["runs"][pr]]
        if runs:
            summary[pr]["secPerAudioMin"] = mean([r["secPerAudioMin"] for r in runs])
            summary[pr]["peakTabRssMBMax"] = max((r["peakTabRssMB"] or 0) for r in runs)
    par = [s["runs"]["specialist"]["parityWithPython"] for s in rows if "parityWithPython" in s["runs"].get("specialist", {})]
    if par:
        summary["parity"] = {"n": len(par), "onset50F1Mean": mean([x["onset50"]["f1"] for x in par]),
                             "onset50F1Min": min(x["onset50"]["f1"] for x in par),
                             "onsetOffset50F1Mean": mean([x["onsetOffset50"]["f1"] for x in par])}
    out = {"generated": time.strftime("%Y-%m-%d %H:%M"), "summaryMaestroTest": summary, "songs": rows}
    with open(a.out + ".json", "w") as fh:
        json.dump(out, fh, indent=1)
    with open(a.out + ".md", "w") as fh:
        fh.write(report(out, presets))
    print("wrote", a.out + ".json", a.out + ".md")


def fmt(x, nd=3):
    if x is None:
        return "–"
    return f"{x:.{nd}f}" if isinstance(x, float) else str(x)


def table(headers, rows):
    out = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    return "\n".join(out + ["| " + " | ".join(fmt(c) for c in r) + " |" for r in rows]) + "\n"


def report(o: dict, presets: list[str]) -> str:
    md = [f"# Piano specialist vs Basic Pitch\n\nGenerated {o['generated']} by `tests/accuracy/specialist_eval.py`.\n"]
    S = o["summaryMaestroTest"]
    md.append("## Headline: MAESTRO test-split pieces with exact MIDI (mean)\n\n"
              "F1 = mir_eval note F1, pitch exact, onset ±50 ms; `on+off` also needs the offset within max(50 ms, 20 %) "
              "of the pedal-extended reference; `on+off+vel` also needs the velocity within 0.1 after mir_eval's linear fit. "
              "`pti-python` = the original PyTorch model on the same audio (what the browser port should reproduce).\n")
    md.append(table(["engine", "pieces", "F1@50", "P", "R", "on+off F1", "on+off+vel F1", "vel. r", "median onset err ms", "s per audio min", "peak tab MB"],
                    [[k, v["n"], v["onset50F1"], v["onset50P"], v["onset50R"], v["onsetOffset50F1"], v["onsetOffsetVelocityF1"], v["velocityPearson"],
                      v["onsetErrMedianMs"], v.get("secPerAudioMin"), v.get("peakTabRssMBMax")] for k, v in S.items() if not k.startswith("_") and k != "parity"]))
    md.append(f"\nPieces (every engine ran on them): {', '.join(S.get('_pieces', [])) or 'none'}.\n")
    rows = []
    for s in o["songs"]:
        if s["noteRef"] != "exact":
            continue
        for k, r in s["runs"].items():
            v = r.get("vsExact")
            if not v:
                continue
            rows.append([s["song"] + (" (TRAIN split)" if s.get("maestroSplit") == "train" else ""), k, v["onset50"]["f1"], v["onsetOffset50"]["f1"],
                         v["onsetOffsetVelocity"]["f1"], v.get("velocityPearson"), r.get("secPerAudioMin"), r.get("backend"), r.get("peakTabRssMB")])
    if rows:
        md.append("\n## Per piece (exact MIDI)\n\nPieces marked TRAIN split were in the specialist's training data: optimistic for it, excluded from the mean.\n")
        md.append(table(["piece", "engine", "F1@50", "on+off F1", "on+off+vel F1", "vel. r", "s per audio min", "backend", "peak tab MB"], rows))
    rows = []
    for s in o["songs"]:
        sp = s["runs"].get("specialist", {})
        if "parityWithPython" in sp:
            p = sp["parityWithPython"]
            rows.append([s["song"], s["noteRef"] or "–", p["onset50"]["f1"], p["onsetOffset50"]["f1"], p.get("onsetDiffMedianMs"), p.get("offsetDiffMedianMs"),
                         p.get("velocityDiffMeanMidi"), p["nPython"], p["nBrowser"]])
    if rows:
        md.append("\n## Parity: browser specialist vs the Python package (same model, same audio)\n\n"
                  "A check of the port (ONNX fp16 weights, onnxruntime-web, TypeScript post-processing), NOT accuracy. "
                  "For the recordings without exact MIDI this is the only specialist number there is: their vs-PTI and "
                  "'snapped' references come from the same model, so they are circular for the specialist.\n")
        md.append(table(["recording", "reference kind", "F1@50", "on+off F1", "median onset diff ms", "median offset diff ms", "mean velocity diff (MIDI units)", "#Python", "#browser"], rows))
    rows = []
    for s in o["songs"]:
        if s["noteRef"] == "exact":
            continue
        for k, r in s["runs"].items():
            if "vsPTI_proxy" in r:
                rows.append([s["song"], k, r["vsPTI_proxy"]["f1"], r.get("secPerAudioMin"), r.get("backend")])
            elif k == "specialist":
                rows.append([s["song"], k, "circular (see parity)", r.get("secPerAudioMin"), r.get("backend")])
    if rows:
        md.append("\n## Other solo-piano recordings: Basic Pitch vs the specialist model's notes (a proxy, not truth)\n\n")
        md.append(table(["recording", "engine", "F1@50 vs PTI", "s per audio min", "backend"], rows))
    return "\n".join(md)


if __name__ == "__main__":
    main()
