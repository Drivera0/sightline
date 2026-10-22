#!/usr/bin/env bash
# Open cross-lane requests for $SIGHTLINE_LANE (docs: CROSS_LANE §5, §7).
#   bash scripts/lane_inbox.sh --all     # everything open for the lane, blocking first
#   bash scripts/lane_inbox.sh --new     # only issues updated since the last --new (at most every 10 min)
# Silent and harmless when gh or SIGHTLINE_LANE is missing.
set -uo pipefail
LANE=${SIGHTLINE_LANE:-}
command -v gh >/dev/null 2>&1 && [ -n "$LANE" ] || exit 0
MODE=${1:---all}
STAMP="${XDG_CACHE_HOME:-$HOME/.cache}/sightline-lane-inbox-$LANE"
mkdir -p "$(dirname "$STAMP")"
since=""
if [ "$MODE" = "--new" ]; then
  if [ -f "$STAMP" ] && [ $(( $(date +%s) - $(stat -c %Y "$STAMP" 2>/dev/null || stat -f %m "$STAMP") )) -lt 600 ]; then exit 0; fi
  [ -f "$STAMP" ] && since=$(date -u -r "$STAMP" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || true)
  touch "$STAMP"
fi
json=$(gh issue list --label "lane:$LANE" --state open --limit 50 --json number,title,labels,updatedAt 2>/dev/null) || exit 0
python3 - "$LANE" "$since" "$json" <<'PY'
import json, sys
lane, since, items = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
items = [i for i in items if not since or i["updatedAt"] > since]
if not items:
    sys.exit(0)
rank = lambda i: (0 if any(l["name"] == "blocking" for l in i["labels"]) else 1 if any(l["name"] == "type:contract" for l in i["labels"]) else 2)
print(f"Cross-lane inbox for lane {lane}: {len(items)} open")
for i in sorted(items, key=rank):
    tags = ",".join(l["name"] for l in i["labels"] if not l["name"].startswith("lane:"))
    print(f"  #{i['number']} {i['title']} [{tags}]")
PY
