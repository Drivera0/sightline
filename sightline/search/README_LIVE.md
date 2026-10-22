# The live map (lane C, C-L1 and C-S1)

Lane C's folder. Lane C had not started on Tue Oct 21 and the live map blocked Gate 1, the agent end to
end and the report's re-task chain, so **lane A built C-L1 and the lattice part of C-S1** (issue #64).
**Build on this; don't start them again.** Lane C owns these files: change anything.

| File | What | Tests |
|---|---|---|
| `live.py` | `LiveMap` (contract §14 + LANE_C §5.2): `start(lkp, subject=)` (Koester rings for the subject's category, else the labelled placeholder), `from_base(base)`, `frame_update` (`pod.frame_step`, recall × visibility before the cap, candidates held), `review_update` (not_person step, person undo of that frame's look, unsure none), `ground_update` (POD ≤ 0.9), `clue_update` (`CLUE_FACTOR`, square root out to 2 × radius), `conditions_update` (shelter once per exposure level), `apply`, `p`, `sector_poa`, `canopy`, `top_cells` | `tests/search/test_live.py` |
| `sectors.py` | `Sector`, `SectorLayout` (`cells_of`, `polygon`), `lattice_sectors(grid)`: 4 × 4, A1 north-west … D4 | same |
| `update.py` | `apply_reweight` added beside `apply_step` (`MAX_FACTOR` 20) | |

**The rule with D's store (#54):** a `LiveMap` method *computes* a `MapUpdate`; `MissionStore.append_map_update`
numbers it, saves it and calls `apply`. A restart rebuilds the same map with `from_base` + `apply` in order (tested).

**Heuristics, labelled:** `CLUE_FACTOR` low 1.5, medium 3, high 6; `SHELTER_FACTOR` high 1.5, severe 2 on cells with
canopy ≥ 0.5. The prior is Koester's lost-person distance rings (`prior.koester_prior`, cited quartiles, blended 0.8 with uniform) when the subject names a category (hiker, dementia), else the placeholder (uniform, half outside the 1 km grid).

**Measured:** one real HERIDAL val photo through the live pipeline stepped 105 of 142 covered cells (POD 0.001–0.858,
canopy from the photo's own pixels: 0.29 mean), 46 ms. A photo whose footprint misses the grid (a wrong LKP) is
reported as "photo outside the search area" in `photo.processed`.

## Still lane C's

- [x] **C-P1** planner (`planner.py`: `candidate_legs`, `expected_clearance`, `propose_legs`, `propose_assignments`; lane A, `tests/search/test_planner.py`). The agent's stand-ins (`sightline/agent/_stubs.py`) are deleted
- [x] **C-S1 rest** (lane A, 2026-10-22): `sectors.py` is now a port of `sectors.ts` (`build_sectors`, `flight_lines`, `assign_cells`, `sector_state`, the constants), checked against shared vectors in both languages (`write_sector_vectors` → `web/src/map/heat/__fixtures__/sector_vectors.json`; `tests/search/test_sectors.py`, `web/src/map/heat/sectorVectors.test.ts`; the demo flight included). **Fixed a real mismatch:** the Python lattice used letter = row, so Python "B3" was the TS "C2", and split by whole cells (240 m sectors on a 20 m grid). It now matches TS: column letters west → east, row numbers north → south, metric bounds, cells by centre. Runs recorded before 2026-10-22 (the re-task chain, the creek run, the card examples) name sectors the old way
- [x] **C-H1** (lane A): `web/src/search/live.ts` (`applyReweight`, `replayLive`, `LiveHeat` with a checkpoint every 25) checked against `LiveMap.apply` on `live_cases` in the shared vectors (1e-9); `web/src/map/heat/LiveHeatMap.tsx` on the Command tab: heat tweened per `map.updated`, sector outlines with POA now (from `GET /sectors`, which now carries each `polygon`), LKP, clues, teams. Checked in Chromium: a new photo appears and its sector's POA drops. `HeatLayer` (demo caches) is unchanged
- [x] TS lattice: `buildSectors` with no flight lines is the lattice, the same as Python's (shared vectors)
- [x] **C-P2** planner evaluation, simulated (`planner_sim.py`, `scripts/planner_eval.py`, `tests/search/test_planner_sim.py`; lane A): no better than a fixed order with a flat prior; 1.7× the finds within 30 min after a clue
- [x] **C-D1** debrief (`debrief.py`, `tests/search/test_debrief.py`; lane A): tables from the log (timeline, sightings with second look and review, proposals and decisions, sectors with drone coverage and "searched by Team Two at POD 50 %", conditions over time, clues, unsearched by POA, trace counts) and an optional narrative checked against the tables' numbers. "clear" in free text from the log is masked. `debrief()` takes `sectors=` (rows of `GET /sectors`, now `effects.sector_overview`) because the state has no layout. Served at `GET /missions/{id}/debrief.md` (`?narrative=true` for the model paragraph)
- [x] **C-F1** fleet sim (`fleet.py`, `scenarios/creek.json`, `tests/search/test_fleet.py`; lane A): `python -m sightline.search.fleet run --api URL --mission ID [--time-scale 30] [--photo-every-m 15] [--scripted-clue]` and `... check` (loads the scenario and its frames, no API). An HTTP client: the first `PUT /fleet` creates the mission's fleet (contract §13 updated), it flies approved legs only, uploads photos through `POST /photos` with EXIF/XMP poses that `read_pose` reads back. Frames are crops of labelled HERIDAL **val** photos as wide on the ground as the line spacing at the source GSD: around a labelled person when the footprint covers the scenario's hidden point, else clear of every labelled person (val's empty label files are unreliable). Truth never leaves the scenario (tested). Checked against a real server: 3 planner legs flown to `done`, 264 photos, clear crops score ≤ 0.16; a C3 leg at 15 m spacing: the one photo over the hidden point became candidate f0206-d01 at 0.73. Keep `--photo-every-m` ≤ the footprint's 15 m along-track or photos leave gaps
- [x] **Creek frames listed** (lane A): `scenarios/creek.json` names its positive crop and the 12 negative crops (`negatives`); `FramePool` uses them as listed (derived from val only when a scenario lists none)
- [x] **C-F1 on the event stream** (lane A, 2026-10-22): `run()` follows `GET /missions/{id}/events` in a thread (`FleetFeed`, reconnects with `Last-Event-ID`) and takes approved legs from each `fleet.updated`, instead of a `GET /state` every tick; polling remains the fallback (and what `tick()` alone uses, as the tests and `creek_run.py` do). Checked on a real server: one `GET /state` (before the stream delivered), then the approved leg from the stream, flown to done
- [x] **C-F2** creek run (`scripts/creek_run.py`, lane A; `--live` for Nemotron + Tavily): 3 simulated drones on opening legs A2, A3, B2 (scripted manager); Team Two's backpack clue → the agent re-tasks Drone 3 to C3 → the sim drops B2 and flies C3 → the photo over the hidden person is candidate f0665-d01 (0.73) → scripted review → the agent's alert, approved. Offline rehearsal 2026-10-22: complete, `validate_mission` ok, **469 s wall**, 711 photos. The re-task comes 1 s after the clue; the rest is the worker's queue (about 1.5 photos/s here). For the ≤ 3 min video: record on `resize.sh c7i.4xlarge` or cut the wait. At night the real conditions say no flying, so the script swaps in the fair-weather fixture and logs that in the trace. Also fixed: the sim now drops a leg the store cancelled on a re-task
- [x] **C-F3** fleet evaluation, simulated (`planner_sim.plan_fleet`, `scripts/fleet_eval.py`, tests in `test_planner_sim.py`; lane A). Demo map (200×200 cells of 5 m), visibility noise 0.15, 2000 trials × 3 seeds, 2 h:

  | Scenario | Strategy | Median min | Found ≤ 30 min | Found ≤ 2 h |
  |---|---|---|---|---|
  | no clue | 1 drone, planner | > 2 h | 6.8 % | 26.7 % |
  | no clue | 3 drones, fixed order split in three | 84 | 20.0 % | 61.3 % |
  | no clue | 3 drones, each planning alone | > 2 h | 12.1 % | 48.3 % |
  | no clue | 3 drones, coordinated | 82 | 20.9 % | 62.6 % |
  | clue at the start, each sector in turn | 1 drone, planner | > 2 h | 10.4 % | 28.2 % |
  | clue at the start | 3 drones, split | 87 | 19.8 % | 61.0 % |
  | clue at the start | 3 drones, each planning alone | > 2 h | 15.9 % | 49.2 % |
  | clue at the start | 3 drones, coordinated | 81 | 23.0 % | 62.3 % |

  The honest headline: three drones find about 3× as often within 30 min as one. Coordination is what makes three planners worth it (alone, they all fly the same best sector). Against a hand split it's only a small edge: +3 points within 30 min with a clue, +1 without, because with a flat prior a split is already near-optimal (as C-P2 found for one drone).
- Fixed: `scripts/planner_eval.py` imported `CLUE_RADIUS_M` from effects, which #79 removed; both eval scripts now use lane B's `DEFAULT_RADIUS_M`
