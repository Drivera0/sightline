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
```

## Python functions

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
| `georef_detection(box, pose, width_px, height_px, radius_m=10.0)` | Finds the Lane A box centre and projects it to GPS. | `[x1, y1, x2, y2]`, frame pose and dimensions | `(LatLon, radius_m)` |

The local `Box` alias is currently `Sequence[float]`. It should be reconciled
with Lane A's final in-process detection type without changing the JSON
`box_px` contract.

### `pose.py`

Status: implemented, but not yet tested with an original HERIDAL JPEG.

| Function | Purpose | Output |
|---|---|---|
| `read_pose(image)` | Reads EXIF GPS and focal length plus DJI XMP altitude, yaw and pitch. Returns `None` when required fields are missing. | `RealPoseInfo` or `None` |
| `_gps_decimal(gps, coordinate_key, reference_key)` | Converts EXIF degrees/minutes/seconds into signed decimal degrees. | Float or `None` |
| `_xmp_number(raw, name)` | Extracts one numeric DJI value from JPEG XMP text. | Float or `None` |
| `_as_float(value)` | Safely normalizes EXIF rationals and numeric values. | Float or `None` |

`RealPoseInfo` contains `pose`, `pitch_deg`, `camera_model`, and `nadir`.

## Map functions

### `web/src/map/MapView.tsx`

Status: basic map lifecycle implemented; data layers remain TODO.

| Function | Purpose |
|---|---|
| `MapProvider(props)` | Creates and owns the single MapLibre instance and exposes it through React context. |
| `useMap()` | Returns the shared map plus `flyTo`; raises an error outside `MapProvider`. |
| `MapView(props)` | Convenience wrapper that renders `MapProvider` with supplied layer components. |

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
| `tests/geo/test_pose.py` | Real DJI metadata and footprint check; skipped when the fixture is absent |

## TODO

### Required backend integration

- [ ] Replace the temporary contract-shaped smoke objects with Lane D's real
  `sightline.contract.Pose` and `LatLon` models.
- [ ] Run `uv run pytest tests/geo` and `uv run ruff check sightline/geo` after
  Lane D adds the project configuration and dependencies.
- [ ] Agree on `LKP` and `SECTOR_NW` with Lane C, then set `SECTOR_NW` in
  `constants.py`.
- [ ] Confirm Lane A's in-process `Box` type and update the local alias if
  necessary.
- [ ] Validate `read_pose()` with the original `test_SB_0007.jpg` fixture near
  the end of Lane B work.

### Required map implementation

- [ ] Connect `MapView` to Lane D's cache loader and selection store.
- [ ] Add MapTiler satellite style construction using
  `VITE_MAPTILER_KEY` without committing the key.
- [ ] Add the offline North Shore PMTiles source and style.
- [ ] Implement grid-outline and frame-footprint layers.
- [ ] Implement the flight-path line and direction arrows. This layer may be
  omitted later without affecting the Python projection code.
- [ ] Implement detection uncertainty circles and review-state styling.
- [ ] Implement the selected-footprint highlight and queue/map selection sync.
- [ ] Implement the labelled last-known-point marker.
- [ ] Add the required simulated-flight-path and 10 m uncertainty badges.
- [ ] Run `pnpm test` and `pnpm build` once Lane D supplies the web project.

### Final validation

- [ ] Verify all 500 footprints against the final search grid coordinates.
- [ ] Exercise the complete queue-to-map `flyTo` interaction.
- [ ] Verify satellite and offline modes at the target screen sizes.
- [ ] Confirm attribution is always visible.

