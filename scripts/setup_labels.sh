#!/usr/bin/env bash
# Cross-lane labels (docs: CROSS_LANE §3). Safe to run again: existing labels are updated, not duplicated.
set -euo pipefail
REPO=${REPO:-Drivera0/sightline}
make() { gh label create "$1" --repo "$REPO" --color "$2" --description "$3" --force >/dev/null && echo "  $1"; }
for l in A B C D E; do
  make "lane:$l" 1d76db "To lane $l"
  make "from:$l" c5def5 "From lane $l"
done
make type:bug d73a4a "Their code breaks yours, or is wrong against the contract"
make type:need 0e8a16 "A function, endpoint, field or component another lane owns"
make type:contract 5319e7 "A change to 01_CONTRACT.md / contract.py (always lane:D)"
make type:heads-up fbca04 "Something they depend on changed; read, ack, close"
make blocking b60205 "Can't continue even with a stub"
