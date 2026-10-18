"""Acceptance tests for Lane D's drafted Lane B call interface."""

from __future__ import annotations

import math

import pytest

from sightline.contract import Pose
from sightline.geo import simulate_flight as adapted_flight
from sightline.geo.constants import LKP, SECTOR_NW
from sightline.geo.flight import FlightPlan
from sightline.geo.flight import simulate_flight as native_flight
from sightline.geo.project import METRES_PER_DEGREE, footprint
from sightline.pipeline.lanes import Lanes


# Confirm Lane D receives the exact number of real Lane B poses without a fallback note.
def test_pipeline_uses_lane_b_flight() -> None:
    lanes = Lanes()

    flight = lanes.flight(500, seed=7)

    assert len(flight.poses) == 500
    assert flight.poses[0].heading_deg == 90.0
    assert flight.poses[25].heading_deg == 270.0
    assert "simulate_flight" not in lanes.placeholder_notes()


# Lock the 500-frame demo to the selected Mount Seymour survey sector.
def test_demo_flight_uses_fixed_sector() -> None:
    assert LKP.lat == pytest.approx(49.370000000)
    assert LKP.lon == pytest.approx(-122.945000000)
    assert SECTOR_NW.lat == pytest.approx(49.371455264)
    assert SECTOR_NW.lon == pytest.approx(-122.947089989)

    adapted = adapted_flight(500)
    expected = native_flight(FlightPlan(sector_nw=SECTOR_NW))

    assert adapted.poses == expected


# Keep non-demo uploads centred instead of anchoring taller paths to the demo sector.
def test_non_demo_flight_remains_centred_on_lkp() -> None:
    flight = adapted_flight(1200)
    latitudes = [pose.lat for pose in flight.poses]
    longitudes = [pose.lon for pose in flight.poses]

    assert (min(latitudes) + max(latitudes)) / 2 == pytest.approx(LKP.lat)
    assert (min(longitudes) + max(longitudes)) / 2 == pytest.approx(LKP.lon)


# Ensure every 500-frame demo footprint stays inside the LKP-centred 1 km grid.
def test_demo_footprints_fit_search_grid() -> None:
    longitude_scale = METRES_PER_DEGREE * math.cos(math.radians(LKP.lat))

    for pose in adapted_flight(500).poses:
        for lon, lat in footprint(pose, 1000, 750):
            east_m = (lon - LKP.lon) * longitude_scale
            north_m = (lat - LKP.lat) * METRES_PER_DEGREE
            assert abs(east_m) <= 500
            assert abs(north_m) <= 500


# Confirm Lane D's pose-first box tuple is adapted to Lane B's Box-first projection API.
def test_pipeline_uses_lane_b_georef() -> None:
    lanes = Lanes()
    pose = Pose(
        lat=49.37,
        lon=-122.945,
        alt_agl_m=None,
        heading_deg=90.0,
        gsd_m=0.02,
    )

    lat, lon, radius_m = lanes.georef(pose, (450, 325, 550, 425), 1000, 750)

    assert lat == pytest.approx(pose.lat)
    assert lon == pytest.approx(pose.lon)
    assert radius_m == 10.0
    assert "georef_detection" not in lanes.placeholder_notes()
