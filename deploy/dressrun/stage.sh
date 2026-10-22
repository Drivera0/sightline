#!/usr/bin/env bash
# Runs one dress-run stage and prints its wall time:
#   stage <name> <command...>
# prints "=== STAGE <name> <seconds>s ===" on success, the same line plus "FAILED (exit N)" on
# failure, and exits with the command's code. run.sh collects these lines into times.md.
set -u
name="$1"
shift
echo "--- stage $name: $*"
start="$(date +%s.%N)"
"$@"
rc=$?
secs="$(awk -v s="$start" -v e="$(date +%s.%N)" 'BEGIN { printf "%.1f", e - s }')"
if [ "$rc" -eq 0 ]; then
  echo "=== STAGE $name ${secs}s ==="
else
  echo "=== STAGE $name ${secs}s === FAILED (exit $rc)"
fi
exit "$rc"
