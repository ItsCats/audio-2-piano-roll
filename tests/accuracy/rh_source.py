"""
Where does the Easy right hand come from when it is NOT the singer?

    server/.venv/bin/python tests/accuracy/rh_source.py WORK_DIR OUT.json song_id [song_id ...]

Needs WORK_DIR/refs/vocal/<id>.vocals.f0.npz and WORK_DIR/transcriptions/<id>.mix.json,
<id>.vocals.mix.json, <id>.accomp-nodrums.mix.json (app run on the Demucs stems). For each 10 ms frame
it classifies the Easy right-hand top note as vocal pitch class / other, and for "other" frames checks
whether that pitch class is sounding in the transcription of the accompaniment stem (vs chance =
average share of the 12 pitch classes sounding there).
"""
import os, sys, json, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from acclib import NoteArr, top_line_f0
work, out_path, ids = sys.argv[1], sys.argv[2], sys.argv[3:]
os.chdir(work)
res = {}
for s in ids:
    d = np.load(f'refs/vocal/{s}.vocals.f0.npz'); t, vf = d['times'], d['f0']
    tr = json.load(open(f'transcriptions/{s}.mix.json'))
    easy = NoteArr.from_list(tr['easy']); acc = NoteArr.from_list(json.load(open(f'transcriptions/{s}.accomp-nodrums.mix.json'))['base'])
    voc = NoteArr.from_list(json.load(open(f'transcriptions/{s}.vocals.mix.json'))['base'])
    ef = top_line_f0(easy, t, 'R')
    em = np.where(ef > 0, np.round(69 + 12 * np.log2(np.maximum(ef, 1) / 440)), -1).astype(int)
    vm = np.where(vf > 0, np.round(69 + 12 * np.log2(np.maximum(vf, 1) / 440)), -1).astype(int)
    def sounding_pc(notes):
        pcs = np.zeros((len(t), 12), bool)
        for a, b, p in zip(notes.onset, notes.offset, notes.pitch):
            i0, i1 = np.searchsorted(t, a), np.searchsorted(t, b); pcs[i0:i1, p % 12] = True
        return pcs
    apc = sounding_pc(acc); vpc = sounding_pc(voc)
    rh = em >= 0; sung = vm >= 0
    match_voc = rh & sung & ((em - vm) % 12 == 0)
    other = rh & ~match_voc
    idx = np.where(other)[0]
    in_acc = apc[idx, em[idx] % 12].mean() if len(idx) else None
    chance_acc = float(apc[idx].sum(1).mean() / 12) if len(idx) else None
    in_vocstem = vpc[idx, em[idx] % 12].mean() if len(idx) else None
    res[s] = {'sungFrames': int(sung.sum()), 'easyRHFrames': int(rh.sum()),
              'sungAndRHisVocalPC': round(float(match_voc.sum() / max(1, sung.sum())), 3),
              'sungButRHsilent': round(float((sung & ~rh).sum() / max(1, sung.sum())), 3),
              'sungAndRHotherPC': round(float((sung & rh & ~match_voc).sum() / max(1, sung.sum())), 3),
              'RHnotVocal_shareOfRHframes': round(float(other.sum() / max(1, rh.sum())), 3),
              'RHnotVocal_pitchClassSoundingInAccompStemTranscription': round(float(in_acc), 3) if in_acc is not None else None,
              'chance_randomPitchClassSoundingInAccomp': round(chance_acc, 3) if chance_acc is not None else None,
              'RHnotVocal_pitchClassSoundingInVocalStemTranscription': round(float(in_vocstem), 3) if in_vocstem is not None else None,
              'RHnotVocal_whileSingerSilent': round(float((other & ~sung).sum() / max(1, other.sum())), 3)}
print(json.dumps(res, indent=1))
json.dump(res, open(out_path, 'w'), indent=1)
