#!/usr/bin/env bash
# The dress run's run-time stages (the image build did the installs and downloads). Every stage
# runs even if an earlier one failed; the exit code is 1 if any failed. Each prints
# "=== STAGE <name> <seconds>s ===" (deploy/dressrun/stage.sh).
set -u
cd /app
fail=0
run() { stage "$@" || fail=1; }

if [ -n "${NEBIUS_API_KEY:-}" ]; then
  echo "LLM: Nebius Token Factory (NEBIUS_API_KEY is set)"
else
  echo "LLM: scripted fake replies (SIGHTLINE_FAKE_LLM=1; no NEBIUS_API_KEY)"
fi
if [ -n "${TAVILY_API_KEY:-}" ]; then
  echo "Conditions: Tavily (TAVILY_API_KEY is set)"
else
  echo "Conditions: fixed documents (SIGHTLINE_FAKE_TAVILY=1; no TAVILY_API_KEY)"
fi
python --version
node --version
echo "pnpm $(pnpm --version)"
echo "uv: $(uv --version)"
nproc | sed 's/^/cpus: /'

# The tests use fakes and need no keys or network: run them exactly as CI does, keys unset.
run pytest env -u NEBIUS_API_KEY -u TAVILY_API_KEY -u SIGHTLINE_FAKE_LLM -u SIGHTLINE_FAKE_TAVILY \
  uv run pytest tests -q -rs
# The whole live loop on a real server with fakes, as CI runs it.
run smoke env -u NEBIUS_API_KEY -u TAVILY_API_KEY SIGHTLINE_FAKE_LLM=1 SIGHTLINE_FAKE_TAVILY=1 \
  bash scripts/smoke.sh

# README "Build the demo cache": validate the published demo cache against the contract, verbatim.
run validate-demo-cache uv run python -m sightline.pipeline validate cache/demo
run demo-cache-metrics python -c '
import json
m = json.load(open("cache/demo/metrics.json"))["detector"]
print("model", m["model"], "| test photos", m["test_images"], "| threshold", m["threshold"])
print("VOC   precision", m["voc"]["precision"], "recall", m["voc"]["recall"], "AP50", m["voc"]["ap50"])
print("SAR   precision", m["sar"]["precision"], "recall", m["sar"]["recall"], "AP", m["sar"]["ap"])
'

[ -n "${NEBIUS_API_KEY:-}" ] || export SIGHTLINE_FAKE_LLM=1
[ -n "${TAVILY_API_KEY:-}" ] || export SIGHTLINE_FAKE_TAVILY=1
run api-remote-check bash deploy/dressrun/api_check.sh
# The same with the detector behind HTTP (SIGHTLINE_DETECT_URL), as with the Nebius endpoint.
run api-remote-detector bash deploy/dressrun/api_check.sh remote

run web-build bash -c 'cd web && VITE_CACHE_DIR=demo pnpm build && du -sh dist'
# The built site as a static host serves it: index.html, its bundle, the one-console routes.
run web-dist-check bash deploy/dressrun/web_check.sh

if [ "$fail" -eq 0 ]; then echo "dress run: all stages passed"; else echo "dress run: FAILED"; fi
exit "$fail"
