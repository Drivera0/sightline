# Sprint 2 record (Oct 20–30, 2026)

How the team planned the second sprint, which turned the BCS Hackathon batch tool into a live system,
and what was delivered. These are cleaned copies of the planning documents the lanes worked from. They
are a historical record: the current descriptions of the system are `docs/00_OVERVIEW.md`,
`docs/01_CONTRACT.md` and the lane files in `docs/`.

## Key dates

| Date | Event |
|---|---|
| Mon Oct 20 | Sprint start; `cv2.dnn` smoke test (A-X1) |
| Wed Oct 22, 8 pm | Gate 1: `cv2.dnn` parity, planner legs, one photo round trip |
| Sat Oct 25, noon | OpenCV AI Competition 2026 code freeze |
| Sun Oct 26 | OpenCV submission (deadline 11:45 pm PDT), tag `opencv-submit` |
| Wed Oct 29 | Gate 2: order of the Nebius video |
| Thu Oct 30 | Nebius × NVIDIA Global AI Hackathon submission (deadline 10:00 am PDT), tag `nebius-submit` |

The work ran well ahead of this plan: almost every task below was merged between Oct 20 and Oct 22
(pull requests #6 to #153). The status in these files is as of Oct 22; the submissions, tags and
Gate 2 were still ahead.

## Status labels

- **Done**: merged on `main`, with the path or pull request (#n) that delivered it.
- **Dropped**: not built, with the reason.
- **Deferred**: not done when this record was written; still planned.

## Files

| File | What it was | Superseded by |
|---|---|---|
| [`00_SPRINT.md`](00_SPRINT.md) | Team brief: users, principles, lanes, task index with every task's status, gates, rules | `docs/00_OVERVIEW.md` |
| [`01_CONTRACT_v1.2.md`](01_CONTRACT_v1.2.md) | Draft of contract v1.2 (live missions) | `docs/01_CONTRACT.md` §12–§14 |
| [`CROSS_LANE.md`](CROSS_LANE.md) | How lanes asked each other for work through GitHub issues | — |
| [`MASTER_PLAN.md`](MASTER_PLAN.md) | The reasons behind the plan: positioning, architecture, nine workstreams, evaluation rules, risks | `docs/00_OVERVIEW.md`, `docs/report/OPENCV_REPORT.md` |
| [`LANE_A_SPRINT.md`](LANE_A_SPRINT.md) | Lane A: `cv2.dnn` detector, second look, agent loop, Nebius Serverless Job | `docs/LANE_A_ML.md`, `docs/architecture/agent.md` |
| [`LANE_B_SPRINT.md`](LANE_B_SPRINT.md) | Lane B: conditions (Tavily), clues and teams on the map, assignment cards, photo clients | `docs/LANE_B_GEO.md`, `docs/report/TAVILY.md` |
| [`LANE_C_SPRINT.md`](LANE_C_SPRINT.md) | Lane C: live map, information-gain planner, fleet, debrief | `docs/LANE_C_SEARCH.md`, `sightline/search/README_LIVE.md` |
| [`LANE_D_SPRINT.md`](LANE_D_SPRINT.md) | Lane D: contract, mission store, API, ingest, AWS, integration | `docs/LANE_D_PIPELINE.md`, `sightline/mission/README.md`, `deploy/aws/README.md` |
| [`LANE_E_OPS_VOICE.md`](LANE_E_OPS_VOICE.md) | Lane E: front door, command view, radio desk | `web/src/command/README.md`, `sightline/radio/README.md`, `docs/feedback/radio.md` |

Every measured number quoted here comes from `docs/report/EVIDENCE_INDEX.md`, which says where each is
backed and how to regenerate it.
