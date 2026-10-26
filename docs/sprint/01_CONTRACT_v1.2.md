# 01 · Contract v1.2 draft: live missions, agent, fleet, radio

> Superseded by [`docs/01_CONTRACT.md`](../01_CONTRACT.md) §12–§14. The draft was merged there in task
> D-C1 (#52, Oct 21), implemented in `sightline/contract.py` and generated into `web/src/contract.ts`.
> The committed contract is the authority; this page records only how the draft differed.

## What the draft set out

v1.2 **added** files and endpoints for live missions and changed nothing in the static cache files
(`manifest`, `survey`, `detections`, `map`, `metrics`), so 1.0 and 1.1 caches still load:

- §12, mission files: the mission, `MapBase` and `MapUpdate` (step and reweight), second-look verdicts,
  sector tasks, teams, clues, proposals, the fleet, conditions, assignment cards, events and the agent
  trace, plus the invariants `validate_mission()` checks.
- §13, the mission API, with the radio router mounted under the same prefix.
- §14, the in-process interfaces the workstreams call each other through: `MissionStore` (the only writer of
  mission files), `LiveMap`, the planner, `fetch_conditions`, `assignment_card`, the Token Factory
  client and the agent hooks.

## Changes between the draft and the merged contract

| Where | Draft | Merged |
|---|---|---|
| §13 `PUT /missions/{id}/fleet` | merges telemetry into an existing fleet | the first telemetry with drones creates the fleet; no drones and no fleet returns 409 |
| §14 `ChatClient.chat` | `max_tokens=800` | `max_tokens=2048` |
| §12.3 invariant 8 (leg status) | stray line above the §12.3 heading | in the numbered list |
| Changelog | a separate "Changelog addition" | folded into §10's changelog |

Later additive changes are in the changelog of `docs/01_CONTRACT.md`.
