# Lane B implementation reference

This file tracks the Lane B functions that exist today and the work that still
needs to be completed. The shared data shapes remain defined by
`docs/01_CONTRACT.md`; this README describes implementation status only.

The current canonical lane specification, including the real-EXIF survey and
measured label-relative pin error, is `docs/LANE_B_GEO.md`.

## Processing flow

```text
camera metadata ──> camera.py ──> pose.py ──> Pose
                                             │
Lane A box_px ──> detections.py ─────────────┤
                                             ▼
                                   project.py pixel/GPS math
                                             │
                                             ▼
                                 LatLon, footprints, map data

FlightPlan ──> flight.py ──> 500 simulated Pose objects ──> project.py
                         │
                         └──> __init__.py adapters ──> Lane D pipeline
```

## Python functions

### `__init__.py` pipeline adapters

Status: implemented against `docs/LANE_INTERFACES.md` and
`sightline/pipeline/formats.py`.

| Function | Purpose | Output |
|---|---|---|
| `simulate_flight(n_frames, seed)` | Uses the fixed demo sector for 500 frames and centres differently sized uploaded surveys on the LKP. | `SimulatedFlight` with exactly `n_frames` poses, LKP and area name |
| `georef_detection(pose, box_px, width_px, height_px)` | Converts Lane D's tuple box and pose-first argument order to Lane B's typed `Box` API. | `(lat, lon, radius_m)` |

Lane B's native functions in `flight.py` and `detections.py` retain their typed,
math-focused signatures. The root adapters are the stable pipeline seam.

### `camera.py`

Status: implemented and smoke-tested.

| Function | Purpose | Main inputs | Output |
|---|---|---|---|
| `hfov_from_f35(f35_mm, width_px, height_px)` | Converts a 35 mm-equivalent focal length into horizontal field of view. | Focal length and image dimensions | FOV in degrees |
| `gsd(alt_agl_m, hfov_deg, width_px)` | Calculates how many metres of ground each horizontal pixel represents. | Altitude, FOV and image width | Metres per pixel |

### `project.py`

Status: implemented and smoke-tested against contract examples.

| Function | Purpose | Main inputs | Output |
|---|---|---|---|
| `pixel_to_latlon(u, v, pose, width_px, height_px)` | Projects one image pixel onto flat ground using the frame pose. | Pixel, `Pose`, image dimensions | Contract `LatLon` |
| `latlon_to_pixel(p, pose, width_px, height_px)` | Reverses the projection for Lane C's grid coverage calculations. | `LatLon`, `Pose`, image dimensions | `(u, v)` pixel tuple |
| `footprint(pose, width_px, height_px)` | Projects all four image corners in top-left, top-right, bottom-right, bottom-left order. | `Pose`, image dimensions | Four `[lon, lat]` pairs |
| `_validate_dimensions(width_px, height_px)` | Rejects zero or negative image dimensions. | Image dimensions | None; raises `ValueError` when invalid |

### `flight.py`

Status: implemented and tested with the fixed 500-frame demo sector.

Selected demo coordinates:

| Constant | Latitude | Longitude | Purpose |
|---|---:|---:|---|
| `LKP` | `49.370000000` | `-122.945000000` | Centre of the 1 km search grid and last-known-point marker |
| `SECTOR_NW` | `49.371455264` | `-122.947089989` | Northwest corner of the 303 × 324 m simulated survey |

The demo sector is centred on the LKP. It leaves approximately 348.5 m on its
west/east sides and 338 m on its north/south sides inside the search grid.
`SECTOR_NW` applies only to the 500-frame demo; other frame counts remain
dynamically centred so larger uploaded surveys are not shifted outside the
grid.

| Function or property | Purpose | Output |
|---|---|---|
| `FlightPlan.__post_init__()` | Validates that all dimensions and spacings are positive. | None; raises `ValueError` when invalid |
| `FlightPlan.footprint_along_m` | Calculates footprint length along an east-west flight line. | Metres |
| `FlightPlan.footprint_across_m` | Calculates footprint width across flight lines. | Metres |
| `FlightPlan.sector_width_m` | Calculates total survey width. Defaults to `303 m`. | Metres |
| `FlightPlan.sector_height_m` | Calculates total survey height. Defaults to `324 m`. | Metres |
| `simulate_flight(plan)` | Generates poses in alternating east-west lawnmower order. | `lines × frames_per_line` contract `Pose` objects |

Default `FlightPlan` attributes:

| Attribute | Default |
|---|---:|
| `lines` | `20` |
| `frames_per_line` | `25` |
| `along_m` | `12.0` |
| `across_m` | `16.0` |
| `gsd_m` | `0.02` |
| `frame_w_px` | `1000` |
| `frame_h_px` | `750` |

### `detections.py`

Status: implemented and smoke-tested with contract-shaped objects.

| Function | Purpose | Main inputs | Output |
|---|---|---|---|
| `georef_detection(box, pose, width_px, height_px, radius_m=10.0)` | Finds the Lane A box centre and projects it to GPS. | Lane A `Box`, frame pose and dimensions | `(LatLon, radius_m)` |

The function consumes Lane A's frozen `sightline.ml.types.Box` dataclass. Lane
D remains responsible for serializing it as the JSON `box_px` tuple.

### `pose.py`

Status: implemented and validated against the official 101-image HERIDAL test
split. The reader finds 47 complete DJI poses; 28 satisfy the documented nadir
rule (`abs(pitch_deg + 90) <= 10`). Oblique images retain their metadata but
must not be passed to the flat-ground projection model.

| Function | Purpose | Output |
|---|---|---|
| `read_pose(image)` | Reads EXIF GPS and focal length plus DJI XMP altitude, yaw and pitch. Returns `None` when required fields are missing. | `RealPoseInfo` or `None` |
| `_gps_decimal(gps, coordinate_key, reference_key)` | Converts EXIF degrees/minutes/seconds into signed decimal degrees. | Float or `None` |
| `_xmp_number(raw, name)` | Extracts one numeric DJI value from JPEG XMP text. | Float or `None` |
| `_as_float(value)` | Safely normalizes EXIF rationals and numeric values. | Float or `None` |

`RealPoseInfo` contains `pose`, `pitch_deg`, `camera_model`, and `nadir`.

### `real.py`

Status: implemented and audited on all 101 HERIDAL test photos.

| Function | Purpose | Output |
|---|---|---|
| `select_real_photos(images)` | Keeps complete nadir poses and explicitly flags oblique or incomplete photos. | `RealPhotoSelection` |
| `cluster_real_photos(photos, max_separation_m=500)` | Separates unrelated collection sites so the map never invents a cross-site flight. | Geographic photo clusters, largest first |

### `position_error.py`

Status: implemented and run with weights-v2 at threshold 0.29.

| Function | Purpose | Output |
|---|---|---|
| `measure_pin_errors(detections, truth, pose, threshold)` | Greedily matches VOC true positives and converts box-centre offsets into metres. | `PinErrorSummary` |
| `summarize_pin_errors(errors_m)` | Computes mean, median, p90, and maximum without inventing values for empty input. | `PinErrorSummary` |

Across all 28 nadir images, 92 strict true-positive matches gave a median
label-relative offset of 0.046 m and a p90 of 0.126 m (on the corrected test labels). The
real-position cache reports this offset but uses the standard 10 m radius for its pins. These values do not
include absolute EXIF GPS, altitude, or terrain error; see
`docs/LANE_B_GEO.md` before quoting them.

## Map functions

### `web/src/map/MapView.tsx`

Status: cache-backed base layers implemented.

| Function | Purpose |
|---|---|
| `MapProvider(props)` | Creates and owns the single MapLibre instance and exposes it through React context. |
| `useMap()` | Returns the shared map plus `flyTo`; raises an error outside `MapProvider`. |
| `BaseMapLayers()` | Synchronizes the sample/demo cache, map clicks, shared selection, review answers and uncertainty label. |
| `MapView(props)` | Renders the cache-backed base layers plus optional caller-supplied layers. |

### `web/src/map/base/features.ts`

| Function | Purpose |
|---|---|
| `buildFootprintFeatures(survey)` | Converts contract footprints into closed GeoJSON polygons. |
| `buildFlightPathFeature(survey)` | Joins frame centres in `flight_index` order. |
| `buildFlightDirectionFeatures(survey, everyFrames=5)` | Builds offline-safe line chevrons from sampled frame headings. |
| `buildGridOutlineFeature(grid)` | Converts `map.json`'s north-west origin and metre dimensions into a closed GeoJSON outline. |
| `gridBounds(grid)` | Returns the search-grid corners used for the initial map camera. |
| `buildDetectionFeatures(detections, answers)` | Converts candidate detections into uncertainty-circle polygons with browser-only review state and labels. |
| `buildLkpFeature(survey)` | Creates the last-known-point GeoJSON feature. |
| `surveyBounds(survey)` | Calculates optional survey-focused bounds from every footprint. |

### `web/src/map/base/layers.ts`

| Function | Purpose |
|---|---|
| `readMapColors(root)` | Resolves shared CSS colour tokens for MapLibre canvas paint. |
| `syncDetectionSource(map, bundle, answers)` | Refreshes pin features when Lane D's review answers change. |
| `syncBaseLayers(map, bundle, answers)` | Adds or refreshes the grid, footprints, path arrows, review-aware detections and labelled LKP in display order. |
| `setSelectedFootprint(map, frameId)` | Highlights the frame selected from either the map or review queue. |

### `web/src/map/base/basemap.ts`

| Function | Purpose |
|---|---|
| `chooseBasemapMode(mapTilerKey, online)` | Selects satellite mode only when a key and connectivity are available; otherwise selects offline mode. |
| `mapTilerSatelliteStyle(mapTilerKey)` | Builds the authenticated Satellite V4 style URL without storing a key in source. |
| `readBasemapColors(root)` | Resolves shared CSS tokens for the offline MapLibre style. |
| `offlineBasemapStyle(colors)` | Builds the local PMTiles vector style with bundled glyphs and attribution. |
| `basemapStyle(mode, mapTilerKey, colors)` | Returns the selected online or offline style. |
| `ensurePmtilesProtocol()` | Registers the PMTiles protocol once per browser lifetime. |

### `web/src/map/base/circle.ts`

| Function | Purpose |
|---|---|
| `circlePolygon(lon, lat, radiusM, points=64)` | Builds the closed GeoJSON uncertainty polygon used for a detection pin. |
| `degreesToRadians(value)` | Internal angular conversion used by the geodesic calculation. |
| `radiansToDegrees(value)` | Converts calculated coordinates back to GeoJSON degrees. |

## Tests already written

| File | Coverage |
|---|---|
| `tests/geo/test_camera.py` | Documented DJI FOV/GSD example and invalid inputs |
| `tests/geo/test_project.py` | Centre pixel, headings, round trips, footprint size/order and contract example |
| `tests/geo/test_flight.py` | Pose count, ordering, spacing, survey dimensions and footprint containment |
| `tests/geo/test_detections.py` | Box-centre projection and default uncertainty radius |
| `tests/geo/test_pose.py` | Real nadir metadata/footprint and oblique-frame flag checks; skipped when the test split is absent |
| `tests/geo/test_pipeline_interface.py` | Lane D flight/georef calls resolve to real Lane B functions without placeholder notes |

## TODO

### Required backend integration

- [x] Replace the temporary contract-shaped smoke objects with Lane D's real
  `sightline.contract.Pose` and `LatLon` models.
- [x] Run Geo pytest and Ruff after
  Lane D adds the project configuration and dependencies.
- [x] Select and set the demo `LKP` and `SECTOR_NW` values in `constants.py`.
- [ ] Notify Lane C of the locked coordinates and confirm its grid uses the
  same LKP.
- [x] Consume Lane A's in-process `sightline.ml.types.Box` directly.
- [x] Review Lane D's draft interfaces and provide compatible root adapters for
  `simulate_flight`, `footprint` and `georef_detection`.
- [x] Validate `read_pose()` with the original `test_SB_0009.JPG` image.
- [x] Audit all 101 release images and validate nadir/oblique examples from
  `data/heridal/yolo_full/test/images/`.

### Required map implementation

- [x] Connect `MapView` to Lane D's cache loader and selection store.
- [x] Add MapTiler satellite style construction using
  `VITE_MAPTILER_KEY` without committing the key.
- [x] Add the offline North Shore PMTiles source, local label glyphs and style.
- [x] Implement the grid-outline layer from the frozen `map.grid` contract.
- [x] Implement the frame-footprint layer.
- [x] Implement the flight-path line and offline-safe direction chevrons every five frames.
  These layers may be omitted later without affecting the Python projection code.
- [x] Implement detection uncertainty circles and Lane D `useReview` styling:
  unreviewed, person, not-person and unsure.
- [x] Implement the selected-footprint highlight and queue/map selection sync.
- [x] Implement the last-known-point marker and text label.
- [x] Add the required simulated-flight-path and contract-provided uncertainty badges.
- [x] Type-check and build the web project; the map unit tests pass in Node mode.
- [ ] Run the complete jsdom suite once Lane D aligns its bleeding-edge web
  dependency/runtime versions; workers currently fail inside transitive jsdom
  dependencies before loading any tests.

### Final validation

- [x] Verify all 500 footprint corners remain inside the selected LKP-centred
  1 km search grid.
- [ ] Exercise the complete queue-to-map `flyTo` interaction.
- [ ] Verify satellite and offline modes at the target screen sizes.
- [x] Add the git-ignored `web/.env.local` MapTiler key and verify that MapTiler
  authorizes the Satellite V4 style request.
- [ ] Visually confirm satellite imagery and the online/offline toggle in a browser.
- [x] Keep attribution expanded and include Protomaps/OpenStreetMap attribution
  on the offline source; confirm its final placement during screen-size QA.

### Map validation notes

- The initial camera fits the complete contract grid, not only the smaller
  surveyed footprint area for the simulated demo. Real-position surveys fit
  their actual footprints instead. Queue selection still flies to a detection
  at zoom 18.
- The local PMTiles archive passes the PMTiles verifier, contains the source
  layers used by the style, and is emitted by the production build with its
  local Latin glyph range.
- Pure map, shared-selection and review-item tests pass in Node mode, and the
  TypeScript production build succeeds.
- Live responsive and queue-to-map visual QA remains pending because no browser
  session was available in this workspace. Satellite visual QA also requires
  the deferred `VITE_MAPTILER_KEY`.
- The complete jsdom suite passes under Node 22.20. The installed Node 20.17 is
  too old for the current Vite/jsdom dependency set.
