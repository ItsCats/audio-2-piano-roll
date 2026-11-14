"""Score tests/accuracy/pianosep.mjs runs ("Remove singing and drums", Piano solo).

  python -I tests/accuracy/pianosep_eval.py testset TESTSET RUNS [--json OUT.json]
      the piano + singing test set (pianosep_testset.py): onset F1 @ 50 ms (mir_eval, onset only), P, R per
      variant and condition, low-register (< MIDI 48) recall, wrong low notes per second, wrong notes at the
      singer's pitch per second (no reference match, the singer's pitch track within half a semitone over
      at least half the note), melody-role notes; the clean piano is the ceiling
  python -I tests/accuracy/pianosep_eval.py songs SONGDIR RUNS
      sung songs without a note reference (SONGDIR/<id>.vocal.f0.json, SONGDIR/meta.json {id: {seconds}}):
      notes per second, share of notes at the singer's pitch, low notes per second, melody-role notes
"""
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from acclib import NoteArr  # noqa: E402
from metrics import matched_pairs, note_prf  # noqa: E402

LOW = 48
VARIANTS = ['bp.mix', 'bp.sepNow', 'bp.part', 'spec.mix', 'spec.part']
CONDS = ['clean', 'v-6', 'v0', 'v+6', 'vdb0', 'full0']


def sung_mask(est: NoteArr, f0t, f0):
    out = np.zeros(len(est), bool)
    if not len(f0t):
        return out
    hop = float(np.median(np.diff(f0t)))
    midi_f0 = np.where(f0 > 0, 69 + 12 * np.log2(np.maximum(f0, 1e-6) / 440), np.nan)
    for k in range(len(est)):
        a, b = np.searchsorted(f0t, [est.onset[k], max(est.offset[k], est.onset[k] + hop)])
        if b > a:
            out[k] = np.nansum(np.abs(midi_f0[a:b] - est.pitch[k]) <= 0.5) >= 0.5 * (b - a)
    return out


def score(ref: NoteArr, est: NoteArr, dur: float, f0t, f0) -> dict:
    s = note_prf(ref, est, 0.05)
    m = matched_pairs(ref, est, 0.05)
    mr, me = {i for i, _ in m}, {j for _, j in m}
    low_ref = np.where(ref.pitch < LOW)[0]
    fp = np.array([j not in me for j in range(len(est))], bool)
    sung = sung_mask(est, f0t, f0) & fp if len(est) else np.zeros(0, bool)
    return {'f1': s['f1'], 'p': s['p'], 'r': s['r'], 'nEst': len(est), 'nRef': len(ref),
            'lowRecall': float(np.mean([i in mr for i in low_ref])) if len(low_ref) else float('nan'),
            'lowFpPerS': int(np.sum(fp & (est.pitch < LOW))) / dur if len(est) else 0.0,
            'fpPerS': int(fp.sum()) / dur, 'sungFpPerS': int(sung.sum()) / dur}


def testset(ts, runs, out_json):
    man = json.load(open(f'{ts}/manifest.json'))
    rows = []
    for m in man:
        p = f"{runs}/{m['item']}.json"
        if not os.path.exists(p):
            continue
        r = json.load(open(p))
        ref_d = json.load(open(f"{ts}/{m['piece']}.ref.json"))
        ref = NoteArr.from_list(ref_d['notes'])
        f0d = json.load(open(f"{ts}/{m['piece']}.vocal.f0.json")) if m['cond'] != 'clean' else {'times': [], 'f0': []}
        f0t, f0 = np.array(f0d['times']), np.array(f0d['f0'])
        row = {'item': m['item'], 'piece': m['piece'], 'cond': m['cond'], 'ms': r['ms'], 'peakMB': r.get('peakMB'), 'errors': r.get('errors')}
        for v in VARIANTS:
            if v in r['variants']:
                row[v] = score(ref, NoteArr.from_list(r['variants'][v]), ref_d['seconds'], f0t, f0)
                row[v]['melodyNotes'] = sum(1 for n in r['variants'][v] if n.get('role') == 'melody')
        rows.append(row)
    clean = {x['piece']: x for x in rows if x['cond'] == 'clean'}
    hdr = f"{'variant':12}" + ''.join(f'{c:>20}' for c in CONDS)
    print('mean onset F1@50 (P / R) over pieces [n]\n' + hdr)
    for v in VARIANTS:
        line = f'{v:12}'
        for c in CONDS:
            xs = [x[v] for x in rows if x['cond'] == c and v in x]
            line += f"{np.mean([x['f1'] for x in xs]):.3f} ({np.mean([x['p'] for x in xs]):.2f}/{np.mean([x['r'] for x in xs]):.2f})[{len(xs)}]".rjust(20) if xs else ' ' * 20
        print(line)
    for v in ('bp.mix', 'spec.mix'):
        line = f"ceiling {v.split('.')[0]:4}"
        for c in CONDS:
            xs = [clean[x['piece']][v]['f1'] for x in rows if x['cond'] == c and x['piece'] in clean and v in clean[x['piece']]]
            line += (f'{np.mean(xs):.3f}[{len(xs)}]'.rjust(20)) if xs else ' ' * 20
        print(line)
    for key in ('lowRecall', 'lowFpPerS', 'sungFpPerS', 'fpPerS', 'melodyNotes'):
        print(f'\n{key}\n{hdr}')
        for v in VARIANTS:
            line = f'{v:12}'
            for c in CONDS:
                xs = [x[v][key] for x in rows if x['cond'] == c and v in x and not np.isnan(x[v][key])]
                line += (f'{np.mean(xs):.3f}'.rjust(20)) if xs else ' ' * 20
            print(line)
    if out_json:
        json.dump(rows, open(out_json, 'w'), indent=1)


def songs(d, runs):
    meta = json.load(open(f'{d}/meta.json'))
    agg = {v: [] for v in VARIANTS}
    for sid, m in meta.items():
        p = f'{runs}/{sid}.json'
        if not os.path.exists(p):
            continue
        r = json.load(open(p))
        f0d = json.load(open(f'{d}/{sid}.vocal.f0.json'))
        f0t, f0 = np.array(f0d['times']), np.array(f0d['f0'])
        for v in VARIANTS:
            ns = r['variants'].get(v)
            if ns is None:
                continue
            est = NoteArr.from_list(ns)
            row = (len(est) / m['seconds'], 100 * float(sung_mask(est, f0t, f0).mean()) if len(est) else 0.0, float((est.pitch < LOW).sum()) / m['seconds'], sum(1 for n in ns if n.get('role') == 'melody'))
            agg[v].append(row)
            print(f'{sid:10} {v:10} notes/s {row[0]:5.2f}  at the singer {row[1]:5.1f} %  low/s {row[2]:4.2f}  melody {row[3]}')
    print('\nmean over songs')
    for v, rows in agg.items():
        if rows:
            a = np.mean(rows, 0)
            print(f'{v:10} notes/s {a[0]:.2f}  at the singer {a[1]:.1f} %  low/s {a[2]:.2f}  melody {a[3]:.0f}')


if __name__ == '__main__':
    mode = sys.argv[1]
    out = sys.argv[sys.argv.index('--json') + 1] if '--json' in sys.argv else None
    testset(sys.argv[2], sys.argv[3], out) if mode == 'testset' else songs(sys.argv[2], sys.argv[3])
