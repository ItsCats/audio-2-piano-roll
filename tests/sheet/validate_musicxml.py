"""Validates MusicXML written by tests/sheet/export.mjs (not part of `npm test`).

    python -m venv /path/to/scratch/venv && /path/to/scratch/venv/bin/pip install music21==9.9.1
    /path/to/scratch/venv/bin/python -I tests/sheet/validate_musicxml.py OUT_DIR [--xsd musicxml.xsd]

Checks, per NAME.musicxml + NAME.quant.json pair in OUT_DIR:
  - optional: `xmllint --noout --nonet --schema musicxml.xsd` (the official w3c/musicxml v4.0 XSD,
    downloaded outside the repo with its xml.xsd / xlink.xsd imports rewritten to local files);
  - music21 parses it as 2 staves; no voice in any measure is overfull or (voice 1) underfull;
  - round trip: every note onset (staff, MIDI, measure, offset in the measure; tie continuations
    skipped) matches our quantized notes exactly. Onsets are taken per measure, because music21
    shifts pickup measures inconsistently in its flattened offsets;
  - tied durations: each tie chain's total length is within one grid step of our note length.
Prints one line per file and exits 1 on any failure.
"""
import collections
import json
import os
import subprocess
import sys

from music21 import chord, converter, note, stream

args = sys.argv[1:]
xsd = None
if '--xsd' in args:
    i = args.index('--xsd')
    xsd = args[i + 1]
    del args[i:i + 2]
out_dir = args[0]
names = sorted(f[:-9] for f in os.listdir(out_dir) if f.endswith('.musicxml') and os.path.exists(os.path.join(out_dir, f[:-9] + '.quant.json')))
failed = False
GRID = {'easy': 0.5, 'medium': 0.25, 'hard': 0.25}

for name in names:
    xml_path = os.path.join(out_dir, name + '.musicxml')
    q = json.load(open(os.path.join(out_dir, name + '.quant.json')))
    problems = []
    if xsd:
        r = subprocess.run(['xmllint', '--noout', '--nonet', '--schema', xsd, xml_path], capture_output=True, text=True)
        if r.returncode != 0:
            problems.append('xsd: ' + r.stderr.strip().splitlines()[0][:200])
    s = converter.parse(xml_path, forceSource=True)
    parts = list(s.parts)
    if len(parts) != 2:
        problems.append(f'{len(parts)} staves')
    m_len = q['measureLenQ']
    pick = q['pickupQ']
    m_start = lambda i: (0 if i == 0 else pick + (i - 1) * m_len) if pick else i * m_len
    got = collections.Counter()
    events = []  # (staff, midi, abs, dur, tie)
    overfull = underfull = 0
    for staff, p in enumerate(parts, start=1):
        for i, m in enumerate(p.getElementsByClass(stream.Measure)):
            length = (pick if (pick and i == 0) else m_len)
            voices = list(m.voices) or [m]
            for vi, v in enumerate(voices):
                end = float(v.highestTime)
                if end > length + 1e-6:
                    overfull += 1
                if vi == 0 and end < length - 1e-6 and not (pick and i == 0):
                    underfull += 1
                for el in v.notes:
                    off = float(el.offset) + (float(v.offset) if v is not m else 0)
                    ps = [el.pitch] if isinstance(el, note.Note) else list(el.pitches)
                    tie = el.tie.type if el.tie is not None else None
                    for x in ps:
                        t = x.tie if isinstance(el, chord.Chord) and getattr(x, 'tie', None) is not None else el.tie
                        tt = t.type if t is not None else tie
                        events.append((staff, int(x.midi), m_start(i) + off, float(el.quarterLength), tt))
                        if tt not in ('stop', 'continue'):
                            got[(staff, int(x.midi), i, round(off * 12))] += 1
    exp = collections.Counter((n['staff'], n['midi'], n['measure'], round(n['offset'] * 12)) for n in q['notes'])
    miss = exp - got
    extra = got - exp
    if miss or extra:
        problems.append(f'onsets missing {sum(miss.values())} extra {sum(extra.values())} e.g. {list(miss.elements())[:2]} {list(extra.elements())[:2]}')
    if overfull:
        problems.append(f'{overfull} overfull')
    if underfull:
        problems.append(f'{underfull} underfull')
    # tie chains
    by_key = collections.defaultdict(list)
    for e in events:
        by_key[(e[0], e[1])].append(e)
    chains = {}
    for k, evs in by_key.items():
        evs.sort(key=lambda e: e[2])
        open_chains = []  # [start_abs, end_abs]
        for st, mi, a, d, tt in evs:
            if tt in ('stop', 'continue'):
                for c in open_chains:
                    if abs(c[1] - a) < 1e-6:
                        c[1] = a + d
                        if tt == 'stop':
                            open_chains.remove(c)
                        break
                continue
            c = [a, a + d]
            chains[(st, mi, round(a * 12))] = c
            if tt == 'start':
                open_chains.append(c)
    bad_dur = 0
    for n in q['notes']:
        c = chains.get((n['staff'], n['midi'], round((m_start(n['measure']) + n['offset']) * 12)))
        if c is None or abs((c[1] - c[0]) - n['dur']) > GRID[q['level']] + 1e-6:
            bad_dur += 1
    if bad_dur:
        problems.append(f'{bad_dur} tied durations off by more than a grid step')
    ok = not problems
    failed |= not ok
    print(f"{'PASS' if ok else 'FAIL'} {name}: {len(q['notes'])} notes, {q['measures']} measures" + ('' if ok else ' — ' + '; '.join(problems)))
sys.exit(1 if failed else 0)
