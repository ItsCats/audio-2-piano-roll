#!/usr/bin/env python3
"""
Builds the web-ready piano sample library served from public/samples/.

Sources (download separately, see docs/AUDIO_ENGINE.md):
  * Salamander Grand Piano V3 (Yamaha C5, 44.1kHz/16-bit, CC-BY 3.0, Alexander Holm)
  * Upright Piano KW small (CC0, freepats.zenvoid.org)

What it does
  * picks 5 of Salamander's 16 velocity layers (pp .. ff) for each of the 30
    minor-third sample points, plus the chromatic release (damper) noises and
    pedal noises,
  * trims leading silence so every sample's attack starts at t=0 (keeps
    note-on latency consistent), shortens tails by register with a smooth
    exponential fade, and
  * encodes stereo VBR MP3 (decodable in every browser incl. Safari),
  * writes a JSON manifest the audio engine reads at runtime.

Usage:
  python3 scripts/build-samples.py <salamander_dir> <upright_dir> <out_dir>
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import wave

import numpy as np

SAL_LAYERS = [2, 6, 9, 12, 15]          # Salamander layer numbers we keep
# Nominal MIDI velocity represented by each kept layer (centre of the SFZ lovel/hivel range)
SAL_LAYER_VEL = {2: 31, 6: 49, 9: 69, 12: 93, 15: 117}
NOTE_NAMES = {'C': 0, 'C#': 1, 'D': 2, 'D#': 3, 'E': 4, 'F': 5, 'F#': 6, 'G': 7, 'G#': 8, 'A': 9, 'A#': 10, 'B': 11}


def name_to_midi(name: str) -> int:
    m = re.match(r'^([A-G]#?)(-?\d)$', name)
    if not m:
        raise ValueError(name)
    return NOTE_NAMES[m.group(1)] + (int(m.group(2)) + 1) * 12


def safe_name(name: str) -> str:
    return name.replace('#', 's')


def read_audio(path: str) -> tuple[np.ndarray, int]:
    """Decode any audio file to float32 stereo using ffmpeg."""
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
        tmp_path = tmp.name
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', path, '-ac', '2', '-ar', '44100',
                    '-c:a', 'pcm_s16le', tmp_path], check=True)
    with wave.open(tmp_path) as w:
        sr = w.getframerate()
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    os.unlink(tmp_path)
    return data.reshape(-1, 2), sr


def max_len_for(midi: int) -> float:
    """How many seconds of natural decay to keep per register."""
    if midi <= 40: return 14.0
    if midi <= 55: return 11.0
    if midi <= 67: return 9.0
    if midi <= 79: return 7.0
    if midi <= 91: return 4.5
    return 3.0


def process(data: np.ndarray, sr: int, max_len: float, onset_db: float = -62.0) -> np.ndarray:
    mono = np.abs(data).max(axis=1)
    thresh = 10 ** (onset_db / 20)
    idx = int(np.argmax(mono > thresh)) if (mono > thresh).any() else 0
    idx = max(0, idx - int(0.0015 * sr))       # keep 1.5ms of pre-attack
    data = data[idx:]
    n = min(len(data), int(max_len * sr))
    data = data[:n].copy()
    fade = min(n, int(min(1.5, max_len * 0.3) * sr))
    if fade > 0:
        curve = np.exp(-np.linspace(0, 6, fade)).astype(np.float32)
        data[n - fade:] *= curve[:, None]
    # drop trailing near-silence
    tail = np.abs(data).max(axis=1)
    last = np.nonzero(tail > 10 ** (-80 / 20))[0]
    if len(last):
        data = data[: last[-1] + 1]
    return data


def encode(data: np.ndarray, sr: int, out_path: str, quality: int = 5) -> None:
    pcm = (np.clip(data, -1, 1) * 32767).astype(np.int16)
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as tmp:
        tmp_path = tmp.name
    with wave.open(tmp_path, 'wb') as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', tmp_path, '-c:a', 'libmp3lame',
                    '-q:a', str(quality), out_path], check=True)
    os.unlink(tmp_path)


def build_salamander(src: str, out: str) -> dict:
    wav_dir = os.path.join(src, '44.1khz16bit')
    os.makedirs(os.path.join(out, 'grand'), exist_ok=True)
    names = sorted({m.group(1) for f in os.listdir(wav_dir) if (m := re.match(r'^([A-G]#?\d)v\d+\.wav$', f))},
                   key=name_to_midi)
    zones = []
    peak_ref = None
    for name in names:
        midi = name_to_midi(name)
        layers = []
        for layer in SAL_LAYERS:
            data, sr = read_audio(os.path.join(wav_dir, f'{name}v{layer}.wav'))
            data = process(data, sr, max_len_for(midi))
            fn = f'grand/{safe_name(name)}v{layer}.mp3'
            encode(data, sr, os.path.join(out, fn))
            layers.append({'vel': SAL_LAYER_VEL[layer], 'file': fn})
        zones.append({'midi': midi, 'layers': layers})
        print('grand', name, flush=True)
    # release (damper/hammer return) noises, chromatic
    release = []
    for i in range(1, 89):
        data, sr = read_audio(os.path.join(wav_dir, f'rel{i}.wav'))
        data = process(data, sr, 1.2, onset_db=-70)
        fn = f'grand/rel{i}.mp3'
        encode(data, sr, os.path.join(out, fn), quality=7)
        release.append({'midi': 20 + i, 'file': fn})
    pedal = {}
    for key, f, ln in (('down', 'pedalD1', 2.5), ('up', 'pedalU1', 0.8)):
        data, sr = read_audio(os.path.join(wav_dir, f'{f}.wav'))
        data = process(data, sr, ln, onset_db=-70)
        fn = f'grand/{f}.mp3'
        encode(data, sr, os.path.join(out, fn), quality=7)
        pedal[key] = fn
    return {
        'id': 'salamander',
        'name': 'Salamander Grand Piano V3 (Yamaha C5)',
        'license': 'CC-BY 3.0 — Alexander Holm',
        'zones': zones,
        'release': release,
        'releaseGainDb': -30,
        'pedal': pedal,
        'pedalGainDb': -22,
    }


def build_upright(src: str, out: str) -> dict:
    sample_dir = os.path.join(src, 'samples')
    os.makedirs(os.path.join(out, 'upright'), exist_ok=True)
    zones = []
    names = sorted({m.group(1) for f in os.listdir(sample_dir) if (m := re.match(r'^([A-G]#?\d)vH\.flac$', f))},
                   key=name_to_midi)
    for name in names:
        midi = name_to_midi(name)
        data, sr = read_audio(os.path.join(sample_dir, f'{name}vH.flac'))
        data = process(data, sr, max_len_for(midi) * 0.85)
        fn = f'upright/{safe_name(name)}.mp3'
        encode(data, sr, os.path.join(out, fn))
        zones.append({'midi': midi, 'layers': [{'vel': 96, 'file': fn}]})
        print('upright', name, flush=True)
    return {
        'id': 'upright-kw',
        'name': 'Upright Piano KW',
        'license': 'CC0 — freepats.zenvoid.org',
        'zones': zones,
        'release': [],
        'pedal': None,
    }


def main() -> None:
    sal, upright, out = sys.argv[1:4]
    os.makedirs(out, exist_ok=True)
    manifest = {'version': 1, 'libraries': [build_salamander(sal, out), build_upright(upright, out)]}
    with open(os.path.join(out, 'manifest.json'), 'w') as fh:
        json.dump(manifest, fh, indent=1)
    print('done')


if __name__ == '__main__':
    main()
