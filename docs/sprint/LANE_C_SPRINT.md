# Lane C · Sprint 2: live map, information-gain planner, fleet, debrief

> Superseded by [`docs/LANE_C_SEARCH.md`](../LANE_C_SEARCH.md) and
> [`sightline/search/README_LIVE.md`](../../sightline/search/README_LIVE.md) (the live map, planner and
> fleet as built), with results in `docs/report/PLANNER_V2.md` and `docs/report/FLEET_V2.md`. This file
> keeps the sprint plan, the math as planned and each task's outcome.

**Folders:** `sightline/search/`, `web/src/search/`, `web/src/map/heat/`, `tests/search/`.

## 1. Mission

1. **Live map.** Every kind of evidence updates one map through one ordered log: drone photos
   (weakened by weather), reviewer answers, ground-team searches ("searched at POD 60 %"), clues, and
   conditions. Python and TypeScript stay identical, checked by shared vectors.
2. **Information-gain planner.** For each drone, the next leg that rules out the most probability per
   minute within battery, wind and daylight; for idle ground teams, the next sector. Reasons in numbers.
3. **Fleet.** Several simulated drones share the map; the planner gives them non-overlapping legs and
   re-tasks one mid-flight when evidence arrives.
4. **Evaluation and debrief.** Simulated evaluations against the static approach, and a mission debrief
   built from the log.

The Python stays pure: lane D's pipeline calls it and persists the results; the fleet sim talks only to
the HTTP API.

## 2. The math as planned

| Update | Kind | Math |
|---|---|---|
| photo | step | per-cell POD × visibility factor, capped; canopy observations kept in the update |
| review "not a person" | step | review POD 0.9, cap 0.95 |
| review "person" | reweight | undo that photo's look near the detection: factor 1 / (1 − POD) |
| ground search | step | every cell of the sector at POD = min(team POD, 0.9), so a searched sector keeps probability |
| clue | reweight | × 1.5 / 3 / 6 by reliability within the radius, square root of it out to twice the radius (heuristic) |
| conditions | reweight | when the exposure band reaches high or severe, high-canopy cells × 1.5 or 2 (heuristic) |

**Planner value of a leg:** expected probability ruled out, Σ pᵢ · PODᵢ with
PODᵢ = min(cap, recall · (1 − canopyᵢ) · coverageᵢ · visibility), divided by the leg's minutes. No legs
when not flyable; a leg must end before `flyable_until`, civil twilight and the battery reserve.
Several drones: sequential greedy on the expected posterior, so drones spread out and a re-task after a
clue falls out of the same rule. Ground teams: sectors ranked by POA × (1 − drone POD), standby teams
paired nearest first.

**Truth stays in the scenario.** The hidden person's position only decides which image a simulated
photo gets; nothing labelled as truth reaches the API.

## 3. Work items

| ID | Task | Outcome |
|---|---|---|
| C-S1 | `sectors.py` port, `lattice_sectors` (A1–D4 for live missions), shared vectors | Done #65, #100 |
| C-L1 | `LiveMap` with step and reweight; TS `applyReweight` and `replayLive` | Done #65 (`sightline/search/live.py`, `web/src/search/live.ts`) |
| C-G1 | Ground search evidence | Done #65 |
| C-E1 | Clue evidence | Done #65 |
| C-E2 | Conditions: visibility POD, shelter shift | Done #65 |
| C-P1 | `propose_legs`, `propose_assignments` | Done #67 (`sightline/search/planner.py`) |
| C-P2 | Planner evaluation (simulated) | Done #73: with a clue, 10.7 % vs 6.3 % found within 30 min; no gain on a flat prior |
| C-H1 | Live heat layer | Done #83 |
| C-F1 | Fleet sim as an HTTP client, photos with written EXIF | Done #84 (`sightline/search/fleet.py`) |
| C-F2 | Creek scenario: clue → re-task → find | Done #84, #88 (`sightline/search/scenarios/creek.json`, three drones) |
| C-F3 | Fleet evaluation (simulated) | Done #89, #139: coordinated vs hand-split with a clue at the start, 15.9 % vs 11.5 % (realistic preset); level with no clue |
| C-D1 | Debrief: tables, then an optional narrative checked against them | Done #80 (`sightline/search/debrief.py`) |
| — | Report sections (live map, planner, evaluation) | Done (`docs/report/OPENCV_REPORT.md`) |

Changed from the plan: the placeholder prior gave way to Koester's lost-person rings when the subject
category is set (#135, `docs/report/PLANNER_V2.md`); the fleet gained one process per drone, degraded
links and a relay for cut-off teams (#139).

## 4. Tests

`tests/search/` and Vitest, no network: sector and update vectors identical in both languages; sums stay
1; ground POD never above 0.9 and searched sectors keep probability; a map rebuilt from the update log
equals the live one; the planner respects flyability, battery and twilight and gives two drones
different sectors; the fleet sim's photos carry poses lane B's `read_pose` reads back, and no request
carries truth; the debrief's narrative uses only numbers from its tables.

## 5. Cut order

From the bottom: third drone · debrief narrative · fleet evaluation · shelter shift · fleet with two
drones · planner evaluation · live heat animation · clue evidence · ground evidence · single-drone
planner (never) · sectors (never) · live map steps (never). Nothing was cut.
