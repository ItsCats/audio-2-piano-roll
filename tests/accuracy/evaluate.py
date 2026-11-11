"""
Score app transcriptions of real recordings against the references built by the other scripts.

    server/.venv/bin/python tests/accuracy/evaluate.py --work WORK_DIR [--manifest tests/accuracy/songs.json]
        [--trans WORK_DIR/transcriptions] [--out WORK_DIR/baseline] [--only id1,id2] audio1 [audio2 ...]

Expected layout under WORK_DIR (produced by separate.py / vocal_ref.py / align_score.py /
pti_transcribe.py / snap_ref.py / transcribe.mjs):
  transcriptions/<id>.<preset>.json   app output (tests/accuracy/transcribe.mjs)
  refs/snapped/<id>.json              score-informed note reference      (noteRef: snapped)
  refs/aligned/<id>.json              DTW-only aligned score             (noteRef: aligned)
  <audio dir>/<id>.midi               exact performance MIDI             (noteRef: exact)
  refs/pti/<id>.pti.json              strong piano transcriber output    (ptiRef)
  refs/vocal/<id>.vocals.f0.npz       vocal pitch track                  (vocalRef)
  refs/vocal/<id>.bass.f0.npz         bass pitch track                   (bassRef)
  stems/<id>/drums.wav                Demucs drum stem                   (stems)
Writes OUT.json (all metrics) and OUT.md (tables).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from acclib import NoteArr, SR, load_audio, load_notes, midi_notes  # noqa: E402
from metrics import (audio_chroma, chroma_similarity, detect_onsets, error_breakdown, hand_agreement,  # noqa: E402
                     interval_histogram, line_f0, melody_metrics, note_onset_times, note_prf, note_suite, onset_f,
                     presence)

LEVELS = ["base", "easy", "medium", "hard"]


def load_trans(path: str) -> dict:
    with open(path) as f:
        d = json.load(f)
    d["_notes"] = {lv: NoteArr.from_list(d[lv]) for lv in LEVELS}
    return d


def drum_low_notes(base: NoteArr, drums_y: np.ndarray, bass_ref: tuple | None) -> dict:
    """Low notes (< C3) whose onset coincides with a drum-stem onset and whose pitch class is not
    the bass line's: likely drum-induced false notes. 'chance' = fraction of random times within
    40 ms of a drum onset (what coincidence alone would give)."""
    import librosa

    det = librosa.onset.onset_detect(y=drums_y, sr=SR, hop_length=256, units="time", backtrack=False, delta=0.15)
    low = base.select(base.pitch < 48)
    if not len(low) or not len(det):
        return {"lowNotes": int(len(low))}

    def near(t):
        j = np.clip(np.searchsorted(det, t), 1, len(det) - 1)
        return np.minimum(np.abs(t - det[j - 1]), np.abs(t - det[j])) <= 0.04

    nd = near(low.onset)
    dur = float(max(base.offset.max(), det.max()))
    chance = float(near(np.random.default_rng(0).uniform(0, dur, 20000)).mean())
    out = {"lowNotes": int(len(low)), "lowNotesPerMin": round(len(low) / dur * 60, 1),
           "fracNearDrumOnset": round(float(nd.mean()), 4), "chanceNearDrumOnset": round(chance, 4)}
    if bass_ref is not None:
        bt, bf = bass_ref
        idx = np.clip(np.searchsorted(bt, low.onset + 0.06), 0, len(bt) - 1)
        bm = np.where(bf[idx] > 0, np.round(69 + 12 * np.log2(np.maximum(bf[idx], 1) / 440)), -100)
        not_bass = (bm < 0) | ((low.pitch - bm) % 12 != 0)
        out["fracNotBassPitchClass"] = round(float(not_bass.mean()), 4)
        sus = nd & not_bass
        out["suspectDrumNotes"] = int(sus.sum())
        out["suspectDrumNotesPerMin"] = round(sus.sum() / dur * 60, 1)
        h = np.bincount(low.pitch[sus], minlength=48)[20:48]
        top = np.argsort(-h)[:5]
        out["suspectPitchTop"] = {int(20 + k): int(h[k]) for k in top if h[k] > 0}
    return out


def eval_song(sid: str, audio: str, cfg: dict, work: str, trans_dir: str, log) -> dict:
    t0 = time.time()
    y = load_audio(audio)
    dur = len(y) / SR
    ac, loud = audio_chroma(y)
    aud_on = detect_onsets(y)
    res = {"song": sid, "kind": cfg["kind"], "durationSec": round(dur, 2), "suggestedPreset": cfg["suggested"], "presets": {}}
    # ---- references
    ref = None
    if cfg.get("noteRef") == "exact":
        ref = midi_notes(os.path.splitext(audio)[0] + ".midi", pedal_extend=True)
        res["noteRef"] = {"kind": "exact-performance-midi", "n": len(ref)}
    elif cfg.get("noteRef") in ("snapped", "aligned"):
        p = os.path.join(work, "refs", cfg["noteRef"], f"{sid}.json")
        if os.path.exists(p):
            ref, meta = load_notes(p)
            res["noteRef"] = {"kind": f"score-{cfg['noteRef']}", "n": len(ref), "verifiedFraction": meta.get("snap", {}).get("verifiedFraction")}
            unver = set(meta.get("unverified", []))
            ref_verified = ref.select(np.array([i not in unver for i in range(len(ref))])) if unver else ref
    pti = None
    if cfg.get("ptiRef"):
        p = os.path.join(work, "refs", "pti", f"{sid}.pti.json")
        if os.path.exists(p):
            pti, _ = load_notes(p)
    vocal = bass = None
    if cfg.get("vocalRef"):
        p = os.path.join(work, "refs", "vocal", f"{sid}.vocals.f0.npz")
        if os.path.exists(p):
            d = np.load(p)
            vocal = (d["times"], d["f0"])
            res["vocalRef"] = {"voicedFraction": round(float((d["f0"] > 0).mean()), 4)}
    if cfg.get("bassRef"):
        p = os.path.join(work, "refs", "vocal", f"{sid}.bass.f0.npz")
        if os.path.exists(p):
            d = np.load(p)
            bass = (d["times"], d["f0"])
    drums = None
    if cfg.get("stems"):
        p = os.path.join(work, "stems", sid, "drums.wav")
        if os.path.exists(p):
            drums = load_audio(p)
    # ---- reference ceilings / floors for the content proxies
    proxies = {"audioOnsets": int(len(aud_on))}
    rng = np.random.default_rng(1)
    proxies["onsetF_randomFloor"] = onset_f(aud_on, np.sort(rng.uniform(0, dur, len(aud_on))))["f"]
    if ref is not None:
        proxies["chromaSim_refCeiling"] = chroma_similarity(ac, loud, ref, dur)
        proxies["onsetF_refCeiling"] = onset_f(aud_on, note_onset_times(ref))["f"]
    if pti is not None:
        proxies["chromaSim_pti"] = chroma_similarity(ac, loud, pti, dur)
        proxies["onsetF_pti"] = onset_f(aud_on, note_onset_times(pti))["f"]
        if ref is not None:
            proxies["ptiVsRef"] = note_suite(ref, pti)
    res["referenceChecks"] = proxies
    # ---- each preset
    for preset in cfg["presets"]:
        p = os.path.join(trans_dir, f"{sid}.{preset}.json")
        if not os.path.exists(p):
            log(f"  missing {p}")
            continue
        tr = load_trans(p)
        N = tr["_notes"]
        r = {
            "transcribeSec": round(tr["timing"]["transcribeMs"] / 1000, 2),
            "realtimeFactor": round(tr["timing"]["transcribeMs"] / 1000 / dur, 3),
            "backend": tr["info"].get("backend"),
            "host": tr.get("host"),
            "counts": {lv: len(N[lv]) for lv in LEVELS},
            "notesPerSec": round(len(N["base"]) / dur, 2),
            "tempo": {"bpm": round(tr["tempo"]["bpm"], 1), "confidence": round(tr["tempo"]["confidence"], 3), "beatsPerBar": tr["tempo"]["beatsPerBar"]},
            "key": (tr.get("key") or {}).get("name"),
            "warnings": tr["info"].get("warnings", []),
        }
        base = N["base"]
        r["pitchRange"] = [int(base.pitch.min()), int(base.pitch.max())] if len(base) else None
        # content proxies for every level
        r["chromaSim"] = {lv: chroma_similarity(ac, loud, N[lv], dur) for lv in LEVELS}
        r["chromaSim"]["base_shifted17s_floor"] = chroma_similarity(ac, loud, base.shifted(17.0), dur)
        r["onsetF"] = {lv: onset_f(aud_on, note_onset_times(N[lv])) for lv in LEVELS}
        # note level
        if ref is not None:
            r["notes"] = note_suite(ref, base)
            r["notes"]["errors"] = error_breakdown(ref, base)
            r["notes"]["handAgreement"] = hand_agreement(ref, base)
            if cfg.get("noteRef") == "snapped":
                r["notes"]["verifiedOnly_onset50_recall"] = note_prf(ref_verified, base, 0.05)["r"]
            r["arrangementPrecision"] = {
                lv: {"pitch@100": note_prf(ref, N[lv], 0.1)["p"], "pitchClass@100": note_prf(ref, N[lv], 0.1, pitch_class=True)["p"]}
                for lv in ("easy", "medium", "hard")
            }
        if pti is not None:
            r["vsPTI"] = note_suite(pti, base)
        # melody
        if vocal is not None:
            vt, vf = vocal
            mel = {}
            for lv in ("easy", "medium", "hard"):
                mel[lv] = melody_metrics(vt, vf, line_f0(N[lv], vt, "R"))
            mel["base_topAnyHand"] = melody_metrics(vt, vf, line_f0(base, vt, None))
            r["melody"] = mel
            r["melodyIntervalsEasy"] = interval_histogram(vf, line_f0(N["easy"], vt, "R"))
            r["vocalPresentInBase"] = presence(vt, vf, base)
            r["vocalPresentInEasyRH"] = presence(vt, vf, N["easy"].select(N["easy"].hand == "R"))
            # what does the Easy RH do while the singer is silent?
            unv = vf == 0
            ef = line_f0(N["easy"], vt, "R")
            r["easyRHActiveWhenVocalSilent"] = round(float((ef[unv] > 0).mean()), 4) if unv.any() else None
        if bass is not None:
            bt, bf = bass
            r["bass"] = {lv: melody_metrics(bt, bf, line_f0(N[lv], bt, "L", mode="bottom")) for lv in ("easy", "medium", "hard")}
            r["bass"]["base_bottomAnyHand"] = melody_metrics(bt, bf, line_f0(base, bt, None, mode="bottom"))
        if drums is not None:
            r["drumLowNotes"] = drum_low_notes(base, drums, bass)
        res["presets"][preset] = r
    # ---- separation oracle (optional): the app's pipeline run on Demucs stems of the same song
    orc = {}
    for stem in ("vocals", "accomp-nodrums"):
        for preset in ("mix", "piano"):
            p = os.path.join(trans_dir, f"{sid}.{stem}.{preset}.json")
            if not os.path.exists(p):
                continue
            tr = load_trans(p)
            N = tr["_notes"]
            o = {"counts": {lv: len(N[lv]) for lv in LEVELS}, "transcribeSec": round(tr["timing"]["transcribeMs"] / 1000, 2)}
            if vocal is not None and stem == "vocals":
                vt, vf = vocal
                o["melody_baseTop"] = melody_metrics(vt, vf, line_f0(N["base"], vt, None))
                o["melody_easyRH"] = melody_metrics(vt, vf, line_f0(N["easy"], vt, "R"))
                o["vocalPresentInBase"] = presence(vt, vf, N["base"])
                if vf.any():
                    ref_notes = load_notes(os.path.join(work, "refs", "vocal", f"{sid}.vocals.notes.json"))[0] \
                        if os.path.exists(os.path.join(work, "refs", "vocal", f"{sid}.vocals.notes.json")) else None
                    if ref_notes is not None:
                        o["vocalNotes"] = {"onset50": note_prf(ref_notes, N["base"], 0.05), "onset100": note_prf(ref_notes, N["base"], 0.1)}
            if bass is not None and stem == "accomp-nodrums":
                bt, bf = bass
                o["bass_easyLH"] = melody_metrics(bt, bf, line_f0(N["easy"], bt, "L", mode="bottom"))
                o["bass_baseBottom"] = melody_metrics(bt, bf, line_f0(N["base"], bt, None, mode="bottom"))
                o["chromaSim_vsOriginalMix"] = {lv: chroma_similarity(ac, loud, N[lv], dur) for lv in ("base", "easy")}
            orc[f"{stem}.{preset}"] = o
    if orc:
        res["separationOracle"] = orc
    res["evalSec"] = round(time.time() - t0, 1)
    return res


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--manifest", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "songs.json"))
    ap.add_argument("--trans")
    ap.add_argument("--out")
    ap.add_argument("audio", nargs="+")
    a = ap.parse_args()
    trans = a.trans or os.path.join(a.work, "transcriptions")
    out = a.out or os.path.join(a.work, "baseline")
    songs = json.load(open(a.manifest))["songs"]
    results = []
    for audio in a.audio:
        sid = os.path.splitext(os.path.basename(audio))[0]
        if sid not in songs:
            print("not in manifest:", sid)
            continue
        print("eval", sid, flush=True)
        results.append(eval_song(sid, audio, songs[sid], a.work, trans, print))
        with open(out + ".json", "w") as f:
            json.dump({"generated": time.strftime("%Y-%m-%d %H:%M"), "songs": results}, f, indent=1)
    print("wrote", out + ".json")


if __name__ == "__main__":
    main()
