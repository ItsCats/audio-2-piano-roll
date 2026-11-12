#!/bin/bash
# Measure the high-accuracy piano model engine (piano specialist) next to Basic Pitch, strictly
# one job at a time (shared 4-core machine: never two browser model runs at once).
#
#   WORK=/path/outside/repo RECORDINGS="a.mp3 b.mp3" [APP=snapshot dir] [PY=python] [PTI_CKPT=pti.pth] [ONE_THREAD=1] \
#     bash tests/accuracy/run_specialist.sh
#
# WORK must hold maestro/m-*.wav + .midi (fetch_maestro.py) and, for the parity check, refs/pti/<id>.pti.json
# (pti_transcribe.py; with PTI_CKPT set, missing ones are made first, ≈ 7 min per piece on 4 cores).
# RECORDINGS = other solo-piano recordings (by path; copyrighted ones stay outside the repository).
# APP = the checkout to measure (default: this one). Measure a frozen snapshot when the tree is being
# edited: git archive HEAD | tar -x -C SNAP && ln -s "$PWD/node_modules" SNAP/node_modules.
#
# Steps (each with a timeout; a failed step is logged and the next one runs):
#   1. PTI_CKPT set: the Python reference for pieces that have none yet
#   2. Basic Pitch "Piano solo" + "Sensitive" on every file (≈ 7 s per audio minute)
#   3. the specialist, cross-origin isolated page (WASM threads = the desktop app), fresh tab per file
#   4. ONE_THREAD=1: the specialist on the first MAESTRO piece without isolation (one thread: Safari,
#      and pages that are not cross-origin isolated)
#   5. evaluate.py (unchanged scoring) and specialist_eval.py (headline: MAESTRO test split, exact MIDI)
# Outputs: WORK/specialist/<id>.<preset>.json, WORK/specialist-1thread/, WORK/eval/specialist{,_eval}.{json,md}
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
APP=${APP:-$(cd "$HERE/../.." && pwd)}
: "${WORK:?set WORK to the measurement directory (outside the repository)}"
[ -x "$APP/server/.venv/bin/python" ] && PY=${PY:-$APP/server/.venv/bin/python}
PY=${PY:-python3}  # needs numpy, librosa, mir_eval, pretty_midi (+ torch, piano_transcription_inference for PTI_CKPT)
mkdir -p "$WORK"
case "$(cd "$WORK" && pwd)/" in "$APP"/*) echo "WORK must be outside the repository" >&2; exit 2 ;; esac
T=$APP/tests/accuracy
OUT=$WORK/specialist
mkdir -p "$OUT" "$WORK/eval" "$WORK/vitecache-specialist"
export ACC_VITE_CACHE=$WORK/vitecache-specialist
MAESTRO=$(ls "$WORK"/maestro/m-*.wav)
FILES="$MAESTRO ${RECORDINGS:-}"
log() { echo "== $* ($(date '+%F %T'))"; }

cd "$APP" || exit 2
log "code under test: $(git -C "$APP" rev-parse --short HEAD 2>/dev/null || echo snapshot) in $APP"

if [ -n "${PTI_CKPT:-}" ]; then
  log "1/5 Python reference (pti_transcribe.py) for pieces without one"
  PTI_THREADS=4 nice timeout 7200 "$PY" "$T/pti_transcribe.py" "$PTI_CKPT" "$WORK/refs/pti" $FILES || log "pti_transcribe failed ($?)"
fi

log "2/5 Basic Pitch piano,sensitive"
nice timeout 5400 node "$T/transcribe.mjs" --coi --presets piano,sensitive --out "$OUT" --port 5311 --timeout-min 10 $FILES || log "Basic Pitch runs failed ($?)"

log "3/5 specialist (cross-origin isolated, WASM threads)"
nice timeout 10800 node "$T/transcribe.mjs" --coi --presets specialist --out "$OUT" --port 5311 --timeout-min 20 $FILES || log "specialist runs failed ($?)"

if [ "${ONE_THREAD:-0}" = 1 ]; then
  log "4/5 specialist single-threaded (not isolated) on one piece"
  FIRST=$(echo "$MAESTRO" | head -1)
  nice timeout 3600 node "$T/transcribe.mjs" --presets specialist --out "$WORK/specialist-1thread" --port 5311 --timeout-min 40 "$FIRST" || log "single-thread run failed ($?)"
fi

log "5/5 scoring"
nice timeout 5400 "$PY" "$T/evaluate.py" --work "$WORK" --trans "$OUT" --out "$WORK/eval/specialist" $FILES || log "evaluate.py failed ($?)"
nice timeout 3600 "$PY" "$T/specialist_eval.py" --work "$WORK" --trans "$OUT" --out "$WORK/eval/specialist_eval" $FILES || log "specialist_eval.py failed ($?)"
log "done: $WORK/eval/specialist_eval.md"
