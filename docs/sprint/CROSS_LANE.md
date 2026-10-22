# Cross-lane requests

How a lane asked another lane for a change during the sprint. The shared channel was **GitHub Issues**
on the repository: any lane can file one, any lane can list its inbox, requests keep their history, and
they close when the fixing pull request merges (`Fixes #12`).

## Labels

| Label | Meaning |
|---|---|
| `lane:A` … `lane:E` | **To** this lane (exactly one) |
| `from:A` … `from:E` | **From** this lane |
| `type:bug` | Their code breaks yours, or is wrong against the contract |
| `type:need` | You need a function, endpoint, field or component they own |
| `type:contract` | A change to `01_CONTRACT.md` / `contract.py`; always `lane:D` |
| `type:heads-up` | You changed something they depend on; read only |
| `blocking` | You cannot continue even with a stub; used rarely |

Title format: `[E→D] Mount radio_router in the API (D-R4)`.

## Sending a request

1. Find the owning lane from the folder table in [`00_SPRINT.md`](00_SPRINT.md) §2.
2. Search for a duplicate (`gh issue list --label lane:D --search "<term>"`).
3. File the issue with the template below and the labels.
4. Keep working with a stub. Never edit another lane's folder to unblock yourself.

The body has six parts: **Summary** (one sentence), **Why / what it blocks** (task IDs, and what happens
without it), **Exact ask** (signature, field, endpoint or component), **Acceptance check** (a command or
click path), **Our workaround meanwhile** (the stub and where it lives), **Links**.

## Receiving requests

- Triage order: blocking → contract → bugs → needs → heads-ups.
- Work one on a branch `x/<lane>-<issue#>-<slug>`; the pull request says `Fixes #<n>`, and a comment on
  the issue says what changed and how to verify it.
- Not yours: relabel to the right lane with a comment saying why.
- Disagree: comment with the reason and an alternative; do not close it yourself. Contract
  disagreements go to lane D.
- Heads-ups: read, adapt, comment "ack", close.

## What was committed

| Piece | Outcome |
|---|---|
| `scripts/setup_labels.sh` (creates the labels) | Done #116 |
| `.github/ISSUE_TEMPLATE/lane-request.yml` (the template on github.com) | Done #116 |
| `scripts/lane_inbox.sh` (prints a lane's open requests; `--new` for ones updated since the last check) | Done #116 |
| Per-session hooks that show the inbox automatically, and request/inbox helpers | Dropped from `main`: each member kept their assistant configuration local |

The issue numbers cited across `docs/` (for example #49, #51, #70) are requests filed this way.
