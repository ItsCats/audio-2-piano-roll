"""
Render evaluate.py output as a Markdown report.

    python3 tests/accuracy/make_report.py BASELINE.json OUT.md [--refs REFS_INFO.json] [--sanity SANITY.json ...]
        [--prepend NOTES.md] [--append NOTES.md]
"""
from __future__ import annotations

import argparse
import json


def f(x, nd=3):
    if x is None:
        return "–"
    if isinstance(x, float):
        return f"{x:.{nd}f}"
    return str(x)


def table(headers, rows):
    out = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    out += ["| " + " | ".join(f(c) for c in r) + " |" for r in rows]
    return "\n".join(out)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("baseline")
    ap.add_argument("out")
    ap.add_argument("--refs")
    ap.add_argument("--sanity", nargs="*", default=[])
    ap.add_argument("--prepend")
    ap.add_argument("--append")
    a = ap.parse_args()
    B = json.load(open(a.baseline))
    songs = B["songs"]
    md = [f"# Piano2Vision baseline accuracy on real recordings\n\nGenerated {B.get('generated')} by `tests/accuracy/evaluate.py` + `make_report.py`.\n"]
    if a.prepend:
        md.append(open(a.prepend).read())
    if a.sanity:
        md.append("## Metric sanity checks\n")
        rows = []
        for p in a.sanity:
            for r in json.load(open(p)):
                rows.append([p.split("/")[-1].replace(".json", ""), r["check"], r["got"], f"{r['expect'][0]}..{r['expect'][1]}", "ok" if r["ok"] else "FAIL"])
        md.append(table(["case", "check", "got", "expected", ""], rows) + "\n")
    if a.refs:
        md.append("## Ground truth / references\n")
        R = json.load(open(a.refs))
        md.append(table(["song", "kind", "source", "alignment quality"], [[r["song"], r["kind"], r["source"], r["alignmentQuality"]] for r in R]) + "\n")

    # ---- piano note-level
    rows = []
    for s in songs:
        for pr, r in s["presets"].items():
            if "notes" not in r and "vsPTI" not in r:
                continue
            n = r.get("notes", {})
            o50, o100, oo = n.get("onset50", {}), n.get("onset100", {}), n.get("onsetOffset50", {})
            ceil = s.get("referenceChecks", {}).get("ptiVsRef", {}).get("onset50", {}).get("f1")
            rows.append([
                s["song"], pr + (" *" if pr == s["suggestedPreset"] else ""), s.get("noteRef", {}).get("kind", "–"),
                o50.get("f1"), f"{f(o50.get('p'))}/{f(o50.get('r'))}" if o50 else "–", o100.get("f1"), oo.get("f1"),
                r.get("vsPTI", {}).get("onset50", {}).get("f1"), ceil,
                (n.get("handAgreement") or {}).get("agreement"), r["counts"]["base"], n.get("onset50", {}).get("nRef"),
            ])
    if rows:
        md.append("## Note-level accuracy (piano recordings)\n\n`*` = preset the UI suggests. F1 = mir_eval onset-only (pitch exact) at 50 / 100 ms; `on+off@50` also requires the offset within max(50 ms, 20 % of the duration) (reference offsets pedal-extended). `vs PTI` = agreement with the ByteDance piano transcriber on the same audio (a strong-model proxy, NOT truth); `PTI↔ref` = that model's own F1 against the reference (what a state-of-the-art piano model reaches; MAESTRO-train pieces are optimistic for it).\n")
        md.append(table(["song", "preset", "reference", "F1@50", "P/R@50", "F1@100", "on+off@50", "vs PTI F1@50", "PTI↔ref F1@50", "hand agr.", "#notes", "#ref"], rows) + "\n")
        # arrangement precision
        rows = []
        for s in songs:
            for pr, r in s["presets"].items():
                if "arrangementPrecision" not in r or pr != s["suggestedPreset"]:
                    continue
                ap_ = r["arrangementPrecision"]
                rows.append([s["song"], pr] + [f"{f(ap_[lv]['pitch@100'])} / {f(ap_[lv]['pitchClass@100'])}" for lv in ("easy", "medium", "hard")] + [r["counts"]["easy"], r["counts"]["medium"]])
        md.append("### Arrangement precision (suggested preset)\n\nShare of an arrangement's notes that exist in the reference (onset within 100 ms; exact pitch / pitch class — Easy transposes registers, so pitch class is the fair number).\n")
        md.append(table(["song", "preset", "Easy", "Medium", "Hard", "#Easy", "#Medium"], rows) + "\n")
        rows = []
        for s in songs:
            r = s["presets"].get(s["suggestedPreset"], {})
            e = r.get("notes", {}).get("errors")
            if not e:
                continue
            fp = ", ".join(f"{k} {v}" for k, v in list(e["falsePositives"].items())[:4])
            fn = ", ".join(f"{k} {v}" for k, v in list(e["missed"].items())[:4])
            rows.append([s["song"], fp, fn])
        md.append("### Error breakdown at 50 ms (suggested preset)\n")
        md.append(table(["song", "false positives (top)", "missed reference notes (top)"], rows) + "\n")

    # ---- melody
    rows = []
    for s in songs:
        for pr, r in s["presets"].items():
            if "melody" not in r:
                continue
            m = r["melody"]
            vp = r["vocalPresentInBase"]
            iv = r["melodyIntervalsEasy"]
            top = ", ".join(f"{k} {v:.0%}" for k, v in iv.items() if not k.startswith("_"))
            rows.append([
                s["song"], pr + (" *" if pr == s["suggestedPreset"] else ""),
                f"{f(m['easy']['rawPitch'])} / {f(m['easy']['rawChroma'])} / {f(m['easy']['overall'])}",
                f"{f(m['medium']['rawPitch'])} / {f(m['medium']['rawChroma'])}",
                f"{f(m['hard']['rawPitch'])} / {f(m['hard']['rawChroma'])}",
                f"{f(m['base_topAnyHand']['rawChroma'])}",
                f"{f(vp.get('exact'))} / {f(vp.get('chroma'))}",
                m["easy"]["voicingRecall"], r.get("easyRHActiveWhenVocalSilent"), top,
            ])
    if rows:
        md.append("## Vocal melody (songs with a singer)\n\nReference = Demucs `htdemucs_6s` vocal stem → torchcrepe f0 (proxy, see caveats). Transcription line = highest sounding RIGHT-HAND note per 10 ms frame. RPA = raw pitch accuracy, RCA = raw chroma accuracy (octave ignored), OA = overall accuracy (includes voicing). `vocal in base` = upper bound for any line-picking rule: share of sung frames where ANY transcribed note has the sung pitch (exact / pitch class).\n")
        md.append(table(["song", "preset", "Easy RPA/RCA/OA", "Medium RPA/RCA", "Hard RPA/RCA", "base top-any-hand RCA", "vocal in base exact/chroma", "Easy voicing recall", "Easy RH busy when vocal silent", "Easy RH vs vocal (frames voiced in both)"], rows) + "\n")
    rows = []
    for s in songs:
        for pr, r in s["presets"].items():
            if "bass" not in r:
                continue
            b = r["bass"]
            rows.append([s["song"], pr + (" *" if pr == s["suggestedPreset"] else ""), f"{f(b['easy']['rawPitch'])} / {f(b['easy']['rawChroma'])}",
                         f"{f(b['medium']['rawPitch'])} / {f(b['medium']['rawChroma'])}", f"{f(b['hard']['rawPitch'])} / {f(b['hard']['rawChroma'])}",
                         f"{f(b['base_bottomAnyHand']['rawChroma'])}"])
    if rows:
        md.append("## Bass line (left hand) vs Demucs bass stem\n\nLowest sounding LEFT-HAND note per frame vs torchcrepe f0 of the bass stem (RPA / RCA on bass-voiced frames).\n")
        md.append(table(["song", "preset", "Easy LH", "Medium LH", "Hard LH", "base bottom-any-hand RCA"], rows) + "\n")
    rows = []
    for s in songs:
        for pr, r in s["presets"].items():
            d = r.get("drumLowNotes")
            if not d or "suspectDrumNotes" not in d:
                continue
            rows.append([s["song"], pr, d["lowNotes"], d["lowNotesPerMin"], d["fracNearDrumOnset"], d["chanceNearDrumOnset"], d["fracNotBassPitchClass"], d["suspectDrumNotes"], d["suspectDrumNotesPerMin"],
                         ", ".join(f"{k}:{v}" for k, v in d["suspectPitchTop"].items())])
    if rows:
        md.append("## Low notes (< C3) vs drum hits\n\n`near drum` = onset within 40 ms of a drum-stem onset (vs `chance` for random times). `suspect` = near a drum hit AND not the bass stem's pitch class.\n")
        md.append(table(["song", "preset", "#low", "low/min", "near drum", "chance", "not bass PC", "#suspect", "suspect/min", "suspect pitches (midi:count)"], rows) + "\n")

    # ---- content proxies
    rows = []
    for s in songs:
        rc = s.get("referenceChecks", {})
        for pr, r in s["presets"].items():
            c, o = r["chromaSim"], r["onsetF"]
            rows.append([s["song"], pr + (" *" if pr == s["suggestedPreset"] else ""), c["base"], c["easy"], c["medium"], c["hard"], c["base_shifted17s_floor"], rc.get("chromaSim_refCeiling", rc.get("chromaSim_pti")),
                         o["base"]["f"], o["easy"]["f"], o["medium"]["f"], rc.get("onsetF_randomFloor"), rc.get("onsetF_refCeiling", rc.get("onsetF_pti"))])
    md.append("## Content proxies (all songs, all levels)\n\nChroma = mean per-frame correlation between the recording's CQT chroma and the chroma of the notes rendered with a simple additive synth (non-silent frames; silent rendering counts 0). `floor` = base shifted by 17 s; `ceiling` = the note reference (or PTI transcription) rendered the same way. Onset F = mir_eval onset F-measure (50 ms) of note-onset clusters vs librosa onsets of the recording; `rand` = random onsets at the same rate.\n")
    md.append(table(["song", "preset", "chroma base", "Easy", "Medium", "Hard", "floor", "ceiling", "onsetF base", "Easy", "Medium", "rand", "ceiling"], rows) + "\n")

    # ---- timing / tempo
    rows = []
    for s in songs:
        for pr, r in s["presets"].items():
            h = r.get("host") or {}
            rows.append([s["song"], pr, s["durationSec"], r["transcribeSec"], r["realtimeFactor"], r["backend"], h.get("loadavg1Before"), r["counts"]["base"], r["notesPerSec"], r["tempo"]["bpm"], r["tempo"]["confidence"], r["key"], "; ".join(r["warnings"])[:80]])
    md.append("## Timing, tempo, key\n\n`load` = 1-minute load average of the (4-core, shared) VM when the run started — other jobs were running, so times are pessimistic.\n")
    md.append(table(["song", "preset", "audio s", "transcribe s", "×realtime", "backend", "load", "#notes", "notes/s", "BPM", "tempo conf", "key", "warnings"], rows) + "\n")
    if a.append:
        md.append(open(a.append).read())
    open(a.out, "w").write("\n".join(md))
    print("wrote", a.out)


if __name__ == "__main__":
    main()
