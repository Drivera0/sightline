# sightline/mission: live missions (lane D)

Lane D's folder. Lane D had not started on Tue Oct 21, and every lane was blocked on the contract
and the store, so **lane A built D-C1, D-M0, D-A1, D-P1 and `effects.py`** (issue #51). **Build on
this; don't start them again.**
Lane D owns all of it: review, change anything, and update the checklist below.

## What exists

| File | What it does | Tests |
|---|---|---|
| `store.py` | `MissionStore`, contract §14 exactly, plus `list_missions()`, `events()`, `trace_entries()`. Files per §12.1 under `root/<mission_id>/`; JSON rewritten atomically (temp + `os.replace`), `.jsonl` appended, both under a per-mission lock (threads: `RLock`; processes: `fcntl`/`msvcrt` on `.lock`); every write validated with the contract models; id counters in `counters.json`; `emit()` → `events.jsonl` + every `subscribe()`r (thread-safe); `subscribe()` replays after `Last-Event-ID`, then streams | `tests/pipeline/test_mission.py` |
| `validate.py` | `validate_mission(root, mission_id) -> list[str]`: every file parses, and §12.3 invariants 1–8 | test 2 (every invariant broken once) |
| `pipeline.py` | `ingest_photo` (LANE_D §5.3 steps 1–7): B's `read_pose` (rejects photos with no GPS/pose or not nadir) → 1000×750 display frame → `detect_tiled` on the **original** → candidates (conf ≥ 0.29, crop) and near-miss crops (0.15–0.29, `crops/nearmiss/`, files only) → B's `georef_detection` → `append_frame`/`append_detections` → `rank_frames_live` → C's `frame_update` (skipped until C-L1) → A's `hooks.on_detection` → one `photo.processed` event with per-step ms. Also `start_map_base` (C's `LiveMap.start`, else the same grid and labelled placeholder prior) | `tests/pipeline/test_mission_api.py` (test 4) |
| `queue.py` | `PhotoQueue` protocol, `LocalQueue` (one worker thread, jobs in upload order). `SqsQueue` is still to do (D-W1) | test 4 |
| `effects.py` | LANE_D §5.4: `on_decision` (approved `assign_sector` → task + team assigned; approved `promote_detection` → `detection.new`), `on_task_update` (POD only when searched; ground step via C), `on_clue`, `on_review`, `on_conditions`, `on_fleet` (`on_leg_done` hooks). C's map steps are skipped with a note until C lands | test 5 rows |
| `../api/missions.py` | Contract §13 as one `APIRouter` + `MissionContext` (store, queue, detector, hooks). Mounted by `create_app(missions=…)` or `create_app(mission_root=…)`; `serve` turns it on (`--mission-root missions`, `--backend cv2\|torch`). Endpoints that need B (conditions, cards) or C (debrief) answer 503 naming what they wait for | `tests/pipeline/test_mission_api.py` |
| `../api/sse.py` | SSE: `event:`/`id:`/`data:` frames, heartbeat comment every 15 s, resume from `Last-Event-ID` (or `?after=`, since `EventSource` can't set headers on the first connect) | test 6 |
| `_live.py` | `ReplayLiveMap`: a stand-in for C's `LiveMap` that can only **replay** updates (`apply`, `p`, `sector_poa`), so `store.live()` works before C-L1. Also `apply_reweight` (C's will replace it) | test 3 (restart rebuilds the same map) |

Contract v1.2 (D-C1) is on `main` too: `sightline/contract.py` (all §12.2 models), `docs/01_CONTRACT.md` §12–§14,
`web/src/contract.ts` regenerated, extras in `pyproject.toml`, `.env.example` (PR #52).

```python
from sightline.mission import MissionStore, validate_mission

store = MissionStore(Path("missions"))
m = store.create("Seymour — missing hiker", "Mount Seymour", LatLon(lat=49.37, lon=-122.94), "live")
store.put_map_base(m.mission_id, base)  # C's LiveMap.start(lkp).base
u = store.live(m.mission_id).frame_update(...)  # C computes the update…
store.append_map_update(m.mission_id, u)  # …the store numbers, saves, applies and emits it
assert validate_mission(store.root, m.mission_id) == []
```

## Decisions lane D should check

These weren't spelled out in the contract; each is one place in `store.py` to change if you disagree.

1. **LiveMap methods compute an update; `append_map_update` applies it** to the cached map (and
   assigns `seq`). So C's `frame_update` etc. must **not** apply their own result, or the map is stepped
   twice. Tell lane C (or flip it: drop the `apply` in `append_map_update`).
2. **`store.live()` needs a constructor from a stored base:** it calls `LiveMap.from_base(base)` when
   `sightline.search.live` exists, else the stand-in. §14 only lists `LiveMap.start(lkp)`, so lane C
   needs to add `from_base` (or pass your own `live_factory=` to `MissionStore`).
3. **`append_detections` emits `detection.new`** for each candidate (`crop` set), so the pipeline
   shouldn't emit it again.
4. **`decide_proposal` applies `edits`** (`briefing`, `team`) before saving, and for an approved
   `drone_leg`/`retask_drone` puts the leg in the fleet as `approved`, sets the drone's `leg_id`,
   and cancels the drone's previous leg (invariant 8: the only place legs become approved/cancelled).
   Everything else in LANE_D §5.4 (tasks, teams, review queue, hooks) is for `effects.py`.
5. **`append_frame` keeps the survey valid:** a new frame's `flight_index` is the number of frames so
   far and its `rank` is that + 1, until `rank_frames_live` calls `set_frames`.
6. **`add_clue` raises `ValueError`** for a radio clue without `confirmed_by_turn` (the API should
   answer 422) and sets `confirmed=True` otherwise.
7. **`validate_mission`'s "no truth" check** flags keys matching `truth`, `gt_`, `has_person`,
   `hidden_person`, `person_box` anywhere in a mission file. C's scenario files must keep the hidden
   person out of the API.
8. **No `radio` extra** in `pyproject.toml`: NeMo pins its own torch and Lightning, so the radio's
   speech models live in their own environment (`sightline/radio/README.md`).
9. **Mission API choices:** new missions get teams T1–T4 (3 members each, a placeholder) on standby;
   sector tasks are seeded only once C's `lattice_sectors` exists. A rejection needs a reason (422).
   A clue's default radius by kind (`CLUE_RADIUS_M`: object 25 m … sound 200 m) stands in for B's
   `resolve_position`. `/health` now returns `contract_version` and `backend` (contract §13).
10. **Frame ids are given out at upload** (`POST /photos` returns them, contract §13), so the worker
   must process each mission's jobs in order and never drop one: a detector failure still adds the
   frame with no detections (`photo.processed` says `detector failed`). Photos are checked at upload
   (JPEG or DJI's MPO, ≤ 60 MB, ≤ 100 MP, pose readable and nadir), so the worker rarely fails.
11. **`effects.py` signatures** take `hooks` instead of `live` (LANE_D §4 listed `live`): the store
   already holds each mission's live map (`store.live`).
12. **`pnpm gen:contract` was broken** (pnpm runs it in `web/`, and the paths assumed the repo root).
   Fixed in `web/package.json`.

## Lane D checklist (LANE_D §7)

- [x] **D-C1** contract v1.2 (lane A, PR #52)
- [x] **D-M0** `MissionStore` + `validate_mission`, tests 2–3 (lane A)
- [ ] D-G1 repo hygiene (`CLAUDE.md`, sprint docs into `docs/`, labels, issue templates)
- [x] **D-A1** mission API + SSE (`sightline/api/missions.py`, `sse.py`), test 6 (lane A)
- [x] **D-P1** per-photo pipeline + local queue, test 4; detector via `make_detector()` (closes #8 for the live path) (lane A)
- [x] `effects.py` (§5.4), test 5 (lane A)
- [ ] Mount `radio_router` with a `RadioContext` (D-R4, `sightline/radio/README.md`): needs a `MissionApi` adapter over the store
- [ ] `SqsQueue` + `worker` command (D-W1); conditions scheduler every 30 min (needs B-W1); `on_tick` every 5 min / 25 photos
- [ ] D-S1 `scripts/smoke.sh`
- [ ] D-M1/M2 `useMission`, D-L1 live shell, D-Q1 review live mode, D-I1 New search, D-R1–R3 routing
- [ ] D-W1 AWS (`deploy/aws/` already has lane A's worker image, see its README)
- [ ] Sample cache regenerated as 1.2 (optional: 1.1 caches are still readable)
- [ ] Delete `_live.py` when C-L1 lands

## Measured (Tue Oct 21, `serve` on the GPU desktop, cv2 backend, fake LLM)

One real HERIDAL **val** photo (`train_BRK_2048.jpg`, 4000×3000, DJI metadata) uploaded through
`POST /photos`: accepted as `f0001`, 2 candidates (0.814, 0.801), `photo.processed` after **2.1 s**
(pose 174 ms, cv2.dnn detect 1.8 s, store 130 ms), events streamed over SSE, `validate_mission` → `[]`.
It found one bug the unit tests didn't: DJI photos open in Pillow as **MPO**, not JPEG (fixed).

