"""Per-frame overlap, canopy and POD tests (LANE_C_SEARCH section 3.3, section 7 item 8)."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from sightline.contract import Grid, LatLon, Pose
from sightline.search.grid import (
    cell_center,
    cells_within_radius,
    latlon_to_local_m,
    local_m_to_latlon,
    make_grid,
)
from sightline.search.pod import FrameInput, frame_step

DEMO_LKP = LatLon(lat=49.37, lon=-122.945)
W_PX, H_PX = 1000, 750  # 20 m x 15 m at 0.02 m per pixel
GSD_M = 0.02
CELL_AREA_M2 = 400.0
FOOTPRINT_AREA_M2 = 300.0
# Lane B scales longitude with cos(pose lat); the grid uses cos(origin_nw lat), 500 m north.
# That shifts east-west lengths by about 1e-4, so area checks allow this relative error.
MODEL_REL_TOL = 1e-3

GREEN = (40, 180, 40)
# Edge neighbours of a cell centre sit exactly 10 m away (a float knife-edge for 10 m);
# diagonal neighbours sit 14.1 m away. 12 m holds the first and not the second.
HELD_RADIUS_M = 12.0


@pytest.fixture
def grid() -> Grid:
    return make_grid(DEMO_LKP)


def _idx(row: int, col: int, grid: Grid) -> int:
    return row * grid.cols + col


def _frame(
    at: LatLon,
    heading_deg: float = 0.0,
    candidates: list[tuple[LatLon, float]] | None = None,
) -> FrameInput:
    return FrameInput(
        frame_id="f0001",
        pose=Pose(lat=at.lat, lon=at.lon, alt_agl_m=None, heading_deg=heading_deg, gsd_m=GSD_M),
        width_px=W_PX,
        height_px=H_PX,
        image=Path("unused.jpg"),
        candidates=candidates or [],
    )


def _flat(colour: tuple[int, int, int]) -> np.ndarray:
    rgb = np.zeros((H_PX, W_PX, 3), dtype=np.uint8)
    rgb[...] = colour
    return rgb


def _black() -> np.ndarray:
    return np.zeros((H_PX, W_PX, 3), dtype=np.uint8)


# --- overlap ----------------------------------------------------------------------------


@pytest.mark.parametrize("heading_deg", [0.0, 90.0])
def test_frame_centred_on_cell_covers_three_quarters(grid: Grid, heading_deg: float) -> None:
    idx = _idx(10, 10, grid)
    f = _frame(cell_center(grid, idx), heading_deg)
    _, cells = frame_step(grid, f, recall=0.8, rgb=_flat(GREEN))
    assert cells[idx][1] == pytest.approx(0.75, abs=1e-3)
    # Anything else is a float sliver from the two longitude scales.
    assert all(a < 1e-3 for i, (_, a) in cells.items() if i != idx)


@pytest.mark.parametrize("heading_deg", [0.0, 17.0, 45.0, 90.0, 133.0, 270.0, 359.0])
@pytest.mark.parametrize("east_m,south_m", [(0.0, 0.0), (3.3, -7.1), (10.0, 10.0), (-9.9, 4.2)])
def test_overlaps_bounded_and_sum_to_footprint_area(
    grid: Grid, heading_deg: float, east_m: float, south_m: float
) -> None:
    e0, s0 = latlon_to_local_m(grid, cell_center(grid, _idx(20, 20, grid)))
    at = local_m_to_latlon(grid, e0 + east_m, s0 + south_m)
    _, cells = frame_step(grid, _frame(at, heading_deg), recall=0.8, rgb=_flat(GREEN))
    assert cells
    assert all(0.0 < a <= 0.75 + 1e-9 for _, a in cells.values())
    total_m2 = sum(a for _, a in cells.values()) * CELL_AREA_M2
    assert total_m2 == pytest.approx(FOOTPRINT_AREA_M2, rel=MODEL_REL_TOL)


def test_frame_on_shared_corner_splits_into_four(grid: Grid) -> None:
    f = _frame(DEMO_LKP)  # LKP is the shared corner of cells (24..25, 24..25)
    _, cells = frame_step(grid, f, recall=0.8, rgb=_flat(GREEN))
    expected = [_idx(r, c, grid) for r in (24, 25) for c in (24, 25)]
    big = sorted(i for i, (_, a) in cells.items() if a > 1e-3)
    assert big == expected
    for i in expected:
        assert cells[i][1] == pytest.approx(0.1875, rel=MODEL_REL_TOL)
    assert list(cells) == sorted(cells)


def test_frame_partly_outside_grid_keeps_only_grid_cells(grid: Grid) -> None:
    at = local_m_to_latlon(grid, 0.0, 0.0)  # the grid's north-west corner
    _, cells = frame_step(grid, _frame(at), recall=0.8, rgb=_flat(GREEN))
    assert list(cells) == [0]
    assert cells[0][1] == pytest.approx(10 * 7.5 / CELL_AREA_M2, rel=MODEL_REL_TOL)


def test_frame_fully_outside_grid_is_empty(grid: Grid) -> None:
    far = LatLon(lat=DEMO_LKP.lat + 0.01, lon=DEMO_LKP.lon)  # about 1.1 km north
    steps, cells = frame_step(grid, _frame(far), recall=0.8, rgb=_flat(GREEN))
    assert steps == [] and cells == {}


# --- canopy and POD ----------------------------------------------------------------------


def test_black_image_is_full_canopy_and_drops_out(grid: Grid) -> None:
    steps, cells = frame_step(grid, _frame(DEMO_LKP), recall=0.8, rgb=_black())
    assert steps == []
    assert cells
    assert all(c == 1.0 for c, _ in cells.values())


def test_flat_green_image_is_open_and_pod_is_recall_times_overlap(grid: Grid) -> None:
    steps, cells = frame_step(grid, _frame(DEMO_LKP), recall=0.8, rgb=_flat(GREEN))
    assert all(c == 0.0 for c, _ in cells.values())
    step = dict(steps)
    for idx, (_, a) in cells.items():
        pod = min(0.95, 0.8 * a)
        if pod >= 0.001:
            assert step[idx] == pytest.approx(pod)
        else:
            assert idx not in step
    assert [i for i, _ in steps] == sorted(step)


def test_pod_never_exceeds_cap(grid: Grid) -> None:
    f = _frame(cell_center(grid, _idx(5, 5, grid)))
    steps, _ = frame_step(grid, f, recall=1.0, pod_cap=0.3, rgb=_flat(GREEN))
    assert steps
    assert max(p for _, p in steps) == pytest.approx(0.3)
    assert all(p <= 0.3 for _, p in steps)


def test_canopy_values_are_floats_in_unit_range(grid: Grid) -> None:
    rng = np.random.default_rng(3)
    rgb = rng.integers(0, 256, size=(H_PX, W_PX, 3), dtype=np.uint8)
    _, cells = frame_step(grid, _frame(DEMO_LKP, 33.0), recall=0.8, rgb=rgb)
    for c, a in cells.values():
        assert type(c) is float and type(a) is float
        assert 0.0 <= c <= 1.0


def test_half_black_image_projects_onto_the_right_compass_side(grid: Grid) -> None:
    # Heading 90: the image top faces east. Top half black, bottom half green.
    rgb = _flat(GREEN)
    rgb[: H_PX // 2] = 0
    # Centre on the north-south edge between cells (24, 24) and (24, 25), mid-way down the row.
    e0, s0 = latlon_to_local_m(grid, cell_center(grid, _idx(24, 24, grid)))
    at = local_m_to_latlon(grid, e0 + 10.0, s0)
    _, cells = frame_step(grid, _frame(at, 90.0), recall=0.8, rgb=rgb)
    west, east = cells[_idx(24, 24, grid)], cells[_idx(24, 25, grid)]
    assert west[1] == pytest.approx(0.375, rel=MODEL_REL_TOL)
    assert east[1] == pytest.approx(0.375, rel=MODEL_REL_TOL)
    assert east[0] > 0.9  # the dark half is east
    assert west[0] < 0.1


def test_shape_mismatch_raises(grid: Grid) -> None:
    with pytest.raises(ValueError, match="shape"):
        frame_step(grid, _frame(DEMO_LKP), recall=0.8, rgb=np.zeros((10, 10, 3), np.uint8))


def test_canopy_thresholds_pass_through(grid: Grid) -> None:
    # A mid-grey image is not canopy by default; a high shadow threshold makes it shadow.
    grey = _flat((100, 100, 100))
    _, cells_default = frame_step(grid, _frame(DEMO_LKP), recall=0.8, rgb=grey)
    _, cells_dark = frame_step(grid, _frame(DEMO_LKP), recall=0.8, rgb=grey, shadow_thr=200)
    assert all(c == 0.0 for c, _ in cells_default.values())
    assert all(c == 1.0 for c, _ in cells_dark.values())


def test_reads_image_from_disk_when_rgb_not_given(grid: Grid, tmp_path: Path) -> None:
    from PIL import Image

    path = tmp_path / "f.png"
    Image.fromarray(_black()).save(path)
    f = _frame(DEMO_LKP)
    f = FrameInput(f.frame_id, f.pose, f.width_px, f.height_px, path, f.candidates)
    steps, cells = frame_step(grid, f, recall=0.8)
    assert steps == [] and all(c == 1.0 for c, _ in cells.values())


# --- held for review -----------------------------------------------------------------------


def _corner_frame_cells(grid: Grid) -> list[int]:
    return [_idx(r, c, grid) for r in (24, 25) for c in (24, 25)]


def test_candidate_in_frame_zeroes_cells_within_radius(grid: Grid) -> None:
    held_cell = _idx(24, 24, grid)
    cand = (cell_center(grid, held_cell), HELD_RADIUS_M)
    f = _frame(DEMO_LKP, candidates=[cand])
    steps, cells = frame_step(grid, f, recall=0.8, rgb=_flat(GREEN))
    zeroed = set(cells_within_radius(grid, *cand))
    # (24, 24) itself and its edge neighbours (24, 25) and (25, 24); not the diagonal (25, 25).
    assert {held_cell, _idx(24, 25, grid), _idx(25, 24, grid)} <= zeroed
    step = dict(steps)
    for idx in _corner_frame_cells(grid):
        assert idx in cells  # (canopy, overlap) is kept for held cells
        assert (idx in step) == (idx not in zeroed)
    assert step[_idx(25, 25, grid)] == pytest.approx(0.8 * 0.1875, rel=MODEL_REL_TOL)


def test_held_from_another_frame_also_zeroes_cells(grid: Grid) -> None:
    other = (cell_center(grid, _idx(25, 25, grid)), HELD_RADIUS_M)
    f = _frame(DEMO_LKP)  # this frame found nothing itself
    steps, cells = frame_step(grid, f, recall=0.8, held=[other], rgb=_flat(GREEN))
    assert dict(steps).keys() == {_idx(24, 24, grid)}
    assert set(_corner_frame_cells(grid)) <= set(cells)


def test_held_none_falls_back_to_frame_candidates(grid: Grid) -> None:
    cand = (cell_center(grid, _idx(25, 25, grid)), HELD_RADIUS_M)
    f = _frame(DEMO_LKP, candidates=[cand])
    steps_none, _ = frame_step(grid, f, recall=0.8, held=None, rgb=_flat(GREEN))
    steps_same, _ = frame_step(grid, f, recall=0.8, held=[cand], rgb=_flat(GREEN))
    steps_empty, _ = frame_step(grid, f, recall=0.8, held=[], rgb=_flat(GREEN))
    assert steps_none == steps_same
    assert dict(steps_none).keys() == {_idx(24, 24, grid)}
    assert dict(steps_empty).keys() == set(_corner_frame_cells(grid))
