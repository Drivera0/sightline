# The live map (lane C, C-L1 and C-S1)

Lane C's folder. Lane C had not started on Tue Oct 21 and the live map blocked Gate 1, the agent end to
end and the report's re-task chain, so **lane A built C-L1 and the lattice part of C-S1** (issue #64).
**Build on this; don't start them again.** Lane C owns these files: change anything.

| File | What | Tests |
|---|---|---|
| `live.py` | `LiveMap` (contract §14 + LANE_C §5.2): `start(lkp)` (placeholder prior, labelled), `from_base(base)`, `frame_update` (`pod.frame_step`, recall × visibility before the cap, candidates held), `review_update` (not_person step, person undo of that frame's look, unsure none), `ground_update` (POD ≤ 0.9), `clue_update` (`CLUE_FACTOR`, square root out to 2 × radius), `conditions_update` (shelter once per exposure level), `apply`, `p`, `sector_poa`, `canopy`, `top_cells` | `tests/search/test_live.py` |
| `sectors.py` | `Sector`, `SectorLayout` (`cells_of`, `polygon`), `lattice_sectors(grid)`: 4 × 4, A1 north-west … D4 | same |
| `update.py` | `apply_reweight` added beside `apply_step` (`MAX_FACTOR` 20) | |

**The rule with D's store (#54):** a `LiveMap` method *computes* a `MapUpdate`; `MissionStore.append_map_update`
numbers it, saves it and calls `apply`. A restart rebuilds the same map with `from_base` + `apply` in order (tested).

**Heuristics, labelled:** `CLUE_FACTOR` low 1.5, medium 3, high 6; `SHELTER_FACTOR` high 1.5, severe 2 on cells with
canopy ≥ 0.5. The prior is the placeholder (uniform, half outside the 1 km grid) until a cited lost-person prior.

**Measured:** one real HERIDAL val photo through the live pipeline stepped 105 of 142 covered cells (POD 0.001–0.858,
canopy from the photo's own pixels: 0.29 mean), 46 ms. A photo whose footprint misses the grid (a wrong LKP) is
reported as "photo outside the search area" in `photo.processed`.

## Still lane C's

- [x] **C-P1** planner (`planner.py`: `candidate_legs`, `expected_clearance`, `propose_legs`, `propose_assignments`; lane A, `tests/search/test_planner.py`). The agent's stand-ins (`sightline/agent/_stubs.py`) are deleted
- [ ] C-S1 rest: `build_sectors` port of `web/src/map/heat/sectors.ts` for demo caches, `sector_vectors.json`
- [x] **C-H1** (lane A): `web/src/search/live.ts` (`applyReweight`, `replayLive`, `LiveHeat` with a checkpoint every 25) checked against `LiveMap.apply` on `live_cases` in the shared vectors (1e-9); `web/src/map/heat/LiveHeatMap.tsx` on the Command tab: heat tweened per `map.updated`, sector outlines with POA now (from `GET /sectors`, which now carries each `polygon`), LKP, clues, teams. Checked in Chromium: a new photo appears and its sector's POA drops. `HeatLayer` (demo caches) is unchanged
- [ ] TS `latticeSectors` (not needed by the live map: the server sends the outlines)
- [x] **C-P2** planner evaluation, simulated (`planner_sim.py`, `scripts/planner_eval.py`, `tests/search/test_planner_sim.py`; lane A): no better than a fixed order with a flat prior; 1.7× the finds within 30 min after a clue
- [x] **C-D1** debrief (`debrief.py`, `tests/search/test_debrief.py`; lane A): tables from the log (timeline, sightings with second look and review, proposals and decisions, sectors with drone coverage and "searched by Team Two at POD 50 %", conditions over time, clues, unsearched by POA, trace counts) and an optional narrative checked against the tables' numbers. "clear" in free text from the log is masked. `debrief()` takes `sectors=` (rows of `GET /sectors`, now `effects.sector_overview`) because the state has no layout. Served at `GET /missions/{id}/debrief.md` (`?narrative=true` for the model paragraph)
- [x] **C-F1** fleet sim (`fleet.py`, `scenarios/creek.json`, `tests/search/test_fleet.py`; lane A): `python -m sightline.search.fleet run --api URL --mission ID [--time-scale 30] [--photo-every-m 15] [--scripted-clue]` and `... check` (loads the scenario and its frames, no API). An HTTP client: the first `PUT /fleet` creates the mission's fleet (contract §13 updated), it flies approved legs only, uploads photos through `POST /photos` with EXIF/XMP poses that `read_pose` reads back. Frames are crops of labelled HERIDAL **val** photos as wide on the ground as the line spacing at the source GSD: around a labelled person when the footprint covers the scenario's hidden point, else clear of every labelled person (val's empty label files are unreliable). Truth never leaves the scenario (tested). Checked against a real server: 3 planner legs flown to `done`, 264 photos, clear crops score ≤ 0.16; a C3 leg at 15 m spacing: the one photo over the hidden point became candidate f0206-d01 at 0.73. Keep `--photo-every-m` ≤ the footprint's 15 m along-track or photos leave gaps
- [ ] C-F2 creek run for the video (agent re-task after the clue, positive frame, review, alert); C-F3 fleet evaluation
