"""Acceptance tests for pixel/ground projection.

These become active as soon as Lane D lands ``sightline.contract``.
"""

from __future__ import annotations

import random
import math

import pytest

contract = pytest.importorskip("sightline.contract")

from sightline.geo.project import footprint, latlon_to_pixel, pixel_to_latlon


@pytest.fixture
def pose():
    return contract.Pose(
        lat=49.369812,
        lon=-122.946130,
        alt_agl_m=None,
        heading_deg=90.0,
        gsd_m=0.02,
    )


def test_centre_pixel_is_pose_location(pose) -> None:
    point = pixel_to_latlon(500, 375, pose, 1000, 750)
    assert point.lat == pytest.approx(pose.lat)
    assert point.lon == pytest.approx(pose.lon)


def test_heading_ninety_maps_top_east_and_right_south(pose) -> None:
    top = pixel_to_latlon(500, 0, pose, 1000, 750)
    right = pixel_to_latlon(1000, 375, pose, 1000, 750)
    assert top.lon > pose.lon
    assert right.lat < pose.lat


def test_heading_zero_maps_top_north_and_right_east() -> None:
    pose = contract.Pose(
        lat=49.369812,
        lon=-122.946130,
        alt_agl_m=None,
        heading_deg=0.0,
        gsd_m=0.02,
    )
    top = pixel_to_latlon(500, 0, pose, 1000, 750)
    right = pixel_to_latlon(1000, 375, pose, 1000, 750)
    assert top.lat > pose.lat
    assert right.lon > pose.lon


@pytest.mark.parametrize("heading_deg", [0.0, 37.0, 90.0, 215.9, 359.9])
def test_projection_round_trip(heading_deg: float) -> None:
    pose = contract.Pose(
        lat=49.369812,
        lon=-122.946130,
        alt_agl_m=None,
        heading_deg=heading_deg,
        gsd_m=0.02,
    )
    rng = random.Random(7)
    for _ in range(20):
        u = rng.uniform(0, 1000)
        v = rng.uniform(0, 750)
        point = pixel_to_latlon(u, v, pose, 1000, 750)
        actual_u, actual_v = latlon_to_pixel(point, pose, 1000, 750)
        assert actual_u == pytest.approx(u, abs=0.01)
        assert actual_v == pytest.approx(v, abs=0.01)


def test_footprint_has_contract_corner_order(pose) -> None:
    corners = footprint(pose, 1000, 750)
    assert len(corners) == 4
    assert corners[0][0] == pytest.approx(corners[1][0])
    assert corners[0][1] > corners[1][1]
    assert corners[2][0] == pytest.approx(corners[3][0])
    assert corners[0][0] > corners[3][0]


def test_footprint_size_is_twenty_by_fifteen_metres(pose) -> None:
    corners = footprint(pose, 1000, 750)

    assert _distance_m(corners[0], corners[1], pose.lat) == pytest.approx(20.0, abs=0.05)
    assert _distance_m(corners[1], corners[2], pose.lat) == pytest.approx(15.0, abs=0.05)


def test_contract_footprint_example(pose) -> None:
    expected = [
        (-122.946027, 49.369902),
        (-122.946027, 49.369722),
        (-122.946233, 49.369722),
        (-122.946233, 49.369902),
    ]
    for actual_corner, expected_corner in zip(
        footprint(pose, 1000, 750), expected, strict=True
    ):
        assert actual_corner == pytest.approx(expected_corner, abs=1e-6)


def _distance_m(
    first: tuple[float, float], second: tuple[float, float], latitude: float
) -> float:
    east_m = (second[0] - first[0]) * 111_320 * math.cos(math.radians(latitude))
    north_m = (second[1] - first[1]) * 111_320
    return math.hypot(east_m, north_m)
