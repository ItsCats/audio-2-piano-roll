#!/bin/bash
# Reads the OMR test set with Python homr (homr_run.py) and model files of choice, then scores the
# notes (score_dir.py of the OMR spike: pitch F1 per page against the ground truth).
#
# usage: eval_python.sh OUT_DIR [--segnet F] [--encoder F] [--decoder F]
# env:   SPIKE (the OMR spike directory: testset/, scripts/, venv3/ with homr, m21venv for music21)
set -e
OUT=$1; shift
HERE=$(cd "$(dirname "$0")" && pwd)
SPIKE=${SPIKE:?set SPIKE to the OMR spike directory}
M21=${M21:-$SPIKE/../m21venv/bin/python}
for cat in clean clean_real photo photo_real; do
  imgs=$(ls "$SPIKE"/testset/$cat/*.png "$SPIKE"/testset/$cat/*.jpg 2>/dev/null || true)
  "$SPIKE"/venv3/bin/python -I "$HERE"/homr_run.py --out "$OUT/$cat" "$@" $imgs 2>&1 | grep -E "staffs [0-9]+ s=" || true
  "$M21" -I "$SPIKE"/scripts/score_dir.py "$OUT/$cat" "$OUT/$cat.jsonl"
done
"$M21" -I "$SPIKE"/scripts/summ.py "$OUT"/*.jsonl 2>/dev/null || cat "$OUT"/*.jsonl
