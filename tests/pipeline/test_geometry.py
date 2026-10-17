"""Flat-earth geometry used by the placeholder flight, the georef fallback and the sample cache."""

from __future__ import annotations

import math

import pytest

from sightline.contract import LatLon, Pose
from sightline.pipeline.geometry import footprint, pixel_to_latlon, placeholder_flight

LKP = LatLon(lat=49.37, lon=-122.945)


def pose(heading: float, lat: float = 49.369812, lon: float = -122.94613) -> Pose:
    return Pose(lat=lat, lon=lon, alt_agl_m=None, heading_deg=heading, gsd_m=0.02)


def metres(a: tuple[float, float], b: tuple[float, float]) -> tuple[float, float]:
    """(east, north) distance in metres from a to b, both (lon, lat)."""
    north = (b[1] - a[1]) * 111320
    east = (b[0] - a[0]) * 111320 * math.cos(math.radians(a[1]))
    return east, north


# ---------------------------------------------------------------- footprint


def test_footprint_matches_the_contract_example_for_heading_90():
    corners = footprint(pose(90.0))

    expected = [
        (-122.946027, 49.369902),
        (-122.946027, 49.369722),
        (-122.946233, 49.369722),
        (-122.946233, 49.369902),
    ]
    for got, want in zip(corners, expected, strict=True):
        assert got == pytest.approx(want, abs=1e-6)


def test_footprint_is_20_m_by_15_m_around_the_centre():
    tl, tr, br, _bl = footprint(pose(90.0))

    # heading 90: the image top faces east, so the image width (20 m) runs north-south
    assert metres(tl, tr) == pytest.approx((0, -20), abs=0.05)
    assert metres(tr, br) == pytest.approx((-15, 0), abs=0.05)
    centre = ((tl[0] + br[0]) / 2, (tl[1] + br[1]) / 2)
    assert centre == pytest.approx((-122.94613, 49.369812), abs=1e-6)


def test_footprint_for_heading_0_has_the_image_top_to_the_north():
    tl, tr, _br, bl = footprint(pose(0.0))

    assert metres(tl, tr) == pytest.approx((20, 0), abs=0.05)
    assert metres(tl, bl) == pytest.approx((0, -15), abs=0.05)


def test_footprint_for_heading_270_is_the_mirror_of_heading_90():
    east = footprint(pose(90.0))
    west = footprint(pose(270.0))

    assert west[0] == pytest.approx(
        east[2], abs=1e-9
    )  # same rectangle, corners rotated by 180 degrees
    assert west[2] == pytest.approx(east[0], abs=1e-9)


def test_footprint_has_four_distinct_corners():
    corners = footprint(pose(37.0))

    assert len(set(corners)) == 4


# ---------------------------------------------------------------- pixel_to_latlon


def test_frame_centre_pixel_is_the_pose_position():
    lat, lon = pixel_to_latlon(pose(90.0), 500, 375)

    assert (lat, lon) == pytest.approx((49.369812, -122.94613), abs=1e-9)


def test_pixel_to_latlon_matches_the_contract_example_detection():
    # contract section 7: box [512, 300, 560, 362] in frame f0017 -> 49.369806, -122.946118
    lat, lon = pixel_to_latlon(pose(90.0), 536, 331)

    assert (lat, lon) == pytest.approx((49.369806, -122.946118), abs=1e-6)


def test_pixel_to_latlon_moves_right_along_the_heading_plus_90():
    here = pixel_to_latlon(pose(0.0), 500, 375)
    right = pixel_to_latlon(pose(0.0), 600, 375)  # 100 px = 2 m to the right; heading 0 -> east

    east, north = metres((here[1], here[0]), (right[1], right[0]))
    assert (east, north) == pytest.approx((2.0, 0.0), abs=0.01)


def test_pixel_to_latlon_moves_up_the_image_towards_the_heading():
    here = pixel_to_latlon(pose(0.0), 500, 375)
    up = pixel_to_latlon(pose(0.0), 500, 275)  # 100 px up = 2 m; heading 0 -> north

    east, north = metres((here[1], here[0]), (up[1], up[0]))
    assert (east, north) == pytest.approx((0.0, 2.0), abs=0.01)


# ---------------------------------------------------------------- placeholder_flight


def test_placeholder_flight_gives_one_pose_per_frame():
    assert len(placeholder_flight(500, LKP)) == 500
    assert len(placeholder_flight(20, LKP)) == 20


def test_500_frames_make_20_lines_of_25_frames_alternating_direction():
    poses = placeholder_flight(500, LKP)

    assert [p.heading_deg for p in poses[:25]] == [90.0] * 25
    assert [p.heading_deg for p in poses[25:50]] == [270.0] * 25
    assert all(p.gsd_m == 0.02 and p.alt_agl_m is None for p in poses)


def test_frames_in_a_line_are_15_m_apart_and_lines_are_20_m_apart():
    poses = placeholder_flight(500, LKP)

    step = metres((poses[0].lon, poses[0].lat), (poses[1].lon, poses[1].lat))
    # the path snakes: line 1 starts right below the END of line 0 (frame 24)
    gap = metres((poses[24].lon, poses[24].lat), (poses[25].lon, poses[25].lat))
    assert step == pytest.approx((15, 0), abs=0.05)
    assert gap == pytest.approx((0, -20), abs=0.05)


def test_the_whole_flight_is_centred_on_the_lkp_and_inside_the_1_km_grid():
    poses = placeholder_flight(500, LKP)

    offsets = [metres((LKP.lon, LKP.lat), (p.lon, p.lat)) for p in poses]
    assert max(abs(e) for e, _ in offsets) < 500 - 20
    assert max(abs(n) for _, n in offsets) < 500 - 20
    assert sum(e for e, _ in offsets) == pytest.approx(0, abs=1e-6 * len(offsets) * 500)


def test_placeholder_flight_is_deterministic():
    assert placeholder_flight(500, LKP) == placeholder_flight(500, LKP)


def test_a_frame_count_with_no_nice_layout_becomes_a_single_line():
    poses = placeholder_flight(7, LKP)

    assert len(poses) == 7 and {p.heading_deg for p in poses} == {90.0}


# ---------------------------------------------------------------- search grid (contract section 8)


def test_grid_corner_matches_the_contract_example():
    from sightline.pipeline.geometry import grid_origin_nw

    origin = grid_origin_nw(LKP)

    assert (origin.lat, origin.lon) == pytest.approx((49.374492, -122.951898), abs=2e-6)


def test_cell_centre_matches_the_contract_example_cell_1288():
    from sightline.contract import Grid
    from sightline.pipeline.geometry import cell_center, grid_origin_nw

    grid = Grid(origin_nw=grid_origin_nw(LKP), cell_m=20, rows=50, cols=50)

    lat, lon = cell_center(grid, 1288)  # row 25, col 38

    assert (lat, lon) == pytest.approx((49.369911, -122.941275), abs=2e-6)


def test_cell_zero_is_in_the_north_west_corner():
    from sightline.contract import Grid
    from sightline.pipeline.geometry import cell_center, grid_origin_nw

    grid = Grid(origin_nw=grid_origin_nw(LKP), cell_m=20, rows=50, cols=50)

    first, last = cell_center(grid, 0), cell_center(grid, 2499)

    assert first[0] > LKP.lat > last[0] and first[1] < LKP.lon < last[1]
