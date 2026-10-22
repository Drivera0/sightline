#!/usr/bin/env bash

# Download the in-browser detector ("Try your own photo") before Vercel builds the app. It is the
# variable-size ONNX export of the weights-v2 detector (yolo11s_tiles_run1_best.pt, imgsz 1024,
# opset 17; scripts/export_onnx.py), too big for git, so it lives on a GitHub release like the
# caches. Variable size lets the browser pad like YOLO.predict on non-square photos (issue #26).
# Served from this site's own origin.
#
# Unlike the caches, a missing model does not fail the build: the panel then says the model isn't
# included in this build, and everything else works.
set -uo pipefail

URL="https://github.com/Drivera0/sightline/releases/download/model-onnx-v2/sightline-detector-v2-dynamic.onnx"
SHA256="e44fed268293ea2f0bba0cb695892d0d87b592e465159c5e7bafdd68f4557370"
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
