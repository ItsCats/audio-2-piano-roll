"""
Metric functions for the real-recording accuracy harness. All metric code lives here so that
sanity.py exercises exactly what evaluate.py reports.
"""
from __future__ import annotations

import numpy as np

from acclib import NoteArr, SR, chroma, midi_to_hz, synth, top_line_f0

# ----------------------------------------------------------------------------- note level


def _iv(n: NoteArr) -> np.ndarray:
    return np.stack([n.onset, np.maximum(n.offset, n.onset + 0.01)], 1) if len(n) else np.zeros((0, 2))


def note_prf(ref: NoteArr, est: NoteArr, onset_tol: float = 0.05, offsets: bool = False, pitch_class: bool = False) -> dict:
    """mir_eval note-level precision/recall/F1 (onset-only unless offsets=True: offset within
    max(50 ms, 20% of ref duration)). pitch_class=True ignores the octave."""
    import mir_eval

    if not len(ref) or not len(est):
        return {"p": 0.0, "r": 0.0, "f1": 0.0, "nRef": len(ref), "nEst": len(est)}
    rp, ep = ref.pitch, est.pitch
    if pitch_class:
        rp, ep = 60 + rp % 12, 60 + ep % 12
    p, r, f, _ = mir_eval.transcription.precision_recall_f1_overlap(
        _iv(ref), midi_to_hz(rp), _iv(est), midi_to_hz(ep), onset_tolerance=onset_tol,
        offset_ratio=0.2 if offsets else None, offset_min_tolerance=0.05)
    return {"p": round(p, 4), "r": round(r, 4), "f1": round(f, 4), "nRef": len(ref), "nEst": len(est)}


def note_suite(ref: NoteArr, est: NoteArr) -> dict:
    return {
        "onset50": note_prf(ref, est, 0.05),
        "onset100": note_prf(ref, est, 0.1),
        "onsetOffset50": note_prf(ref, est, 0.05, offsets=True),
    }


def matched_pairs(ref: NoteArr, est: NoteArr, tol: float = 0.1):
    import mir_eval

    if not len(ref) or not len(est):
        return []
    return mir_eval.transcription.match_notes(_iv(ref), midi_to_hz(ref.pitch), _iv(est), midi_to_hz(est.pitch),
                                              onset_tolerance=tol, offset_ratio=None)


def hand_agreement(ref: NoteArr, est: NoteArr, tol: float = 0.1) -> dict | None:
    if not len(ref) or not np.isin(ref.hand, ["L", "R"]).any():
        return None
    m = [(i, j) for i, j in matched_pairs(ref, est, tol) if ref.hand[i] in ("L", "R")]
    if not m:
        return None
    agree = np.mean([ref.hand[i] == est.hand[j] for i, j in m])
    return {"n": len(m), "agreement": round(float(agree), 4)}


def error_breakdown(ref: NoteArr, est: NoteArr, tol: float = 0.05) -> dict:
    """Classify unmatched estimated notes (false positives) and missed reference notes."""
    m = matched_pairs(ref, est, tol)
    me = {j for _, j in m}
    mr = {i for i, _ in m}
    fp = {}
    for j in range(len(est)):
        if j in me:
            continue
        t, p = est.onset[j], est.pitch[j]
        near = (np.abs(ref.onset - t) <= 0.1)
        sounding = (ref.onset - 0.05 <= t) & (ref.offset + 0.1 >= t)
        if np.any(near & (ref.pitch == p)):
            cat = "timing 50-100ms"
        elif np.any(sounding & (ref.pitch == p)):
            cat = "re-onset of sounding note"
        elif np.any(near & np.isin(p - ref.pitch, [12, 19, 24, 28])):
            cat = "harmonic above ref"
        elif np.any(near & np.isin(ref.pitch - p, [12, 19, 24])):
            cat = "octave/12th below ref"
        elif np.any(near & (np.abs(ref.pitch - p) == 1)):
            cat = "semitone neighbour"
        else:
            cat = "other"
        fp[cat] = fp.get(cat, 0) + 1
    fn = {}
    for i in range(len(ref)):
        if i in mr:
            continue
        t, p = ref.onset[i], ref.pitch[i]
        if np.any((np.abs(est.onset - t) <= 0.1) & (est.pitch == p)):
            cat = "timing 50-100ms"
        elif np.any((est.onset < t) & (est.offset > t) & (est.pitch == p)):
            cat = "merged into earlier note"
        elif np.any((np.abs(est.onset - t) <= 0.05) & np.isin(est.pitch - p, [12, -12])):
            cat = "octave error"
        else:
            cat = "missed"
        fn[cat] = fn.get(cat, 0) + 1
    hit = np.zeros(len(ref), bool)
    hit[list(mr)] = True
    by_reg = {}
    for name, lo, hi in (("<C3", 0, 48), ("C3-B4", 48, 72), (">=C5", 72, 128)):
        k = (ref.pitch >= lo) & (ref.pitch < hi)
        if k.any():
            by_reg[name] = {"n": int(k.sum()), "recall": round(float(hit[k].mean()), 4)}
    by_vel = {}
    if len(ref) >= 30 and np.ptp(ref.vel) > 0:
        q1, q2 = np.quantile(ref.vel, [1 / 3, 2 / 3])
        for name, k in (("soft third", ref.vel <= q1), ("middle third", (ref.vel > q1) & (ref.vel <= q2)), ("loud third", ref.vel > q2)):
            if k.any():
                by_vel[name] = {"n": int(k.sum()), "recall": round(float(hit[k].mean()), 4)}
    return {"recallByRegister": by_reg, "recallByVelocity": by_vel, "falsePositives": dict(sorted(fp.items(), key=lambda x: -x[1])), "missed": dict(sorted(fn.items(), key=lambda x: -x[1]))}


# ----------------------------------------------------------------------------- melody

def melody_metrics(ref_times: np.ndarray, ref_f0: np.ndarray, est_f0: np.ndarray) -> dict:
    """mir_eval.melody on a shared 10 ms grid (est_f0 already sampled at ref_times)."""
    import mir_eval

    rv, rc, ev, ec = mir_eval.melody.to_cent_voicing(ref_times, ref_f0, ref_times, est_f0)
    vr, vfa = mir_eval.melody.voicing_measures(rv, ev)
    return {
        "rawPitch": round(float(mir_eval.melody.raw_pitch_accuracy(rv, rc, ev, ec)), 4),
        "rawChroma": round(float(mir_eval.melody.raw_chroma_accuracy(rv, rc, ev, ec)), 4),
        "overall": round(float(mir_eval.melody.overall_accuracy(rv, rc, ev, ec)), 4),
        "voicingRecall": round(float(vr), 4),
        "voicingFalseAlarm": round(float(vfa), 4),
    }


def interval_histogram(ref_f0: np.ndarray, est_f0: np.ndarray) -> dict:
    """For frames voiced in both: distribution of (est - ref) in semitones, bucketed."""
    both = (ref_f0 > 0) & (est_f0 > 0)
    if not both.any():
        return {}
    d = np.round(12 * np.log2(est_f0[both] / ref_f0[both])).astype(int)
    out = {}
    for v in d:
        if v == 0:
            k = "unison (correct)"
        elif v % 12 == 0:
            k = f"octave {'+' if v > 0 else '-'}{abs(v) // 12}"
        else:
            k = f"{'above' if v > 0 else 'below'} {abs(v) % 12} st (mod 12)"
        out[k] = out.get(k, 0) + 1
    n = len(d)
    return {k: round(c / n, 4) for k, c in sorted(out.items(), key=lambda x: -x[1])[:8]} | {"_frames": int(n)}


def presence(ref_times: np.ndarray, ref_f0: np.ndarray, notes: NoteArr) -> dict:
    """Upper bound for line selection: fraction of voiced reference frames where ANY note of the
    transcription sounds at the same pitch (exact) / same pitch class."""
    v = ref_f0 > 0
    if not v.any():
        return {}
    rm = np.round(69 + 12 * np.log2(ref_f0[v] / 440)).astype(int)
    t = ref_times[v]
    exact = np.zeros(len(t), bool)
    pc = np.zeros(len(t), bool)
    for a, b, p in zip(notes.onset, notes.offset, notes.pitch):
        i0, i1 = np.searchsorted(t, a), np.searchsorted(t, b)
        if i1 <= i0:
            continue
        exact[i0:i1] |= rm[i0:i1] == p
        pc[i0:i1] |= (rm[i0:i1] - p) % 12 == 0
    return {"exact": round(float(exact.mean()), 4), "chroma": round(float(pc.mean()), 4)}


# ----------------------------------------------------------------------------- content proxies

def sim_chroma(y: np.ndarray, hop: int = 2048) -> np.ndarray:
    """Chroma for the similarity metric: linear-magnitude CQT chroma, mean-centred and L2-normalised
    per frame, so the frame cosine is a Pearson correlation (a flat/noisy chroma scores ~0, not ~0.8)."""
    import librosa

    c = librosa.feature.chroma_cqt(y=y, sr=SR, hop_length=hop, norm=None, n_chroma=12, bins_per_octave=36)
    c = c - c.mean(0, keepdims=True)
    n = np.linalg.norm(c, axis=0, keepdims=True)
    return np.where(n > 1e-9, c / np.maximum(n, 1e-12), 0)


def audio_chroma(y: np.ndarray, hop: int = 2048):
    c = sim_chroma(y, hop)
    n = c.shape[1]
    fr = np.lib.stride_tricks.sliding_window_view(np.pad(y, (0, hop * (n + 1))), hop)[::hop][:n]
    rms = np.sqrt((fr ** 2).mean(1) + 1e-12)
    loud = 20 * np.log10(rms / (np.percentile(rms, 95) + 1e-12)) > -40
    return c, loud


def chroma_similarity(a_chroma: np.ndarray, loud: np.ndarray, notes: NoteArr, duration: float, hop: int = 2048) -> float:
    """Mean per-frame correlation between the recording's CQT chroma and the chroma of the
    notes rendered with the additive synth, over the recording's non-silent frames (frames where
    the rendering is silent count as 0)."""
    y = synth(notes, duration)
    c = sim_chroma(y, hop)
    n = min(a_chroma.shape[1], c.shape[1])
    sim = (a_chroma[:, :n] * c[:, :n]).sum(0)
    return round(float(sim[loud[:n]].mean()), 4)


def detect_onsets(y: np.ndarray) -> np.ndarray:
    import librosa

    return librosa.onset.onset_detect(y=y, sr=SR, hop_length=256, units="time", backtrack=False)


def note_onset_times(notes: NoteArr, merge: float = 0.03) -> np.ndarray:
    t = np.sort(notes.onset)
    out = []
    for x in t:
        if not out or x - out[-1] > merge:
            out.append(x)
    return np.array(out)


def onset_f(ref_onsets: np.ndarray, est_onsets: np.ndarray, window: float = 0.05) -> dict:
    import mir_eval

    if not len(ref_onsets) or not len(est_onsets):
        return {"f": 0.0, "p": 0.0, "r": 0.0}
    f, p, r = mir_eval.onset.f_measure(ref_onsets, est_onsets, window=window)
    return {"f": round(f, 4), "p": round(p, 4), "r": round(r, 4)}


def line_f0(notes: NoteArr, times: np.ndarray, hand: str | None, mode: str = "top") -> np.ndarray:
    return top_line_f0(notes, times, hand, mode)
