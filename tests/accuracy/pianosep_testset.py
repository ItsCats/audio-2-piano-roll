"""Piano + singing test set for "Remove singing and drums" (Piano solo): MAESTRO test-split excerpts with
exact MIDI, mixed with the separated singing (and drums, bass, guitar and other stems) of sung songs.
Everything is read from and written to paths OUTSIDE the repo (the songs are copyrighted; MAESTRO is
CC BY-NC-SA, local evaluation only).

  python -I tests/accuracy/pianosep_testset.py CONFIG.json OUTDIR

CONFIG.json (local):
  {"seconds": 60,
   "pieces": [{"id": "m-bach-bwv850", "wav": ".../maestro/m-bach-bwv850.wav", "midi": ".../m-bach-bwv850.midi",
               "start": 10, "stems": ".../stems/<song id>", "f0": ".../refs/vocal/<song id>.vocals.f0.npz",
               "song": "vocal-1", "avoid": []}, ...]}
  stems: a folder with vocals/drums/bass/guitar/other.wav (htdemucs_6s, tests/accuracy/separate.py); f0: the
  song's vocal pitch track (vocal_ref.py); avoid: start times (s) of windows already used for the same song.

Writes OUTDIR/<piece>.<cond>.wav (44.1 kHz stereo 16-bit), OUTDIR/<piece>.ref.json (MIDI notes of the
excerpt), OUTDIR/<piece>.vocal.f0.json (the singer's pitch track in the window) and OUTDIR/manifest.json.
Conditions per piece:
  clean        piano alone (the ceiling)
  v-6/v0/v+6   piano + singing at -6 / 0 / +6 dB vs the piano (active RMS)
  vdb0         singing at 0 dB + the song's drums and bass (the song's own balance)
  full0        vdb0 + the song's guitar and other stems (a full band, without the song's own piano)
"""
import json
import os
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from acclib import midi_notes  # noqa: E402

SR = 44100


def load(path, start=0.0, dur=None):
    cmd = ['ffmpeg', '-v', 'error', '-ss', str(start)] + (['-t', str(dur)] if dur else []) + ['-i', path, '-f', 'f32le', '-ac', '2', '-ar', str(SR), '-']
    return np.frombuffer(subprocess.run(cmd, check=True, capture_output=True).stdout, np.float32).copy().reshape(-1, 2).T


def frame_pow(x, hop=4410):
    m = x.mean(0)
    n = len(m) // hop
    return (m[: n * hop].reshape(n, hop) ** 2).mean(1)


def active_rms(x, floor_db=30):
    p = frame_pow(x)
    if p.max() <= 0:
        return 0.0
    return float(np.sqrt(p[p > p.max() * 10 ** (-floor_db / 10)].mean()))


def best_window(vox, seg, avoid=()):
    """start (s) of the `seg` window with the most sung 100 ms frames (within 25 dB of the stem's loud frames)"""
    p = frame_pow(vox)
    on = (p > np.percentile(p, 95) * 10 ** (-25 / 10)).astype(float)
    w = int(seg * 10)
    c = np.convolve(on, np.ones(w), 'valid')
    for a in avoid:
        c[max(0, int(a * 10) - w + 1): int(a * 10) + w] = -1
    i = int(np.argmax(c))
    return i / 10.0, float(c[i] / w)


def write(path, x):
    s16 = (np.clip(x, -1, 1).T * 32767).round().astype('<i2').tobytes()
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 's16le', '-ac', '2', '-ar', str(SR), '-i', '-', '-c:a', 'pcm_s16le', path], input=s16, check=True)


def main(config, out):
    cfg = json.load(open(config))
    seg = float(cfg.get('seconds', 60))
    os.makedirs(out, exist_ok=True)
    manifest = []
    for pc in cfg['pieces']:
        pid, t0 = pc['id'], float(pc['start'])
        piano = load(pc['wav'], t0, seg)
        n = piano.shape[1]
        ref = midi_notes(pc['midi'], pedal_extend=False)
        m = (ref.onset >= t0) & (ref.onset < t0 + seg - 0.05)
        notes = [{'midi': int(p), 'start': round(float(a - t0), 4), 'dur': round(float(min(b, t0 + seg) - a), 4)} for a, b, p in zip(ref.onset[m], ref.offset[m], ref.pitch[m])]
        json.dump({'piece': pid, 'start': t0, 'seconds': seg, 'notes': notes}, open(f'{out}/{pid}.ref.json', 'w'))
        ws, frac = best_window(load(f"{pc['stems']}/vocals.wav"), seg, pc.get('avoid', ()))
        st = {k: load(f"{pc['stems']}/{k}.wav", ws, seg)[:, :n] for k in ('vocals', 'drums', 'bass', 'guitar', 'other')}
        st = {k: np.pad(v, ((0, 0), (0, n - v.shape[1]))) for k, v in st.items()}
        f0 = np.load(pc['f0'])
        sel = (f0['times'] >= ws) & (f0['times'] < ws + seg)
        json.dump({'times': (f0['times'][sel] - ws).round(4).tolist(), 'f0': f0['f0'][sel].round(2).tolist()}, open(f'{out}/{pid}.vocal.f0.json', 'w'))
        g0 = active_rms(piano) / active_rms(st['vocals'])
        items = {'clean': piano, 'v-6': piano + g0 * 10 ** (-6 / 20) * st['vocals'], 'v0': piano + g0 * st['vocals'], 'v+6': piano + g0 * 10 ** (6 / 20) * st['vocals']}
        items['vdb0'] = piano + g0 * (st['vocals'] + st['drums'] + st['bass'])
        items['full0'] = items['vdb0'] + g0 * (st['guitar'] + st['other'])
        for cond, x in items.items():
            peak = float(np.abs(x).max())
            gain = 0.95 / peak if peak > 0.95 else 1.0
            write(f'{out}/{pid}.{cond}.wav', x * gain)
            manifest.append({'item': f'{pid}.{cond}', 'piece': pid, 'cond': cond, 'song': pc.get('song'), 'vocalWindow': ws, 'vocalActiveFrac': round(frac, 3), 'mixGain': round(gain, 3)})
            print(f'{pid}.{cond}', f'window {ws:.1f}s ({frac:.2f} sung)', f'gain {gain:.2f}')
    json.dump(manifest, open(f'{out}/manifest.json', 'w'), indent=1)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
