#!/usr/bin/env bash
# The smoke test (LANE_D §5.8): the live-mission loop on a real server, no network, < 60 s.
# Run before merging anything the pipeline calls. Details: scripts/smoke.py.
set -euo pipefail
cd "$(dirname "$0")/.."
exec uv run python scripts/smoke.py "$@"
