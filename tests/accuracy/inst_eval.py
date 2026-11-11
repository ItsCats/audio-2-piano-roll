"""Instrumental / solo-piano tune-line evaluation of the Easy / Medium right hand.

    inst_eval.py --work WORK [--maestro DIR] [--pti DIR] [--lead ID=LEAD.npz ...] [--out OUT.json] RUN.json ...

RUN.json: an app run, a melody_regen.mjs or an inst_regen.mjs output (base / easy / medium / hard
notes; song id = file name up to the first '.'). The reference "tune" per song, first match wins:

  exact     MAESTRO performance MIDI (DIR/<id>.midi): its top voice (skyline: the highest sounding
            note per 10 ms frame, notes >= G3 and >= 60 ms, no pedal extension) = the answer key
            for the Easy right hand of solo piano;
  pti       a strong piano transcriber's notes (refs/pti/<id>.pti.json, same skyline): near-exact
            for solo piano recordings without a performance MIDI;
  lead      a lead-line proxy for band tracks: pYIN f0 of a separated stem (`other_f0`/`other_v`
            in the npz written by the lead-pYIN script; the piano stem's pYIN is noise and is
            NOT used).

Scores (mir_eval on the reference grid): RPA / RCA (octave-tolerant; Easy moves the line into the
right-hand register) / voicing recall of the RH top line of Easy, Medium and Hard and of the
base transcription's top note (any hand: the ceiling); for `lead` also on the proxy's confident
frames only (voicing probability > 0.5, not among the quietest 30 %). For a song with a sung line
(role 'melody' notes in the base) only frames at least 1 s away from any sung note are scored.

RCA only credits frames where the arrangement sounds, so it rises with voicing recall: holding
the same notes longer (legato) raises it without any better choice of notes. Next to it, per
level, three DURATION-INDEPENDENT measures of which notes are chosen:
  onsetPC   RH top note at each RH onset vs the reference pitch class 40 ms after the onset
            (share of onsets where the reference is voiced; `onsetN` = those onsets);
  bothCA    chroma accuracy on frames where both the reference and the RH line sound;
  legatoRCA RCA after stretching every RH note to the next RH onset (at most 2 s): the same
            note lengths for any version, so a gain here is a gain in note choice.
Summary groups: `exact` (MAESTRO), `pti` (solo piano recordings), `lead-band` (lead proxy, no
sung line: whole song) and `lead-vocal-gaps` (lead proxy, sung songs: instrumental gaps only;
also RH note count in the gaps `gapRH` and back-to-back same-pitch gap repeats `gapRepeats`).

Shape of the Easy RH line: median absolute
interval, % leaps > an octave, % leaps >= a fifth, notes per second; the same for the reference.
With WORK/refs/vocal/<id>.bass.f0.npz: Easy / Medium LH bottom-line RCA vs the bass reference.
With WORK/stems/<id>/drums.wav: drum-suspect low notes per minute (evaluate.py drum_low_notes).
"""
import argparse
import json
import os
import sys

import numpy as np

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from acclib import NoteArr, midi_notes  # noqa: E402
from metrics import line_f0, melody_metrics  # noqa: E402

HOP = 0.01
SKY_MIN_PITCH = 55
SKY_MIN_DUR = 0.06


def skyline_f0(ref: NoteArr, times: np.ndarray) -> np.ndarray:
    keep = (ref.pitch >= SKY_MIN_PITCH) & ((ref.offset - ref.onset) >= SKY_MIN_DUR)
    r = ref.select(keep)
    r = NoteArr(r.onset, r.offset, r.pitch, r.vel, np.array(["R"] * len(r)))
    return line_f0(r, times, "R", mode="top")


def score(times, ref_f0, est_f0) -> dict:
    m = melody_metrics(times, ref_f0, est_f0)
    return {k: m[k] for k in ("rawPitch", "rawChroma", "voicingRecall")}


def legato(notes: list[dict], cap: float = 2.0) -> list[dict]:
    """RH notes, each held to the next RH onset (at most `cap` s, never shortened)."""
    r = sorted((dict(n) for n in notes if n.get("hand") == "R"), key=lambda n: n["start"])
    starts = np.array(sorted({round(n["start"], 3) for n in r}))
    for n in r:
        i = np.searchsorted(starts, round(n["start"], 3) + 0.02, side="right")
        nxt = starts[i] if i < len(starts) else n["start"] + cap
        n["dur"] = min(cap, max(n["dur"], nxt - n["start"] - 0.005))
    return r


def both_chroma(ref: np.ndarray, est: np.ndarray) -> float:
    b = (ref > 0) & (est > 0)
    if not b.any():
        return 0.0
    d = np.round(12 * np.log2(est[b] / ref[b])) % 12
    return float((d == 0).mean())


def onset_pc(notes: list[dict], times: np.ndarray, ref: np.ndarray) -> tuple[float, int]:
    top: dict[float, int] = {}
    for n in notes:
        if n.get("hand") == "R":
            k = round(n["start"], 2)
            top[k] = max(top.get(k, 0), n["midi"])
    ok = tot = 0
    for t, m in top.items():
        i = np.searchsorted(times, t + 0.04)
        if i >= len(ref) or ref[i] <= 0:
            continue
        tot += 1
        ok += int(round(69 + 12 * np.log2(ref[i] / 440) - m) % 12 == 0)
    return (ok / tot if tot else 0.0), tot


def score_level(times, ref, notes: list[dict]) -> dict:
    """score() plus the duration-independent measures (see the module comment)."""
    est = line_f0(NoteArr.from_list(notes), times, "R", mode="top")
    r = score(times, ref, est)
    r["bothCA"] = round(both_chroma(ref, est), 4)
    r["legatoRCA"] = melody_metrics(times, ref, line_f0(NoteArr.from_list(legato(notes)), times, "R", mode="top"))["rawChroma"]
    r["onsetPC"], r["onsetN"] = onset_pc(notes, times, ref)
    r["onsetPC"] = round(r["onsetPC"], 4)
    return r


def shape_of(f0: np.ndarray) -> dict:
    """Note-level shape of a frame-wise line: pitch changes between consecutive voiced segments."""
    midi = np.where(f0 > 0, np.round(69 + 12 * np.log2(np.maximum(f0, 1e-9) / 440)), -1)
    seq = []
    prev = -2
    for m in midi:
        if m != prev and m >= 0:
            seq.append(m)
        prev = m
    seq = np.array(seq)
    if len(seq) < 2:
        return {}
    iv = np.abs(np.diff(seq))
    iv = iv[iv > 0]
    return {"medianAbsStep": float(np.median(iv)), "pctStepGtOctave": round(float((iv > 12).mean() * 100), 2), "pctStepGe7": round(float((iv >= 7).mean() * 100), 2)}


def rh_shape(notes: list[dict], duration: float) -> dict:
    rh = sorted((n for n in notes if n.get("hand") == "R"), key=lambda n: (n["start"], -n["midi"]))
    tops = []
    i = 0
    while i < len(rh):
        j = i
        while j < len(rh) and rh[j]["start"] - rh[i]["start"] < 0.03:
            j += 1
        tops.append(max(x["midi"] for x in rh[i:j]))
        i = j
    if len(tops) < 2:
        return {"n": len(tops)}
    t = np.array(tops)
    iv = np.abs(np.diff(t))
    return {"n": int(len(t)), "medianMidi": float(np.median(t)), "medianAbsInterval": float(np.median(iv)),
            "pctLeapGtOctave": round(float((iv > 12).mean() * 100), 2), "pctLeapGe7": round(float((iv >= 7).mean() * 100), 2),
            "pctRepeat": round(float((iv == 0).mean() * 100), 2), "notesPerSec": round(len(t) / duration, 2)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--maestro")
    ap.add_argument("--pti")
    ap.add_argument("--lead", action="append", default=[], help="ID=LEAD.npz")
    ap.add_argument("--no-drums", action="store_true")
    ap.add_argument("--out")
    ap.add_argument("runs", nargs="+")
    a = ap.parse_args()
    leads = dict(x.split("=", 1) for x in a.lead)
    res = {}
    for run in a.runs:
        sid = os.path.basename(run).split(".")[0]
        d = json.load(open(run))
        dur = float(d["duration"])
        N = {lv: NoteArr.from_list(d.get(lv) or []) for lv in ("base", "easy", "medium", "hard")}
        if a.maestro and os.path.exists(f"{a.maestro}/{sid}.midi"):
            kind = "exact"
            times = np.arange(0, dur, HOP)
            ref = skyline_f0(midi_notes(f"{a.maestro}/{sid}.midi"), times)
        elif a.pti and os.path.exists(f"{a.pti}/{sid}.pti.json"):
            kind = "pti"
            times = np.arange(0, dur, HOP)
            ref = skyline_f0(NoteArr.from_list(json.load(open(f"{a.pti}/{sid}.pti.json"))["notes"]), times)
        elif sid in leads:
            kind = "lead"
            P = np.load(leads[sid])
            times = P["times"]
            ref = np.where(P["other_v"], P["other_f0"], 0.0)
            # confident frames only: pYIN voicing probability > 0.5 and not among the quietest 30 %
            rms = P["other_rms"]
            conf_ref = np.where((ref > 0) & (np.nan_to_num(P["other_p"]) > 0.5) & (rms > np.percentile(rms[ref > 0], 30)), ref, 0.0)
        else:
            print(f"{sid}: no tune reference, skipped", file=sys.stderr)
            continue
        gap_frames = None
        mel = [n for n in d.get("base") or [] if n.get("role") == "melody"]
        if mel:
            # a song with a sung line: score only frames at least 1 s away from any sung note
            # (the instrumental stretches, where Easy / Medium play the instruments' tune)
            sung = np.zeros(len(times), bool)
            for n in mel:
                sung[np.searchsorted(times, n["start"] - 1):np.searchsorted(times, n["start"] + n["dur"] + 1)] = True
            ref = np.where(sung, 0.0, ref)
            if kind == "lead":
                conf_ref = np.where(sung, 0.0, conf_ref)
            gap_frames = round(float((~sung).mean()), 4)
        group = kind if kind != "lead" else ("lead-vocal-gaps" if mel else "lead-band")
        r = {"ref": kind, "group": group, "refVoiced": round(float((ref > 0).mean()), 4), "refShape": shape_of(ref)}
        if gap_frames is not None:
            r["gapsOnly"] = True
            r["gapFrames"] = gap_frames
            # RH notes starting in the scored (gap) frames, and back-to-back same-pitch repeats there
            for lv in ("easy", "medium"):
                rh = sorted((n for n in d.get(lv) or [] if n.get("hand") == "R"), key=lambda n: n["start"])
                ing = [not sung[min(len(times) - 1, np.searchsorted(times, n["start"]))] for n in rh]
                r[f"{lv}GapRH"] = int(sum(ing))
                r[f"{lv}GapRepeats"] = int(sum(1 for i in range(1, len(rh)) if ing[i] and rh[i]["midi"] == rh[i - 1]["midi"]
                                               and rh[i]["start"] - (rh[i - 1]["start"] + rh[i - 1]["dur"]) < 0.04))
        if kind == "lead":
            r["confidentFrames"] = round(float((conf_ref > 0).mean()), 4)
            for lv in ("easy", "medium", "hard"):
                r[f"{lv}Confident"] = score_level(times, conf_ref, d.get(lv) or [])
        for lv in ("easy", "medium", "hard"):
            r[lv] = score_level(times, ref, d.get(lv) or [])
        if d.get("line"):
            r["line"] = score(times, ref, line_f0(NoteArr.from_list(d["line"]), times, "R", mode="top"))
        r["baseTopAnyHand"] = score(times, ref, line_f0(N["base"], times, None, mode="top"))
        r["easyShape"] = rh_shape(d.get("easy") or [], dur)
        r["mediumShape"] = rh_shape(d.get("medium") or [], dur)
        r["easyLineShape"] = shape_of(line_f0(N["easy"], times, "R", mode="top"))
        bp = f"{a.work}/refs/vocal/{sid}.bass.f0.npz"
        if os.path.exists(bp):
            b = np.load(bp)
            for lv in ("easy", "medium"):
                r[f"{lv}LHbassRCA"] = melody_metrics(b["times"], b["f0"], line_f0(N[lv], b["times"], "L", mode="bottom"))["rawChroma"]
            drums = f"{a.work}/stems/{sid}/drums.wav"
            if os.path.exists(drums) and not a.no_drums:
                from acclib import load_audio
                from evaluate import drum_low_notes
                y = load_audio(drums)
                for lv in ("easy", "medium", "hard"):
                    r[f"{lv}DrumSuspectsPerMin"] = drum_low_notes(N[lv], y, (b["times"], b["f0"])).get("suspectDrumNotesPerMin")
        res[os.path.basename(run).removesuffix(".json")] = r
        e, m = r["easy"], r["medium"]
        conf = ""
        if kind == "lead":
            conf = f" | confident frames: easy RCA {r['easyConfident']['rawChroma']:.3f} med {r['mediumConfident']['rawChroma']:.3f} hard {r['hardConfident']['rawChroma']:.3f}"
        print(f"{os.path.basename(run).removesuffix('.json'):34s} {kind:5s} easy RPA {e['rawPitch']:.3f} RCA {e['rawChroma']:.3f} VR {e['voicingRecall']:.3f} "
              f"onsetPC {e['onsetPC']:.3f}/{e['onsetN']} bothCA {e['bothCA']:.3f} legatoRCA {e['legatoRCA']:.3f} | "
              f"med RCA {m['rawChroma']:.3f} onsetPC {m['onsetPC']:.3f} legatoRCA {m['legatoRCA']:.3f} | "
              + (f"gap RH notes E {r['easyGapRH']} M {r['mediumGapRH']} repeats E {r['easyGapRepeats']} | " if gap_frames is not None else "")
              + (f"line RPA {r['line']['rawPitch']:.3f} RCA {r['line']['rawChroma']:.3f} | " if "line" in r else "")
              + f"hard RCA {r['hard']['rawChroma']:.3f} | ceil RCA {r['baseTopAnyHand']['rawChroma']:.3f} | "
              f"leap>8ve {r['easyShape'].get('pctLeapGtOctave')}% medStep {r['easyShape'].get('medianAbsInterval')}"
              + (f" | LH bass E {r['easyLHbassRCA']:.3f} M {r['mediumLHbassRCA']:.3f}" if "easyLHbassRCA" in r else "")
              + (f" | drums/min E {r.get('easyDrumSuspectsPerMin')} M {r.get('mediumDrumSuspectsPerMin')}" if "easyDrumSuspectsPerMin" in r else "") + conf,
              flush=True)
    groups = {}
    for sid, r in res.items():
        groups.setdefault(r["group"], []).append(r)
    summary = {}
    keys = ("rawPitch", "rawChroma", "voicingRecall", "onsetPC", "bothCA", "legatoRCA")
    for kind, rs in groups.items():
        sm = {f"{lv}.{k}": round(float(np.mean([x[lv][k] for x in rs])), 4) for lv in ("easy", "medium", "hard") for k in keys}
        sm["n"] = len(rs)
        summary[kind] = sm
        print(f"MEAN {kind:15s} (n={len(rs)}): easy RPA {sm['easy.rawPitch']:.3f} RCA {sm['easy.rawChroma']:.3f} VR {sm['easy.voicingRecall']:.3f}"
              f" onsetPC {sm['easy.onsetPC']:.3f} bothCA {sm['easy.bothCA']:.3f} legatoRCA {sm['easy.legatoRCA']:.3f}"
              f" | medium RCA {sm['medium.rawChroma']:.3f} VR {sm['medium.voicingRecall']:.3f} onsetPC {sm['medium.onsetPC']:.3f} legatoRCA {sm['medium.legatoRCA']:.3f}")
    if a.out:
        json.dump({"songs": res, "summary": summary}, open(a.out, "w"), indent=1)


if __name__ == "__main__":
    main()
