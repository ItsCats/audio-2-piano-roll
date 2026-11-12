"""
Shared helpers for the real-recording accuracy harness (tests/accuracy).

Everything here is deterministic and model-free: audio loading, MIDI parsing, a simple additive
piano-like synthesiser (used to render score MIDI / transcriptions back to audio for chroma
features), chroma + onset-chroma features, banded DTW, and note/melody conversions.
"""
from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass

import numpy as np

SR = 22050


# ----------------------------------------------------------------------------- audio / midi

def load_audio(path: str, sr: int = SR, mono: bool = True) -> np.ndarray:
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "f32le", "-ac", "1" if mono else "2", "-ar", str(sr), "-"],
        check=True, capture_output=True,
    ).stdout
    a = np.frombuffer(raw, dtype=np.float32).copy()
    return a if mono else a.reshape(-1, 2).T


@dataclass
class NoteArr:
    """Parallel arrays describing notes (seconds, MIDI pitch)."""
    onset: np.ndarray
    offset: np.ndarray
    pitch: np.ndarray
    vel: np.ndarray
    hand: np.ndarray  # 'L' / 'R' / '?'

    def __len__(self) -> int:
        return len(self.onset)

    @staticmethod
    def empty() -> "NoteArr":
        z = np.zeros(0)
        return NoteArr(z, z, z.astype(int), z, np.array([], dtype="<U1"))

    @staticmethod
    def from_list(notes: list[dict]) -> "NoteArr":
        """notes as in the transcription JSON: {midi, start, dur, vel, hand}."""
        if not notes:
            return NoteArr.empty()
        on = np.array([n["start"] for n in notes], float)
        return NoteArr(
            on,
            on + np.maximum(np.array([n["dur"] for n in notes], float), 0.01),
            np.array([n["midi"] for n in notes], int),
            np.array([n.get("vel", 0.7) for n in notes], float),
            np.array([n.get("hand", "?") for n in notes]),
        )

    def to_list(self) -> list[dict]:
        return [
            {"midi": int(p), "start": round(float(a), 4), "dur": round(float(b - a), 4), "vel": round(float(v), 3), "hand": str(h)}
            for a, b, p, v, h in zip(self.onset, self.offset, self.pitch, self.vel, self.hand)
        ]

    def select(self, mask) -> "NoteArr":
        return NoteArr(self.onset[mask], self.offset[mask], self.pitch[mask], self.vel[mask], self.hand[mask])

    def sorted(self) -> "NoteArr":
        o = np.lexsort((self.pitch, self.onset))
        return self.select(o)

    def shifted(self, dt: float) -> "NoteArr":
        return NoteArr(self.onset + dt, self.offset + dt, self.pitch.copy(), self.vel.copy(), self.hand.copy())


def save_notes(path: str, notes: NoteArr, meta: dict | None = None) -> None:
    with open(path, "w") as f:
        json.dump({"meta": meta or {}, "notes": notes.to_list()}, f)


def load_notes(path: str) -> tuple[NoteArr, dict]:
    with open(path) as f:
        d = json.load(f)
    return NoteArr.from_list(d["notes"]), d.get("meta", {})


def midi_notes(path: str, pedal_extend: bool = False) -> NoteArr:
    """Parse a MIDI file. Hand is taken from the track/instrument name when it says so
    (upper/right/RH -> R, lower/left/LH -> L). With pedal_extend, note offsets are extended
    while the sustain pedal (CC64 >= 64) is down (MAESTRO evaluation convention)."""
    import pretty_midi

    pm = pretty_midi.PrettyMIDI(path)
    rows = []
    for inst in pm.instruments:
        if inst.is_drum:
            continue
        name = (inst.name or "").lower()
        hand = "R" if any(k in name for k in ("upper", "right", "rh", "treble")) else "L" if any(k in name for k in ("lower", "left", "lh", "bass")) else "?"
        pedal = []
        if pedal_extend:
            down = None
            for cc in sorted(inst.control_changes, key=lambda c: c.time):
                if cc.number != 64:
                    continue
                if cc.value >= 64 and down is None:
                    down = cc.time
                elif cc.value < 64 and down is not None:
                    pedal.append((down, cc.time))
                    down = None
            if down is not None:
                pedal.append((down, pm.get_end_time()))
        for n in inst.notes:
            end = n.end
            for a, b in pedal:
                if a <= end < b:
                    end = b
                    break
            rows.append((n.start, end, n.pitch, n.velocity / 127, hand))
    if pedal_extend and rows:
        # a re-struck pitch cuts the pedal-extended previous note (as on a real piano)
        rows.sort(key=lambda r: (r[2], r[0]))
        for i in range(len(rows) - 1):
            if rows[i][2] == rows[i + 1][2] and rows[i][1] > rows[i + 1][0]:
                r = rows[i]
                rows[i] = (r[0], max(r[0] + 0.01, rows[i + 1][0]), r[2], r[3], r[4])
    if not rows:
        return NoteArr.empty()
    rows.sort(key=lambda r: (r[0], r[2]))
    on, off, p, v, h = zip(*rows)
    return NoteArr(np.array(on), np.array(off), np.array(p, int), np.array(v), np.array(h))


# ----------------------------------------------------------------------------- synthesis

_TEMPLATES: dict[tuple[int, int], np.ndarray] = {}


def _template(pitch: int, sr: int, length_s: float = 6.0) -> np.ndarray:
    key = (pitch, sr)
    if key not in _TEMPLATES:
        t = np.arange(int(length_s * sr)) / sr
        f0 = 440.0 * 2 ** ((pitch - 69) / 12)
        y = np.zeros_like(t)
        for h in range(1, 9):
            f = f0 * h * np.sqrt(1 + 0.0004 * h * h)  # slight inharmonicity
            if f > sr / 2 - 500:
                break
            decay = 0.6 + 0.004 * f0 + 0.5 * h  # higher notes / partials die faster
            y += (1.0 / h ** 1.2) * np.sin(2 * np.pi * f * t) * np.exp(-decay * t)
        y *= np.minimum(1, t / 0.004)
        y /= np.abs(y).max() + 1e-9
        _TEMPLATES[key] = y.astype(np.float32)
    return _TEMPLATES[key]


def synth(notes: NoteArr, duration: float, sr: int = SR) -> np.ndarray:
    """Simple additive piano-like rendering (enough for chroma / alignment features)."""
    out = np.zeros(int(duration * sr) + sr, np.float32)
    rel = int(0.08 * sr)
    for a, b, p, v in zip(notes.onset, notes.offset, notes.pitch, notes.vel):
        if p < 12 or p > 120 or a >= duration:
            continue
        tpl = _template(int(p), sr)
        i0 = int(max(0, a) * sr)
        n = min(len(tpl), int((b - a) * sr) + rel, len(out) - i0)
        if n <= 0:
            continue
        seg = tpl[:n] * (0.2 + 0.8 * float(v))
        if n > rel:
            seg[-rel:] *= np.linspace(1, 0, rel, dtype=np.float32)
        out[i0:i0 + n] += seg
    peak = np.abs(out).max()
    return out / peak if peak > 0 else out


# ----------------------------------------------------------------------------- features

def chroma(y: np.ndarray, sr: int = SR, hop: int = 1024) -> np.ndarray:
    """CQT chroma (12 x T), each frame L2-normalised (silent frames -> 0)."""
    import librosa

    c = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop, norm=None, n_chroma=12, bins_per_octave=36)
    c = np.log1p(100 * c / (c.max() + 1e-9))
    n = np.linalg.norm(c, axis=0, keepdims=True)
    return np.where(n > 1e-6, c / np.maximum(n, 1e-9), 0)


def semitone_spec(y: np.ndarray, sr: int = SR, hop: int = 256, fmin_midi: int = 21, n: int = 88) -> np.ndarray:
    """Log-compressed CQT magnitude with one bin per semitone (n x T)."""
    import librosa

    C = np.abs(librosa.cqt(y, sr=sr, hop_length=hop, fmin=librosa.midi_to_hz(fmin_midi), n_bins=n * 3, bins_per_octave=36))
    C = C.reshape(n, 3, -1).max(axis=1)
    return np.log1p(1000 * C / (C.max() + 1e-9))


def onset_chroma(y: np.ndarray, sr: int = SR, hop: int = 1024) -> np.ndarray:
    """Locally-adaptive onset features folded to chroma (Ewert et al. 2009 'DLNCO'-style)."""
    from scipy.ndimage import maximum_filter1d

    sub = 4
    S = semitone_spec(y, sr, hop // sub)
    d = np.maximum(0, np.diff(S, axis=1, prepend=S[:, :1]))
    # local normalisation per pitch
    d = d / (maximum_filter1d(d, size=int(3 * sr / (hop // sub)), axis=1) + 1e-3)
    T = d.shape[1] // sub
    d = d[:, : T * sub].reshape(d.shape[0], T, sub).max(axis=2)
    oc = np.zeros((12, T))
    for i in range(d.shape[0]):
        oc[(i + 21) % 12] += d[i]
    # decaying smear so that onset evidence persists a few frames
    for t in range(1, T):
        oc[:, t] = np.maximum(oc[:, t], oc[:, t - 1] * 0.6)
    nrm = np.linalg.norm(oc, axis=0, keepdims=True)
    return np.where(nrm > 1e-6, oc / np.maximum(nrm, 1e-9), 0)


def notes_chroma(notes: NoteArr, n_frames: int, hop_s: float) -> np.ndarray:
    """Pitch-class activation from notes (12 x T), L2-normalised per frame."""
    c = np.zeros((12, n_frames))
    for a, b, p, v in zip(notes.onset, notes.offset, notes.pitch, notes.vel):
        i0, i1 = int(a / hop_s), int(np.ceil(b / hop_s))
        i0, i1 = max(0, i0), min(n_frames, max(i1, i0 + 1))
        c[int(p) % 12, i0:i1] += 0.3 + 0.7 * v
    n = np.linalg.norm(c, axis=0, keepdims=True)
    return np.where(n > 1e-6, c / np.maximum(n, 1e-9), 0)


# ----------------------------------------------------------------------------- DTW

def _banded_dtw_numba():
    import numba

    @numba.njit(cache=True)
    def run(A, B, const, lo, hi):
        # cost(i, j) = const - <A[:, i], B[:, j]>; banded storage: row i holds columns lo[i] .. hi[i]-1 at offsets 0..W-1
        N = A.shape[1]
        d = A.shape[0]
        W = 0
        for i in range(N):
            W = max(W, hi[i] - lo[i])
        inf = 1e18
        D = np.full((N, W), inf)
        S = np.zeros((N, W), np.int8)

        def get(i, j):
            if i < 0 or j < lo[i] or j >= hi[i]:
                return inf
            return D[i, j - lo[i]]

        for i in range(N):
            for j in range(lo[i], hi[i]):
                c = const
                for k in range(d):
                    c -= A[k, i] * B[k, j]
                if i == 0 and j == 0:
                    D[i, 0 - lo[0]] = c
                    continue
                best = inf
                step = 0
                v = get(i - 1, j - 1) + 2 * c
                if v < best:
                    best = v
                    step = 0
                v = get(i - 1, j) + c
                if v < best:
                    best = v
                    step = 1
                v = get(i, j - 1) + c
                if v < best:
                    best = v
                    step = 2
                D[i, j - lo[i]] = best
                S[i, j - lo[i]] = step
        i, j = N - 1, hi[N - 1] - 1
        path = []
        while i > 0 or j > 0:
            path.append((i, j))
            s = S[i, j - lo[i]]
            if s == 0:
                i -= 1
                j -= 1
            elif s == 1:
                i -= 1
            else:
                j -= 1
        path.append((0, 0))
        return get(N - 1, hi[N - 1] - 1), path

    return run


_DTW = None


def dtw_path(A: np.ndarray, B: np.ndarray, const: float, lo: np.ndarray | None = None, hi: np.ndarray | None = None) -> np.ndarray:
    """DTW between feature sequences A (d x N) and B (d x M) with local cost const - <a_i, b_j>
    (cosine distance for normalised features) and steps (1,1)x2, (1,0), (0,1). Optional per-row
    column band [lo, hi) — memory is O(N * band). Returns the path as (K, 2) array, start→end."""
    global _DTW
    if _DTW is None:
        _DTW = _banded_dtw_numba()
    N, M = A.shape[1], B.shape[1]
    if lo is None:
        lo = np.zeros(N, np.int64)
        hi = np.full(N, M, np.int64)
    _, path = _DTW(np.ascontiguousarray(A, dtype=np.float64), np.ascontiguousarray(B, dtype=np.float64), float(const),
                   lo.astype(np.int64), hi.astype(np.int64))
    return np.array(path[::-1])


def cosine_cost(A: np.ndarray, B: np.ndarray) -> np.ndarray:
    """1 - cosine similarity between columns of already-normalised A (d x N) and B (d x M)."""
    return 1 - A.T @ B


# ----------------------------------------------------------------------------- melody helpers

def midi_to_hz(m):
    return 440.0 * 2 ** ((np.asarray(m, float) - 69) / 12)


def top_line_f0(notes: NoteArr, times: np.ndarray, hand: str | None = "R", mode: str = "top") -> np.ndarray:
    """Frame-wise f0 (Hz, 0 = unvoiced) of the highest (mode='top') or lowest (mode='bottom')
    sounding note of `hand` (None = any hand) at each time."""
    sel = notes if hand is None else notes.select(notes.hand == hand)
    f = np.zeros(len(times))
    best = np.full(len(times), -1 if mode == "top" else 999)
    for a, b, p in zip(sel.onset, sel.offset, sel.pitch):
        i0, i1 = np.searchsorted(times, a), np.searchsorted(times, b)
        if mode == "top":
            m = best[i0:i1] < p
        else:
            m = best[i0:i1] > p
        best[i0:i1][m] = p
    voiced = (best >= 0) & (best < 999)
    f[voiced] = midi_to_hz(best[voiced])
    return f
