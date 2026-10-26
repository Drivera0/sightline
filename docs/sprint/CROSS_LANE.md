# Cross-workstream requests

How a dependency between two workstreams was tracked during the build. Each one was a **GitHub
issue** on the repository, labelled with the workstream it was for and the one it came from, so that
work in one part could continue against a stub while the request stayed open, the history stayed with
the request, and the issue closed when the fixing pull request merged (`Fixes #12`).

## Labels

| Label | Meaning |
|---|---|
| `lane:A` … `lane:E` | **For** this workstream (exactly one) |
| `from:A` … `from:E` | **From** this workstream |
| `type:bug` | Code in one workstream breaks another, or is wrong against the contract |
| `type:need` | A function, endpoint, field or component another workstream provides |
| `type:contract` | A change to `01_CONTRACT.md` / `contract.py`; always `lane:D` |
| `type:heads-up` | A change something else depends on; read only |
| `blocking` | Work cannot continue even with a stub; used rarely |

Title format: `[E→D] Mount radio_router in the API (D-R4)`.

## Filing a request

1. Find the workstream that owns the folder in [`00_SPRINT.md`](00_SPRINT.md) §2.
2. Search for a duplicate (`gh issue list --label lane:D --search "<term>"`).
3. File the issue with the template below and the labels.
4. Keep working against a stub; the change itself lands in the owning workstream's folder.

The body has six parts: **Summary** (one sentence), **Why / what it blocks** (task IDs, and what happens
without it), **Exact ask** (signature, field, endpoint or component), **Acceptance check** (a command or
click path), **Workaround meanwhile** (the stub and where it lives), **Links**.

## Handling a request

- Order: blocking → contract → bugs → needs → heads-ups.
- Each is worked on a branch `x/<lane>-<issue#>-<slug>`; the pull request says `Fixes #<n>`, and a
  comment on the issue says what changed and how to verify it.
- Filed against the wrong workstream: relabelled, with a comment saying why.
- Contract questions are settled in workstream D, which owns `01_CONTRACT.md`.
- Heads-ups: read, adapt, close.

## What was committed

| Piece | Outcome |
|---|---|
| `scripts/setup_labels.sh` (creates the labels) | Done #116 |
| `.github/ISSUE_TEMPLATE/lane-request.yml` (the template on github.com) | Done #116 |
| `scripts/lane_inbox.sh` (prints a workstream's open requests; `--new` for ones updated since the last check) | Done #116 |

The issue numbers cited across `docs/` (for example #49, #51, #70) are requests filed this way.
