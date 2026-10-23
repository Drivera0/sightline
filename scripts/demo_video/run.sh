#!/usr/bin/env bash
# record -> captions -> cuts -> gif, into runs/video/<timestamp>/ (see README.md next to this file).
#
#   bash scripts/demo_video/run.sh                                   # demo-only flow, new run folder
#   bash scripts/demo_video/run.sh --out runs/video/20261022-1400    # finish (or redo nothing in) that run
#   bash scripts/demo_video/run.sh --live --serve-local              # + a live mission on a local API
#   bash scripts/demo_video/run.sh --live --api http://127.0.0.1:8000 [--mission <id>]
#   bash scripts/demo_video/run.sh --publish ...                     # also copy the GIF to docs/report/figures/demo.gif (<= 3 MB)
#   bash scripts/demo_video/run.sh --1440 ...                        # also the 2560x1440 program for the upload
#
# Idempotent: a run folder whose shots.json names a recording that is there (master_4k.mp4) is not
# re-recorded, and each later step is skipped when its output is newer than its inputs (FORCE=1 redoes
# them). Any other flag goes to record.py.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

publish=0
qhd=0
out=""
rec=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --publish) publish=1 ;;
    --1440) qhd=1 ;;
    --out) out="$2"; shift ;;
    *) rec+=("$1") ;;
  esac
  shift
done
out="${out:-runs/video/$(date +%Y%m%d-%H%M%S)}"
py=(uv run --extra video --extra conditions python)

video=""
[[ -f "$out/shots.json" ]] && video="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["video"])' "$out/shots.json")"
if [[ -n "$video" && -f "$out/$video" ]]; then
  echo "== record: $out already has $video and shots.json (delete them to re-record)"
else
  echo "== record -> $out"
  # a failed shot is in shots.json; carry on to the captions so the rest is still usable
  "${py[@]}" scripts/demo_video/record.py --out "$out" "${rec[@]}" || echo "record.py: some shots failed (see shots.json)"
fi

force=()
[[ "${FORCE:-0}" == 1 ]] && force=(--force)
echo "== program and captions (mp4: moves and speed from the 4K master; srt; burn)"
"${py[@]}" scripts/demo_video/captions.py "$out" --only mp4,srt,burn "${force[@]}"
if [[ $qhd == 1 ]]; then
  echo "== the 1440p program"
  "${py[@]}" scripts/demo_video/captions.py "$out" --only mp4,burn --size 2560x1440 "${force[@]}"
fi
echo "== cuts"
"${py[@]}" scripts/demo_video/captions.py "$out" --only cuts "${force[@]}"
echo "== gif"
"${py[@]}" scripts/demo_video/captions.py "$out" --only gif "${force[@]}"

if [[ $publish == 1 ]]; then
  size=$(stat -c %s "$out/demo.gif")
  if (( size > 3000000 )); then
    echo "not publishing: $out/demo.gif is $((size / 1000000)) MB (limit 3 MB)" >&2
    exit 1
  fi
  mkdir -p docs/report/figures
  cp "$out/demo.gif" docs/report/figures/demo.gif
  echo "published docs/report/figures/demo.gif ($((size / 1000)) kB)"
fi
echo "== done: $out"
