"""Grid geometry tests (LANE_C_SEARCH section 7, item 5; contract section 8)."""

from __future__ import annotations

import math

import pytest

from sightline.contract import Grid, LatLon
from sightline.pipeline import geometry as pipeline_geometry
from sightline.search.grid import (
    M_PER_DEG_LAT,
    cell_center,
    cell_polygon,
    cells_within_radius,
    latlon_to_local_m,
    make_grid,
)

DEMO_LKP = LatLon(lat=49.37, lon=-122.945)


@pytest.fixture
def grid() -> Grid:
    return make_grid(DEMO_LKP)


def _offset(p: LatLon, east_m: float, south_m: float, origin_lat_deg: float) -> LatLon:
    """Move p by metres east and south with the grid's own scale (cos of origin_nw.lat)."""
    return LatLon(
        lat=p.lat - south_m / M_PER_DEG_LAT,
        lon=p.lon + east_m / (M_PER_DEG_LAT * math.cos(math.radians(origin_lat_deg))),
    )


def test_make_grid_shape_and_origin(grid: Grid) -> None:
    assert grid.rows == 50 and grid.cols == 50
    assert grid.cell_m == 20.0
    # The LKP is 500 m south and 500 m east of the north-west corner.
    east_m, south_m = latlon_to_local_m(grid, DEMO_LKP)
    assert east_m == pytest.approx(500.0, abs=1e-6)
    assert south_m == pytest.approx(500.0, abs=1e-6)
    # Same corner as lane D's helper and the contract example (49.374492, -122.951898).
    ref = pipeline_geometry.grid_origin_nw(DEMO_LKP)
    assert grid.origin_nw.lat == pytest.approx(ref.lat, abs=1e-12)
    assert grid.origin_nw.lon == pytest.approx(ref.lon, abs=1e-12)


def test_make_grid_rejects_non_integer_cells() -> None:
    with pytest.raises(ValueError):
        make_grid(DEMO_LKP, size_m=1000.0, cell_m=30.0)


def test_cell_zero_centre_is_10m_south_and_east(grid: Grid) -> None:
    c = cell_center(grid, 0)
    east_m, south_m = latlon_to_local_m(grid, c)
    assert east_m == pytest.approx(10.0, abs=1e-6)
    assert south_m == pytest.approx(10.0, abs=1e-6)


def test_last_cell_is_south_east_corner(grid: Grid) -> None:
    poly = cell_polygon(grid, 2499)
    # Corner order: NW, NE, SE, SW. The SE corner of cell 2499 is the grid's SE corner.
    se_lon, se_lat = poly[2]
    east_m, south_m = latlon_to_local_m(grid, LatLon(lat=se_lat, lon=se_lon))
    assert east_m == pytest.approx(1000.0, abs=1e-6)
    assert south_m == pytest.approx(1000.0, abs=1e-6)


def test_cell_polygon_corner_order_and_open(grid: Grid) -> None:
    idx = 3 * grid.cols + 7  # row 3, col 7
    poly = cell_polygon(grid, idx)
    assert len(poly) == 4 and poly[0] != poly[-1]
    expected_m = [(140.0, 60.0), (160.0, 60.0), (160.0, 80.0), (140.0, 80.0)]
    for (lon, lat), (east_ref, south_ref) in zip(poly, expected_m, strict=True):
        east_m, south_m = latlon_to_local_m(grid, LatLon(lat=lat, lon=lon))
        assert east_m == pytest.approx(east_ref, abs=1e-6)
        assert south_m == pytest.approx(south_ref, abs=1e-6)


@pytest.mark.parametrize("idx", [0, 1, 49, 50, 1275, 1288, 2499])
def test_cell_center_matches_pipeline_geometry(grid: Grid, idx: int) -> None:
    c = cell_center(grid, idx)
    ref_lat, ref_lon = pipeline_geometry.cell_center(grid, idx)
    assert c.lat == pytest.approx(ref_lat, abs=1e-9)
    assert c.lon == pytest.approx(ref_lon, abs=1e-9)


def test_lkp_is_shared_corner_of_four_cells(grid: Grid) -> None:
    expected = sorted(r * grid.cols + c for r in (24, 25) for c in (24, 25))
    # The NW cell's SE corner is the LKP.
    lon, lat = cell_polygon(grid, 24 * grid.cols + 24)[2]
    assert lat == pytest.approx(DEMO_LKP.lat, abs=1e-9)
    assert lon == pytest.approx(DEMO_LKP.lon, abs=1e-9)
    assert cells_within_radius(grid, DEMO_LKP, 1.0) == expected


@pytest.mark.parametrize(("radius_m", "n_cells"), [(9.0, 1), (12.0, 5), (15.0, 9)])
def test_cells_within_radius_at_cell_centre(grid: Grid, radius_m: float, n_cells: int) -> None:
    idx = 10 * grid.cols + 10
    got = cells_within_radius(grid, cell_center(grid, idx), radius_m)
    assert len(got) == n_cells
    assert idx in got
    assert got == sorted(got)


def test_cells_within_radius_near_edge_stays_in_grid(grid: Grid) -> None:
    # 5 m inside the north-west corner, radius 30 m: the window would spill outside.
    p = _offset(grid.origin_nw, east_m=5.0, south_m=5.0, origin_lat_deg=grid.origin_nw.lat)
    got = cells_within_radius(grid, p, 30.0)
    assert got and all(0 <= i < grid.rows * grid.cols for i in got)
    assert 0 in got
    # Columns must not wrap around to the far side of the previous row.
    assert all(i % grid.cols <= 2 and i // grid.cols <= 2 for i in got)


def test_cells_within_radius_outside_grid_is_empty(grid: Grid) -> None:
    p = _offset(grid.origin_nw, east_m=-50.0, south_m=-50.0, origin_lat_deg=grid.origin_nw.lat)
    assert cells_within_radius(grid, p, 5.0) == []


def test_cells_within_radius_zero_radius_keeps_containing_cell(grid: Grid) -> None:
    idx = 7 * grid.cols + 3
    assert cells_within_radius(grid, cell_center(grid, idx), 0.0) == [idx]


def test_cells_within_radius_rejects_negative_radius(grid: Grid) -> None:
    with pytest.raises(ValueError):
        cells_within_radius(grid, DEMO_LKP, -1.0)
