"""Note length of the high-accuracy piano model: "as played" notes + the pedal heard in the recording
(src/lib/music/noteLength.ts) scored against MAESTRO's exact performance MIDI (key-down / key-up
times and the sustain pedal, CC64). MAESTRO is CC BY-NC-SA 4.0: local evaluation only, nothing from it
goes into the repository.

    python -I tests/accuracy/notelen_eval.py --maestro DIR --est DIR [--before DIR] [--out DIR] PIECE [PIECE ...]

--est     the harness outputs of the current code (tests/accuracy/transcribe.mjs --presets specialist):
          DIR/<piece>.specialist.json with `base` (as played) and `pedal`
--before  optional: outputs of the code before the change (notes as heard, no `pedal`), same format
--maestro DIR/<piece>.midi (the performance MIDI)
Writes OUT/notelen_eval.json and OUT/notelen_eval.md (default: next to --est).

Per piece (whole recordings), for each method:
  onset F1          note F1, onset +-50 ms (must not change: onsets are not touched)
  on+off F1 key-up  mir_eval onset+offset F1 against the KEY-UP (offset within max(50 ms, 20 %))
  length            for onset-matched notes: median |length - key-held length|, share within 100 ms and
                    within 25 % of the key-held length
  held R / L        notes held at once per hand (mean over 10 ms frames where the hand holds any; the
                    app's hands; truth uses the same function on the key-held MIDI notes), share of
                    right-hand frames with 4 or more held (the owner's "6 notes held at once")
  pedal P / R / F   derived pedal-down frames against CC64 >= 64; pedal-up F: pedal-ups within 100 ms
  sound F           per-frame active-pitch F1 of (notes + pedal) played with the piano engine's damper
                    rules (a key let go under the pedal rings until the pedal-up or a re-strike), against
                    the notes as the model heard them ("vs model", needs --before) and against the true
                    sounding notes ("vs true sound")
Methods: "before" (notes as heard, no pedal), "before + automatic pedal" (today's Hard), "as played +
pedal from the recording" (the current code), and "as played + automatic pedal".
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile

import numpy as np
import pretty_midi
import mir_eval

FPS = 100
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))


def pedal_ranges(cc, end_time, thr=64):
    out, down = [], None
    for c in sorted(cc, key=lambda c: c.time):
        if c.number != 64:
            continue
        if c.value >= thr and down is None:
            down = c.time
        elif c.value < thr and down is not None:
            out.append((down, c.time))
            down = None
    if down is not None:
        out.append((down, end_time))
    return out


def sounding(on, keyup, pitch, pedal):
    """Ends under the pedal: a key let go while it is down rings to its end; a re-strike cuts it."""
    end = keyup.copy()
    for i in range(len(on)):
        for d, u in pedal:
            if d <= keyup[i] < u:
                end[i] = max(end[i], u)
                break
    order = np.lexsort((on, pitch))
    for a, b in zip(order[:-1], order[1:]):
        if pitch[a] == pitch[b] and end[a] > on[b]:
            end[a] = max(min(end[a], on[b]), min(keyup[a], on[b]))
    return end


def truth(midi_file, dur):
    pm = pretty_midi.PrettyMIDI(midi_file)
    notes = sorted((n for inst in pm.instruments for n in inst.notes), key=lambda n: (n.start, n.pitch))
    ped = pedal_ranges([c for inst in pm.instruments for c in inst.control_changes], pm.get_end_time() + 1)
    on = np.array([n.start for n in notes])
    ku = np.array([n.end for n in notes])
    p = np.array([n.pitch for n in notes])
    se = sounding(on, ku, p, ped)
    keep = on < dur
    return on[keep], np.minimum(ku[keep], dur), np.minimum(se[keep], dur), p[keep], [(d, min(u, dur)) for d, u in ped if d < dur]


def roll(on, off, pitch, n):
    r = np.zeros((n, 128), bool)
    for s, e, q in zip(on, off, pitch):
        a = int(round(s * FPS))
        b = max(a + 1, int(round(e * FPS)))
        r[a:min(b, n), int(q)] = True
    return r


def pedal_roll(pedal, n):
    r = np.zeros(n, bool)
    for d, u in pedal:
        r[int(round(d * FPS)):int(round(u * FPS))] = True
    return r


def prf(ref, est):
    tp = float((ref & est).sum())
    p = tp / max(1.0, float(est.sum()))
    r = tp / max(1.0, float(ref.sum()))
    return p, r, 2 * p * r / max(1e-9, p + r)


def hz(x):
    return 440.0 * 2 ** ((np.asarray(x, float) - 69) / 12)


def note_f1(ron, roff, rp, on, off, p, offsets):
    if not len(on):
        return 0.0
    _, _, f, _ = mir_eval.transcription.precision_recall_f1_overlap(
        np.c_[ron, ron + 1 if not offsets else roff], hz(rp), np.c_[on, np.maximum(off, on + 0.01) if offsets else on + 1], hz(p),
        onset_tolerance=0.05, offset_ratio=0.2 if offsets else None, offset_min_tolerance=0.05)
    return f


def held(on, off, hand, n):
    out = {}
    for h in 'LR':
        sel = hand == h
        cnt = np.zeros(n, int)
        for s, e in zip(on[sel], off[sel]):
            a = int(round(s * FPS))
            b = max(a + 1, int(round(e * FPS)))
            cnt[a:min(b, n)] += 1
        act = cnt[cnt > 0]
        out[h] = (float(act.mean()) if len(act) else 0.0, float((act >= 4).mean()) if len(act) else 0.0)
    return out


def ups_f(ref, est, tol=0.1):
    ref = np.array(ref)
    est = np.array(est)
    if not len(ref) or not len(est):
        return 0.0
    p = float(np.mean([np.min(np.abs(ref - e)) <= tol for e in est]))
    r = float(np.mean([np.min(np.abs(est - x)) <= tol for x in ref]))
    return 2 * p * r / max(1e-9, p + r)


def app(jobs):
    """The app's assignHands / autoPedal (tests/accuracy/notelen_hands.mjs)."""
    with tempfile.TemporaryDirectory() as d:
        i, o = os.path.join(d, 'in.json'), os.path.join(d, 'out.json')
        json.dump(jobs, open(i, 'w'))
        subprocess.run(['node', os.path.join(HERE, 'notelen_hands.mjs'), i, o], check=True, cwd=ROOT)
        return json.load(open(o))


def arrays(base):
    on = np.array([n['start'] for n in base])
    off = on + np.array([n['dur'] for n in base])
    return on, off, np.array([n['midi'] for n in base]), np.array([n['hand'] for n in base])


def score(t, on, off, p, hand, pedal, model_roll, n):
    ron, rku, rse, rp, rped, thand = t
    m = mir_eval.transcription.match_notes(np.c_[ron, ron + 1], hz(rp), np.c_[on, on + 1], hz(p), onset_tolerance=0.05, offset_ratio=None)
    m = np.array(m, int).reshape(-1, 2)
    inner = ron[m[:, 0]] < (n / FPS) - 7  # (notes cut at the end of the audio are not counted)
    ri, ei = m[inner, 0], m[inner, 1]
    kdur = rku[ri] - ron[ri]
    err = np.abs((off[ei] - on[ei]) - kdur)
    rend = sounding(on, off, p, pedal)
    rr = roll(on, rend, p, n)
    tr = pedal_roll(rped, n)
    hh = held(on, off, hand, n)
    return {
        'onF1': note_f1(ron, rku, rp, on, off, p, False),
        'onoffF1_keyup': note_f1(ron, rku, rp, on, off, p, True),
        'lenMedAbsErr': float(np.median(err)) if len(err) else float('nan'),
        'within100ms': float((err <= 0.1).mean()) if len(err) else float('nan'),
        'within25pct': float((err <= 0.25 * kdur).mean()) if len(err) else float('nan'),
        'heldR': hh['R'][0], 'heldL': hh['L'][0], 'R4': hh['R'][1],
        'pedal': list(prf(tr, pedal_roll(pedal, n))) if pedal else [0.0, 0.0, 0.0],
        'upsF': ups_f([u for _, u in rped if u < n / FPS - 0.5], [u for _, u in pedal if u < n / FPS - 0.5]),
        'soundVsModel': prf(model_roll, rr)[2] if model_roll is not None else None,
        'soundVsTrue': prf(roll(ron, rse, rp, n), rr)[2],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--maestro', required=True)
    ap.add_argument('--est', required=True)
    ap.add_argument('--before')
    ap.add_argument('--out')
    ap.add_argument('pieces', nargs='+')
    a = ap.parse_args()
    out_dir = a.out or a.est
    rows = {}
    for piece in a.pieces:
        est = json.load(open(os.path.join(a.est, f'{piece}.specialist.json')))
        dur = float(est['duration'])
        n = int(round(dur * FPS))
        ron, rku, rse, rp, rped = truth(os.path.join(a.maestro, f'{piece}.midi'), dur)
        jobs = [{'op': 'hands', 'notes': [{'midi': int(q), 'start': float(s), 'dur': float(max(0.01, e - s))} for s, e, q in zip(ron, rku, rp)], 'duration': dur}]
        on, off, p, hand = arrays(est['base'])
        pedal = [(x['start'], x['end']) for x in est.get('pedal') or []]
        before = None
        if a.before:
            b = json.load(open(os.path.join(a.before, f'{piece}.specialist.json')))
            before = arrays(b['base'])
            jobs.append({'op': 'autopedal', 'notes': [{'midi': int(q), 'start': float(s), 'dur': float(e - s), 'hand': h} for s, e, q, h in zip(*before)], 'bpm': b['tempo']['bpm'], 'duration': dur})
        jobs.append({'op': 'autopedal', 'notes': [{'midi': int(q), 'start': float(s), 'dur': float(e - s), 'hand': h} for s, e, q, h in zip(on, off, p, hand)], 'bpm': est['tempo']['bpm'], 'duration': dur})
        res = app(jobs)
        thand = np.array(res[0])
        t = (ron, rku, rse, rp, rped, thand)
        r = rows.setdefault(piece, {})
        th, ts = held(ron, rku, thand, n), held(ron, rse, thand, n)
        r['truth'] = {'heldR': th['R'][0], 'heldL': th['L'][0], 'R4': th['R'][1], 'soundingHeldR': ts['R'][0], 'soundingHeldL': ts['L'][0], 'soundingR4': ts['R'][1], 'pedalShare': float(pedal_roll(rped, n).mean())}
        model_roll = None
        if before is not None:
            bo, be, bp, bh = before
            model_roll = roll(bo, be, bp, n)
            same = len(bo) == len(on) and np.array_equal(bp, p) and np.allclose(bo, on) and np.array_equal(bh, hand)
            r['onsetsIdentical'] = bool(same)
            r['before'] = score(t, bo, be, bp, bh, [], model_roll, n)
            r['before + automatic pedal'] = score(t, bo, be, bp, bh, [(x['start'], x['end']) for x in res[1]], model_roll, n)
        r['as played + pedal from the recording'] = score(t, on, off, p, hand, pedal, model_roll, n)
        r['as played + automatic pedal'] = score(t, on, off, p, hand, [(x['start'], x['end']) for x in res[-1]], model_roll, n)
        r['levels'] = {d: len(est[d]) / dur for d in ('easy', 'medium', 'hard')}
        print(piece, 'done', file=sys.stderr)
    os.makedirs(out_dir, exist_ok=True)
    json.dump(rows, open(os.path.join(out_dir, 'notelen_eval.json'), 'w'), indent=1)
    open(os.path.join(out_dir, 'notelen_eval.md'), 'w').write(report(rows))
    print(report(rows))


def report(rows):
    pieces = list(rows)
    mean = lambda f: float(np.mean([f(rows[q]) for q in pieces]))
    lines = [f'Pieces: {", ".join(pieces)} (whole recordings; means over pieces)', '']
    lines.append(f"truth: key held R/L {mean(lambda r: r['truth']['heldR']):.2f} / {mean(lambda r: r['truth']['heldL']):.2f}, R >= 4 held {mean(lambda r: r['truth']['R4']):.0%}; "
                 f"sounding R/L {mean(lambda r: r['truth']['soundingHeldR']):.2f} / {mean(lambda r: r['truth']['soundingHeldL']):.2f}, R >= 4 {mean(lambda r: r['truth']['soundingR4']):.0%}; pedal down {mean(lambda r: r['truth']['pedalShare']):.0%}")
    if all('onsetsIdentical' in rows[q] for q in pieces):
        lines.append(f"onsets, pitches, velocities and hands identical to before on {sum(rows[q]['onsetsIdentical'] for q in pieces)}/{len(pieces)} pieces")
    lines += ['', '| method | onset F1 | on+off F1 (key-up) | length median abs err | within 100 ms | within 25 % | held R / L | R >= 4 held | pedal-down P / R / F | pedal-up F | sound F vs model | sound F vs true sound |', '|' + '---|' * 12]
    methods = [m for m in ('before', 'before + automatic pedal', 'as played + pedal from the recording', 'as played + automatic pedal') if all(m in rows[q] for q in pieces)]
    for m in methods:
        g = lambda k: mean(lambda r: r[m][k])
        sv = '-' if rows[pieces[0]][m]['soundVsModel'] is None else f"{g('soundVsModel'):.3f}"
        pd = [mean(lambda r: r[m]['pedal'][i]) for i in range(3)]
        lines.append(f"| {m} | {g('onF1'):.3f} | {g('onoffF1_keyup'):.3f} | {g('lenMedAbsErr') * 1000:.0f} ms | {g('within100ms'):.0%} | {g('within25pct'):.0%} | {g('heldR'):.2f} / {g('heldL'):.2f} | {g('R4'):.0%} | "
                     f"{pd[0]:.2f} / {pd[1]:.2f} / {pd[2]:.2f} | {g('upsF'):.2f} | {sv} | {g('soundVsTrue'):.3f} |")
    lines += ['', '| piece | held R before -> after (truth) | R >= 4 before -> after (truth) | on+off F1 key-up before -> after | pedal-down F | sound F vs model |', '|---|---|---|---|---|---|']
    A = 'as played + pedal from the recording'
    for q in pieces:
        r = rows[q]
        b = r.get('before')
        lines.append(f"| {q} | {b['heldR'] if b else float('nan'):.2f} -> {r[A]['heldR']:.2f} ({r['truth']['heldR']:.2f}) | {b['R4'] if b else float('nan'):.0%} -> {r[A]['R4']:.0%} ({r['truth']['R4']:.0%}) | "
                     f"{b['onoffF1_keyup'] if b else float('nan'):.3f} -> {r[A]['onoffF1_keyup']:.3f} | {r[A]['pedal'][2]:.2f} | {r[A]['soundVsModel'] if r[A]['soundVsModel'] is not None else float('nan'):.3f} |")
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    main()
