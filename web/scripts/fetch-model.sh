#!/usr/bin/env bash

# Download the in-browser detector ("Try your own photo") before Vercel builds the app. It is the
# ONNX export of the weights-v2 detector (yolo11s_tiles_run1_best.pt, imgsz 1024, opset 17), too
# big for git, so it lives on a GitHub release like the caches. Served from this site's own origin.
#
# Unlike the caches, a missing model does not fail the build: the panel then says the model isn't
# included in this build, and everything else works.
set -uo pipefail

URL="https://github.com/Drivera0/sightline/releases/download/model-onnx-v2/sightline-detector-v2.onnx"
SHA256="095fcc4340c0b9069e2706999e2cc360d7e973a189d4b722f8dd9143d91dcf88"
OUT="public/models/sightline-detector-v2.onnx"

mkdir -p public/models
if ! curl -fsSL -o "$OUT.part" "$URL"; then
  echo "fetch-model: could not download $URL; building without the in-browser detector" >&2
  rm -f "$OUT.part"
  exit 0
fi
if command -v sha256sum >/dev/null 2>&1; then
  got="$(sha256sum "$OUT.part" | cut -d' ' -f1)"
  if [ "$got" != "$SHA256" ]; then
    echo "fetch-model: checksum mismatch ($got); building without the in-browser detector" >&2
    rm -f "$OUT.part"
    exit 0
  fi
fi
mv "$OUT.part" "$OUT"
echo "fetch-model: $OUT ready"
