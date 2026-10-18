# Lane B · Geo: photo pose, pixel-to-GPS, and map base

> **Owner:** Lane B · **Folders:** `sightline/geo/`, `tests/geo/`,
> `web/src/map/MapView.tsx`, `web/src/map/base/`
>
> Read `00_OVERVIEW.md`, `01_CONTRACT.md`, and `05_FRONTEND_SHARED.md` first.

## Mission

Lane B turns camera metadata and detector boxes into map geometry:

```text
JPEG EXIF/XMP ──> Pose ──> footprint
                         └─> detector box centre ──> GPS pin

survey.json + detections.json ──> MapLibre base layers
```

The Mount Seymour demo uses real HERIDAL photos on a clearly labelled simulated
flight. The second survey uses real DJI camera positions from the HERIDAL test
photos so the demo can distinguish real coordinates from the simulation.

The real-position survey is additive. We retained the original simulated Mount
Seymour flight, its search map, and its existing demo flow. The app's survey
selector switches between that simulation and the new `real-gps` survey; it
does not replace or rewrite the Seymour cache.

## Pipeline interface

Lane D calls these exports from `sightline.geo`:

| Function | Purpose |
|---|---|
| `simulate_flight(n_frames, seed)` | Produce one simulated Mount Seymour pose per demo frame. |
| `footprint(pose, width_px, height_px)` | Return image corners as `[lon, lat]` in TL, TR, BR, BL order. |
| `georef_detection(pose, box_px, width_px, height_px)` | Return `(lat, lon, radius_m)` for a box centre. |

Lane B returns contract objects or in-process values. Lane D remains the only
code that writes cache files.

## Projection model

The current projection is intentionally small and testable:

- WGS84 camera-centre latitude/longitude from EXIF.
- Relative altitude, gimbal yaw, and gimbal pitch from DJI XMP.
- Horizontal field of view from the 35 mm-equivalent focal length.
- Ground sampling distance from altitude and field of view.
- Nadir camera and locally flat ground.
- Image heading means the compass direction faced by the top of the image.

`read_pose()` accepts projection only when all required values are present. A
photo is considered nadir when `abs(gimbal_pitch_deg + 90) <= 10`. Metadata for
oblique images is retained, but those photos are not projected by the nadir
model.

The flat-ground model does not account for a terrain elevation model, lens
distortion, GPS receiver error, or altitude error. Those omissions matter when
describing absolute accuracy.

## Real-photo survey

The local `data-v1` audit produced:

| Category | Photos |
|---|---:|
| HERIDAL test photos | 101 |
| Photos with EXIF GPS | 74 |
| Complete GPS + DJI pose + focal metadata | 47 |
| Nadir within ±10° | 28 |
| Complete but oblique, skipped | 19 |
| Missing a complete projection pose | 54 |

The 28 nadir photos belong to five named site groups; at a 500 m separation
limit, one distant BRK photo produces a sixth coherent cluster. They must not be
joined into one displayed flight path. `select_real_photos()` flags missing and
oblique inputs, while `cluster_real_photos()` separates distant sites.

The map-ready local cache uses the largest coherent group: ten `test_SB_*`
photos. Its `simulated_path` value is `false`; the map frames the real
footprints, labels the coordinate source as real EXIF, calls the contract LKP
marker “Survey centre,” and suppresses the line that would otherwise imply a
continuous flight. Satellite mode uses the existing MapTiler key. The bundled
North Shore PMTiles archive does not cover this site.

Local generated outputs are deliberately not contract source code:

- `cache/real-gps/`
- `web/public/cache/real-gps/`
- `data/real-gps/`
- `data/real-gps/work/real_position_eval.json`

Validate the generated cache with:

```bash
uv run python -m sightline.pipeline validate cache/real-gps
```

Run the frontend against it with:

```bash
cd web
VITE_CACHE_DIR=real-gps pnpm dev
```

Rebuild the complete survey from the released data and weights with:

```bash
gh release download weights-v2 -R Drivera0/sightline -D data/weights
uv sync --extra ml
uv run python -m sightline.pipeline real
```

The `real` command audits every pose, runs tiled inference across all accepted
nadir photos, measures the error, selects the largest coherent site, prepares
the fixed-size review frames, runs the normal rank/map/metrics stages, and uses
Lane D's validated exporter for both cache copies.

## Measured detector-pin offset

Evaluation inputs:

- `weights-v2/yolo11s_tiles_run1_best.pt`
- Candidate threshold `0.29`, selected by Lane A on validation data
- Tiled inference on all 28 nadir test photos
- Greedy, one-to-one VOC true positives at IoU ≥ 0.5
- Distance from each predicted box centre to its matched labelled-person box
  centre, converted to metres using that photo's real GSD

Results:

| Measure | Result |
|---|---:|
| Nadir photos evaluated | 28 |
| Labelled people in those photos | 101 |
| Strict true-positive matches measured | 61 |
| Mean centre offset | 0.045 m |
| Median centre offset | 0.037 m |
| 90th-percentile centre offset | **0.079 m** |
| Maximum centre offset | 0.262 m |

The real-position cache uses the measured 0.079 m p90 value for its detection
circles. The UI calls it a “measured label-relative offset,” not an unqualified
GPS accuracy number.

### Accuracy limitation judges should hear

HERIDAL supplies pixel boxes, not surveyed GPS coordinates for each person.
Therefore this experiment measures the detector-box-centre component after
projection. It proves that real camera coordinates and real camera pose drive
the pins, and it measures how box localization propagates into metres. It does
**not** measure absolute ground error from EXIF GPS, relative altitude, terrain,
or the flat-ground assumption. We must not claim “8 cm absolute GPS accuracy.”

## Python implementation

| File | Main functions and responsibility |
|---|---|
| `camera.py` | `hfov_from_f35`, `gsd`: camera geometry. |
| `pose.py` | `read_pose`: EXIF GPS/focal data and DJI XMP pose reader. |
| `project.py` | `pixel_to_latlon`, `latlon_to_pixel`, `footprint`: nadir projection. |
| `detections.py` | `georef_detection`: project a Lane A box centre. |
| `flight.py` | `FlightPlan`, `simulate_flight`: deterministic Mount Seymour demo path. |
| `real.py` | `select_real_photos`, `cluster_real_photos`: accept nadir metadata and keep real sites separate. |
| `position_error.py` | `measure_pin_errors`, `summarize_pin_errors`: VOC-matched metre error statistics. |
| `__init__.py` | Stable adapters used by Lane D's pipeline. |

Every function has a short description directly above it and a docstring.

## Map implementation

| File | Responsibility |
|---|---|
| `MapView.tsx` | Own the MapLibre instance, choose basemap, frame simulated vs. real surveys correctly, and show position badges. |
| `base/features.ts` | Build footprints, optional flight line/arrows, pins, grid, survey centre/LKP, and view bounds. |
| `base/layers.ts` | Synchronize the contract data and review state into MapLibre sources and layers. |
| `base/basemap.ts` | MapTiler satellite style plus the North Shore offline PMTiles fallback. |
| `base/circle.ts` | Build metre-scaled detection polygons. |

## Integration status

This branch starts from Lane D and now includes the necessary integration:

- The app shell offers `sample`, `demo`, and `real-gps` surveys through the
  existing cache store.
- `demo` remains the original simulated Mount Seymour flight. `real-gps` is a
  separate selectable survey using recorded HERIDAL camera coordinates.
- The title uses `survey.area.name`; the footer and badges distinguish a
  simulated path from recorded EXIF positions.
- `python -m sightline.pipeline real` reproducibly rebuilds the survey.
- `export_stage()` chooses truthful notes from `PlaceFile.simulated_path`.
- Switching surveys clears stale cross-screen map selection while review state
  remains isolated by survey ID.

The generated cache is published separately as
`real-gps-cache/real-gps-cache.tar.gz`. Vercel downloads and unpacks that asset
beside the existing `demo-cache` during its build. Generated caches remain
git-ignored; do not commit source data, labels, weights, caches, or private
keys. The validated archive published for this run has MD5
`e0685247aba963442620fdab56725730`.

To replace the release asset after an intentional rebuild:

```bash
tar -czf data/real-gps-cache.tar.gz -C cache real-gps
gh release upload real-gps-cache data/real-gps-cache.tar.gz \
  -R Drivera0/sightline --clobber
```

Lane C should treat this cache as a position demonstration, not as a new
search-effectiveness evaluation. Its prior remains a labelled placeholder.

## Verification

Completed locally:

- Complete Python suite: 664 passing tests.
- Ruff check and format: passing for the complete repository.
- `cache/real-gps`: contract validator passes.
- TypeScript checking, the Vite production build, and the offline bundle check
  complete.
- Complete frontend suite: 306 passing tests under temporary Node 22.23.

The repository's Vitest suite cannot start under the installed Node 20.17
runtime. The current locked `undici` package also needs a newer compression API
than Node 22.12 supplies. Node 22.23 runs the complete suite successfully.
