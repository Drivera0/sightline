# Lane B implementation reference

This file tracks the Lane B functions that exist today and the work that still
needs to be completed. The shared data shapes remain defined by
`lane-b/01_CONTRACT.md`; this README describes implementation status only.

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
| `simulate_flight(n_frames, seed)` | Adapts Lane D's frame-count call to Lane B's `FlightPlan` API and centres the generated sector on the LKP until `SECTOR_NW` is agreed. | `SimulatedFlight` with exactly `n_frames` poses, LKP and area name |
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

Status: implemented and smoke-tested. Final `SECTOR_NW` remains undecided.

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

## Map functions

### `web/src/map/MapView.tsx`

Status: cache-backed base layers implemented.

| Function | Purpose |
|---|---|
| `MapProvider(props)` | Creates and owns the single MapLibre instance and exposes it through React context. |
| `useMap()` | Returns the shared map plus `flyTo`; raises an error outside `MapProvider`. |
| `BaseMapLayers()` | Synchronizes the sample/demo cache, map clicks, shared selection and uncertainty label. |
| `MapView(props)` | Renders the cache-backed base layers plus optional caller-supplied layers. |

### `web/src/map/base/features.ts`

| Function | Purpose |
|---|---|
| `buildFootprintFeatures(survey)` | Converts contract footprints into closed GeoJSON polygons. |
| `buildFlightPathFeature(survey)` | Joins frame centres in `flight_index` order. |
| `buildDetectionFeatures(detections)` | Converts candidate detections into uncertainty-circle polygons. |
| `buildLkpFeature(survey)` | Creates the last-known-point GeoJSON feature. |
| `surveyBounds(survey)` | Calculates the initial map bounds from every footprint. |

### `web/src/map/base/layers.ts`

| Function | Purpose |
|---|---|
| `readMapColors(root)` | Resolves shared CSS colour tokens for MapLibre canvas paint. |
| `syncBaseLayers(map, bundle)` | Adds or refreshes the footprint, flight-path, detection and LKP sources/layers. |
| `setSelectedFootprint(map, frameId)` | Highlights the frame selected from either the map or review queue. |

### `web/src/map/base/basemap.ts`

| Function | Purpose |
|---|---|
| `chooseBasemapMode(mapTilerKey, online)` | Selects satellite mode only when a key and connectivity are available; otherwise selects offline mode. |

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
- [ ] Agree on `LKP` and `SECTOR_NW` with Lane C, then set `SECTOR_NW` in
  `constants.py`.
- [x] Consume Lane A's in-process `sightline.ml.types.Box` directly.
- [x] Review Lane D's draft interfaces and provide compatible root adapters for
  `simulate_flight`, `footprint` and `georef_detection`.
- [x] Validate `read_pose()` with the original `test_SB_0009.JPG` image.
- [x] Audit all 101 release images and validate nadir/oblique examples from
  `data/heridal/yolo_full/test/images/`.

### Required map implementation

- [x] Connect `MapView` to Lane D's cache loader and selection store.
- [ ] Add MapTiler satellite style construction using
  `VITE_MAPTILER_KEY` without committing the key.
- [ ] Add the offline North Shore PMTiles source and style.
- [ ] Implement the grid-outline layer.
- [x] Implement the frame-footprint layer.
- [x] Implement the flight-path line. Direction arrows remain optional. This layer may be
  omitted later without affecting the Python projection code.
- [x] Implement basic detection uncertainty circles. Review-state styling waits
  for Lane D's `useReview` store.
- [x] Implement the selected-footprint highlight and queue/map selection sync.
- [x] Implement the last-known-point marker. Its text label remains TODO.
- [x] Add the required simulated-flight-path and contract-provided uncertainty badges.
- [x] Type-check and build the web project; the map unit tests pass in Node mode.
- [ ] Run the complete jsdom suite once Lane D aligns its bleeding-edge web
  dependency/runtime versions; workers currently fail inside transitive jsdom
  dependencies before loading any tests.

### Final validation

- [ ] Verify all 500 footprints against the final search grid coordinates.
- [ ] Exercise the complete queue-to-map `flyTo` interaction.
- [ ] Verify satellite and offline modes at the target screen sizes.
- [ ] Confirm attribution is always visible.
