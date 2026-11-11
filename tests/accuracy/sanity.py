"""
Sanity checks for every metric, on cases with a known answer.

    server/.venv/bin/python tests/accuracy/sanity.py REF_NOTES.(json|mid|midi) AUDIO [VOCAL_F0.npz]

    ... [--no-proxies]   (skip chroma/onset checks; for single-line references)

Prints one line per check (expected vs got) and exits non-zero if any check fails.
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from acclib import NoteArr, load_audio, load_notes, midi_notes, midi_to_hz, top_line_f0  # noqa: E402
from metrics import (audio_chroma, chroma_similarity, detect_onsets, interval_histogram, melody_metrics,  # noqa: E402
                     note_onset_times, note_prf, onset_f, presence)

results = []


def check(name, got, lo, hi):
    ok = lo <= got <= hi
    results.append({"check": name, "got": got, "expect": [lo, hi], "ok": bool(ok)})
    print(f"{'ok  ' if ok else 'FAIL'} {name}: {got} (expect {lo}..{hi})")


def main() -> None:
    argv = [x for x in sys.argv[1:] if x != "--no-proxies"]
    # --no-proxies: skip the recording-vs-reference content checks (chroma / onset). Use it when the
    # reference is a single line (e.g. a vocal melody), which is not expected to explain a full mix.
    proxies = "--no-proxies" not in sys.argv
    ref_path, audio = argv[0], argv[1]
    vocal = argv[2] if len(argv) > 2 else None
    ref = midi_notes(ref_path, True) if ref_path.endswith((".mid", ".midi")) else load_notes(ref_path)[0]
    ref = ref.sorted()
    # --- note level
    check("note F1@50 ref vs itself", note_prf(ref, ref, 0.05)["f1"], 1, 1)
    check("note F1@50 with offsets ref vs itself", note_prf(ref, ref, 0.05, offsets=True)["f1"], 1, 1)
    check("note F1@50 shifted +30 ms", note_prf(ref, ref.shifted(0.03), 0.05)["f1"], 1, 1)
    check("note F1@50 shifted +70 ms", note_prf(ref, ref.shifted(0.07), 0.05)["f1"], 0, 0.1)
    check("note F1@100 shifted +70 ms", note_prf(ref, ref.shifted(0.07), 0.1)["f1"], 0.99, 1)
    up = NoteArr(ref.onset, ref.offset, ref.pitch + 1, ref.vel, ref.hand)
    check("note F1@50 transposed +1 st", note_prf(ref, up, 0.05)["f1"], 0, 0.02)
    oct_ = NoteArr(ref.onset, ref.offset, ref.pitch + 12, ref.vel, ref.hand)
    check("note F1@50 +12 st (exact pitch)", note_prf(ref, oct_, 0.05)["f1"], 0, 0.1)
    check("note F1@50 +12 st (pitch class)", note_prf(ref, oct_, 0.05, pitch_class=True)["f1"], 0.99, 1)
    half = ref.select(np.arange(len(ref)) % 2 == 0)
    r = note_prf(ref, half, 0.05)
    check("half the notes: precision", r["p"], 1, 1)
    check("half the notes: recall", r["r"], 0.49, 0.51)
    # --- melody
    times = np.arange(0, float(ref.offset.max()), 0.01)
    f0 = top_line_f0(ref, times, None)
    check("melody RPA top line vs itself", melody_metrics(times, f0, f0)["rawPitch"], 1, 1)
    check("melody RPA +1 st", melody_metrics(times, f0, f0 * 2 ** (1 / 12))["rawPitch"], 0, 0)
    m12 = melody_metrics(times, f0, f0 * 2)
    check("melody RPA +12 st", m12["rawPitch"], 0, 0)
    check("melody RCA +12 st", m12["rawChroma"], 1, 1)
    check("interval histogram +12 -> octave +1", interval_histogram(f0, f0 * 2).get("octave +1", 0), 1, 1)
    # toy top-line
    toy = NoteArr(np.array([0.0, 0.0, 1.0]), np.array([2.0, 1.0, 2.0]), np.array([60, 64, 67]), np.ones(3), np.array(["R", "R", "R"]))
    tt = np.array([0.5, 1.5])
    check("top line toy (64 then 67)", float(np.round(69 + 12 * np.log2(top_line_f0(toy, tt, "R") / 440)).sum()), 131, 131)
    bot = top_line_f0(toy, tt, "R", mode="bottom")
    check("bottom line toy (60 both)", float(np.round(69 + 12 * np.log2(bot / 440)).sum()), 120, 120)
    check("presence of ref in itself (exact)", presence(times, f0, ref)["exact"], 1, 1)
    if vocal:
        d = np.load(vocal)
        vt, vf = d["times"], d["f0"]
        check("vocal ref vs itself RPA", melody_metrics(vt, vf, vf)["rawPitch"], 1, 1)
        check("vocal ref vs itself shifted 0.5 s RPA", melody_metrics(vt, vf, np.roll(vf, 50))["rawPitch"], 0, 0.5)
    # --- content proxies on the real recording
    if not proxies:
        return finish()
    y = load_audio(audio)
    dur = len(y) / 22050
    ac, loud = audio_chroma(y)
    sim = chroma_similarity(ac, loud, ref, dur)
    shifted = chroma_similarity(ac, loud, ref.shifted(17.0), dur)
    check("chroma sim ref (rendered) vs recording", sim, 0.5, 1)
    check("chroma sim ref shifted 17 s (floor) < unshifted - 0.3", shifted, -1, sim - 0.3)
    rnd = NoteArr(ref.onset, ref.offset, np.random.default_rng(0).integers(40, 90, len(ref)), ref.vel, ref.hand)
    check("chroma sim random pitches (floor) < 0.15", chroma_similarity(ac, loud, rnd, dur), -1, 0.15)
    on = detect_onsets(y)
    check("onset F audio onsets vs themselves", onset_f(on, on)["f"], 1, 1)
    check("onset F audio onsets shifted +30 ms (inside 50 ms window)", onset_f(on, on + 0.03)["f"], 1, 1)
    rng = np.random.default_rng(1)
    rand_on = np.sort(rng.uniform(0, dur, len(on)))
    check("onset F random onsets (floor) < 0.5 * ref-notes onset F", onset_f(on, rand_on)["f"], 0, 0.5 * onset_f(on, note_onset_times(ref))["f"])
    of = onset_f(on, note_onset_times(ref))["f"]
    check("onset F ref notes vs audio onsets (plausible)", of, 0.3, 1)
    finish()


def finish() -> None:
    print(json.dumps({"passed": sum(r["ok"] for r in results), "total": len(results)}))
    out = os.environ.get("SANITY_OUT")
    if out:
        with open(out, "w") as f:
            json.dump(results, f, indent=1)
    sys.exit(0 if all(r["ok"] for r in results) else 1)


if __name__ == "__main__":
    main()
