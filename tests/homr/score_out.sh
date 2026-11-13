#!/bin/bash
# Scores MusicXML outputs OUT/<category>/*.musicxml against the OMR test set's ground truth.
# usage: score_out.sh OUT   env: SPIKE (OMR spike directory; its venv has music21 + mido)
set -e
OUT=$1
SPIKE=${SPIKE:?set SPIKE}
PY=${M21:-$SPIKE/venv/bin/python}
for cat in clean clean_real photo photo_real; do
  [ -d "$OUT/$cat" ] || continue
  # score_dir.py counts a page without output as 0 if its image is in the directory
  for f in "$SPIKE"/testset/$cat/*.png "$SPIKE"/testset/$cat/*.jpg; do [ -e "$f" ] && [ ! -e "$OUT/$cat/$(basename "$f")" ] && ln -s "$f" "$OUT/$cat/$(basename "$f")"; done
  "$PY" -I "$SPIKE"/scripts/score_dir.py "$OUT/$cat" "$OUT/$cat.jsonl"
done
"$PY" -I "$SPIKE"/scripts/summ.py "$OUT"/*.jsonl
