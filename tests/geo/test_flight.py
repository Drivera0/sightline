"""Acceptance tests for the documented 500-pose flight path."""

from __future__ import annotations

import math

import pytest

from sightline import contract
from sightline.geo.flight import FlightPlan, simulate_flight
from sightline.geo.project import footprint


def test_default_flight_plan_has_documented_shape() -> None:
    sector_nw = contract.LatLon(lat=49.371, lon=-122.947)
    plan = FlightPlan(sector_nw=sector_nw)
    poses = simulate_flight(plan)

    assert len(poses) == 500
    assert plan.sector_width_m == pytest.approx(303.0)
    assert plan.sector_height_m == pytest.approx(324.0)
    assert {pose.heading_deg for pose in poses[:25]} == {90.0}
    assert {pose.heading_deg for pose in poses[25:50]} == {270.0}
    assert poses[0].lon < poses[1].lon
    assert poses[25].lon > poses[26].lon
    assert _distance_m(poses[0], poses[1]) == pytest.approx(12.0, abs=0.01)
    assert _distance_m(poses[0], poses[49]) == pytest.approx(16.0, abs=0.01)


# Verify every default-plan footprint remains inside the documented sector.
def test_all_footprints_stay_inside_sector() -> None:
    sector_nw = contract.LatLon(lat=49.371, lon=-122.947)
    plan = FlightPlan(sector_nw=sector_nw)

    for pose in simulate_flight(plan):
        for lon, lat in footprint(pose, plan.frame_w_px, plan.frame_h_px):
            east_m, south_m = _offset_from_nw_m(sector_nw, lat, lon)
            assert -0.01 <= east_m <= plan.sector_width_m + 0.01
            assert -0.01 <= south_m <= plan.sector_height_m + 0.01


def _distance_m(first, second) -> float:
    latitude = (first.lat + second.lat) / 2.0
    east_m = (second.lon - first.lon) * 111_320 * math.cos(math.radians(latitude))
    north_m = (second.lat - first.lat) * 111_320
    return math.hypot(east_m, north_m)


# Convert a point into east/south metre offsets from a north-west origin.
def _offset_from_nw_m(origin, lat: float, lon: float) -> tuple[float, float]:
    east_m = (lon - origin.lon) * 111_320 * math.cos(math.radians(origin.lat))
    south_m = (origin.lat - lat) * 111_320
    return east_m, south_m
