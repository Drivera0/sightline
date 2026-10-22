# Planner v2: lost-person prior, ground teams, re-plans (simulated evaluation)

**Simulated evaluation, not a field test.** `uv run python scripts/planner_v2_eval.py`, output in
`runs/planner_v2/result.json` (this run: `docs/evidence/planner_v2/20261022-0157/`). A new mission's 1 km grid of 5 m cells at the creek scenario's last
known point. Canopy is what the creek run's photos measured: HERIDAL **val** crops, 7,761 of 40,000
cells, with 0.5 everywhere else. The demo cache map was not used because its canopy comes from HERIDAL
test photos. Visibility noise is 0.15, 2,000 trials per row and seed, 5 seeds, and a 2 h horizon.
The seed range for "found ≤ 30 min" is in brackets. Wall-clock time for the whole evaluation was
353 s on the dev machine (one process, 377 MB peak).

Minutes to find are reported instead of cells. A drone covers cells at a fixed rate, so fewer
minutes means fewer cells photographed before the find.

## What changed

1. **Koester lost-person prior** (`sightline/search/prior.py`). The prior uses the 25/50/75/95 %
   crow's-flight distance rings from the IPP. Each ring holds its quartile share spread over its
   area, and 5 % sits beyond the 95 % ring. The rings are blended 0.8 with the uniform prior. The
   weight was chosen by hand as a hedge, not tuned. Sources were verified against the PDFs:
   - Hikers in four terrains come from Sava, Twardy, Koester & Sonwalkar 2015, Table 1. The table
     prints no unit; the paper's text reads it as km.
   - Dementia in temperate mountainous and temperate flat terrain comes from Koester's ICAR 2025 deck,
     p. 15 (ISRID 2.0, miles).

   The contract has no category field and adding one needs a version bump (§10), so the category is
   read from the mission's free-text `subject` (for example "dementia" or "day hiker", plus "flat"
   or "dry"). Without a category the prior stays uniform.
2. **Ground teams in the planner** (`planner.py`). A sector that a team is assigned to or is
   searching is worth `team_discount` = 0.5 less to a drone. Team assignments rank (team, sector)
   pairs by POA × (1 − drone POD) per minute of the team's time: the straight-line walk from the
   team's last position plus the time to search the sector. Both times are **assumptions** because
   no SAR source was verified: 3 km/h and 60 min per 250 m sector.
3. **Re-plan on team evidence** (`agent/loop.py`, `mission/effects.py`). Two new events trigger a
   re-plan: a sector marked searched at a POD, and a team's new position (via `PATCH /teams`). A
   re-plan proposes the fleet's best leg plus one leg for every other idle drone. That is one
   proposal per drone, and each still needs approval. Two guards came out of the creek run:
   - Other drones' pending proposals count as taken. Before this, three drones that finished one
     after another were all proposed the same sector.
   - No re-task takes a drone off a sector that holds at least as much POA as the new one. Before
     this, a drone already over the clue's sector was re-tasked away from it.
4. **Opening legs from the agent.** When the fleet joins, every idle drone gets a proposed leg.
   `creek_run.py` approves those legs. With `--scripted-opening` it rejects them and flies the
   hard-coded sectors used in the video.

## Results

### (a) Prior: uniform vs Koester (3 drones unless noted; no teams)

The simulated person is drawn from the category's rings at weight 1, as if the rings were right.

| Person drawn from | Planner believes | Median min | Found ≤ 30 min | Found ≤ 2 h |
|---|---|---|---|---|
| hiker, temperate mountainous | uniform | 78 | 21.4 % (20.4–22.6) | 64.7 % |
| hiker, temperate mountainous | Koester blend | 78 | 21.4 % (20.4–22.6) | 64.7 % |
| dementia, temperate mountainous | uniform | 75 | 22.1 % (20.9–23.1) | 62.1 % |
| dementia, temperate mountainous | Koester blend | **28** | **52.8 %** (52.0–53.2) | 79.1 % |
| dementia, 1 drone | uniform | > 2 h | 9.9 % | 24.2 % |
| dementia, 1 drone | Koester blend | 85 | 18.7 % | 58.3 % |
| uniform (category wrong) | uniform | 78 | 21.9 % | 64.9 % |
| uniform (category wrong) | Koester blend (dementia) | 101 | 15.7 % | 55.8 % |

**The hiker prior gains nothing on a 1 km grid.** The hiker 25 % ring is 0.7 km, so it covers
almost the whole grid and the prior inside the grid is still uniform. The prior mainly changes how
much probability lies outside the grid: about 77 % with the blend (84 % from the rings alone)
instead of 50 %. That is a real finding, which
argues for a larger grid on hiker missions. The dementia rings are tight (25 % within 0.1 mi), so
there the prior more than doubles the finds within 30 min. When the category is wrong, finds within
30 min fall from 21.9 % to 15.7 %. The uniform blend limits that loss but does not remove it.

### (b) Team awareness (3 drones and 2 teams; teams search with POD 0.5 per pass)

| Canopy | Clue | v1 (teams ignored, nearest team) | discount only | walking time only | v2 (both) |
|---|---|---|---|---|---|
| val | none | 24.1 % (23.0–24.8) | 24.3 % | 24.0 % | **25.3 %** (24.5–25.9) |
| val | one per sector at minute 0 | 26.3 % (26.1–27.0) | 26.4 % | 26.7 % | **27.1 %** (26.6–27.9) |
| synthetic sector canopy | none | 34.8 % (32.7–37.8) | 34.7 % | 34.5 % | 34.6 % (33.6–35.9) |
| synthetic sector canopy | one per sector at minute 0 | 34.1 % (32.5–36.6) | 34.5 % | 34.1 % | 34.4 % (31.9–36.1) |

The figures are found ≤ 30 min. On the val canopy, v2 gains about 1 point, and the seed ranges only
just separate. On the synthetic canopy there is **no measurable gain**: every difference is inside
the seed spread. Within 2 h, v2 is 0.2–2.1 points higher in every row. Teams spend most of the first
30 min walking and searching their first sector, so a discount on drone legs has little time to
matter.

### (c) Re-plans: the best leg only (v1) vs the best leg plus every idle drone (v2)

All rows use 3 drones and 2 teams on the val canopy, with a clue in each sector in turn.

| Start | Clue at | v1 | v2 |
|---|---|---|---|
| no opening legs | minute 0 | 13.5 % (13.2–13.7), median > 2 h | **27.1 %** (26.3–27.4), median 67 |
| opening legs | minute 0 | 27.1 % | 27.1 % |
| opening legs | minute 10 | 26.6 % | 26.6 % |

The figures are found ≤ 30 min. Without opening legs, v1 leaves two drones idle until some other
event: each event plans one drone, and "leg done" only re-plans the drone that finished. v2 doubles
the finds in this case. Once the agent proposes opening legs (item 4), no drone is idle when the
clue arrives, so the two rules give **identical** results.

## Limits

- Everything above is simulated: drones, teams, person and detection. The team pace, search time
  and POD 0.5 are assumptions. Approvals are instant in the simulation.
- The hiker unit (km) is read from the paper's text because Table 1 prints none. Koester's ICAR 2025
  slide p. 28 gives ISRID 2.0 hiker (temperate mountainous) quartiles of 1.0/2.9/5.1/12.0 with no
  unit. These differ from Table 1 (ISRID 1.0) and were not used.
- Sava et al.'s 0.78 is their map score for the distance-ring model on 376 ISRID cases with known IPP
  and find points. It is not an accuracy figure.
- Only the categories listed above are included. Hunters, children and other categories were not
  in the sources that could be checked.
- `creek_run.py` with the agent's opening legs: see the PR for the run result.

## Reasons that name their evidence

Each assignment and drone-leg reason now says what moved its sector since the last plan, from the
map log (`planner.sector_moves`, `evidence_line`), in at most 45 words so a briefing can quote it.
Before, a reason gave the sector's share and the planner's numbers but not why the share was what it
was, so "why did the clue not move the team?" had no answer on the card.

| | Reason |
|---|---|
| Before (demo p003) | Sector C2 holds 5.5% of the probability, 48% of it under tree cover where a drone sees poorly (drone POD 0.45): a ground team adds the most here; Team One is nearest (465 m, about 9 min on foot). |
| After (demo p003) | C2 · 5.5 % of remaining probability, up from 3.1 %: c001 (hiker at the lot saw…) and c004 (possible whistle, three blasts, to…) raised it; 124 photos here lowered it; 48% under tree cover (drone POD 0.45): a ground team adds the most here. |
| After (demo p004) | B2 · 5.2 % of remaining probability: no new evidence; highest remaining probability of the open sectors; 47% under tree cover (drone POD 0.46): a ground team adds the most here; Team Two is nearest (266 m, about 5 min on foot). |

How it works. "The last plan" is the map version of the last planner `tool_call` of the same kind
(legs or assignments) in the trace. The log is replayed from the prior to that version, then each
later update's change to every sector's share is read off and grouped by cause: each clue (id and
its first five words), the photos over the sector, the photos over other sectors, each ground
search, reviews, shelter. Causes under 0.1 point of the whole are not named. With nothing named the
reason says "no new evidence", and "highest remaining probability of the open sectors" when it is.
The core (sector, share, causes, and for a leg the expected step) always fits; the rest (the next
best, battery, daylight, the team's walk) is added while the reason stays within 45 words. The
replay costs about 0.13 s on the demo's 504 map updates. The planner's ranking and the evidence line
of every sector it considered are in the trace (`docs/architecture/agent.md`, "The planner as a tool
call"). Tests: `tests/search/test_planner_evidence.py`, `tests/agent/test_planner_trace.py`.
