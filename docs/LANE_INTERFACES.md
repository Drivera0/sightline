# Lane interfaces: what lane D's pipeline calls (DRAFT, change freely)

> Written by lane D before lanes B and C published their functions. **These are proposals.**
> If your function looks different, tell lane D or edit the matching method in
> `sightline/pipeline/lanes.py`. No pipeline stage needs to change.

The pipeline looks for each function by name. If it is missing, the stage writes a **placeholder**
(labelled `PLACEHOLDER`) and records it in `manifest.json` notes, so the full run works today.

## Lane B: `sightline.geo`

| Function | Called as | Should return |
|---|---|---|
| `simulate_flight` | `simulate_flight(n_frames, seed)` | One `Pose` per frame, in flight order. Either a list of poses, or an object or dict with `poses`, and optionally `lkp` and `area_name`. `n_frames` is 500 for the demo (20 lines × 25 frames). |
| `footprint` | `footprint(pose, width_px, height_px)` | 4 corners as `[lon, lat]`: top-left, top-right, bottom-right, bottom-left (contract section 6). |
| `georef_detection` | `georef_detection(pose, box_px, width_px, height_px)` | `(lat, lon, radius_m)`, or an object or dict with those names. `radius_m` is 10.0 on the simulated path. |

`Pose` is the contract model (`sightline.contract.Pose`). A dict with the same fields also works.

## Lane C: `sightline.search`

| Function | Called as | Should return |
|---|---|---|
| `build_map` | `build_map(frames, lkp, recall)` | A contract `MapFile`. Optionally also the covered cells per frame: a pair `(map_file, frame_cells)`, or an object with `.map` and `.frame_cells`. `frame_cells` is `{frame_id: [(cell_idx, canopy, overlap), ...]}` for every cell the frame covers: `canopy` is a fraction 0–1 (or `None` if unknown) and `overlap` is a number ≥ 0 (you define the unit; 1.0 = one look). Values are unrounded. If you return only a `MapFile`, the pipeline derives cells from the steps with overlap 1.0 and notes it in the manifest. |
| `simulate` | `simulate(map_file, frame_cells)` | A contract `SearchSim` (or a dict with its fields). |

`frames` is a list of `MapFrame` (`sightline.pipeline.lanes.MapFrame`): `id`, `image_path`, `pose`,
`footprint`, `flight_index` and `candidates`. `candidates` is a tuple of `(lat, lon, radius_m)`, one
for each detection in the frame with `conf >= candidate_threshold` (the same detections as the review
queue), so you can hold those cells for review (pod = 0 near a detection). It is empty when the frame
has none. If you need other inputs (a canopy mask, for example), say so.

The pipeline rounds each `pod` to 4 decimals and recomputes `final` and `top_cells` from the
prior, so the contract's replay check (section 11) always holds. You may return unrounded pods.

## Lane A: `sightline.ml` (documented in `LANE_A_ML.md`)

`run_survey(frames_dir, weights, out_dir, candidate_threshold, model_name, save_threshold)` and
`load_split("test")`. Lane A's files are read as written in `LANE_A_ML.md` section 6.4.

## Files between stages

Formats are in `sightline/pipeline/formats.py`. Lane B and C code never writes them; the stages do.

| File | Written by stage | From |
|---|---|---|
| `data/survey/frames.json`, `frames/*.jpg`, `truth.json` | `frames` | `build_survey` |
| `data/work/place/poses.json` | `place` | lane B `simulate_flight`, `footprint` |
| `data/work/detect/*` | `detect` | lane A `run_survey` |
| `data/work/georef/detections_geo.json` | `georef` | lane B `georef_detection` |
| `data/work/rank/rank.json` | `rank` | `rank_frames` |
| `data/work/map/map.json`, `frame_cells.json` | `map` | lane C `build_map` |
| `data/work/metrics/{detector_metrics,ranking,search_sim}.json` | `metrics` | lane A file, `ranking_metrics`, lane C `simulate` |
