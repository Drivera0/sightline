"""Acceptance tests for Lane D's drafted Lane B call interface."""

from __future__ import annotations

import pytest

from sightline.contract import Pose
from sightline.pipeline.lanes import Lanes


# Confirm Lane D receives the exact number of real Lane B poses without a fallback note.
def test_pipeline_uses_lane_b_flight() -> None:
    lanes = Lanes()

    flight = lanes.flight(500, seed=7)

    assert len(flight.poses) == 500
    assert flight.poses[0].heading_deg == 90.0
    assert flight.poses[25].heading_deg == 270.0
    assert "simulate_flight" not in lanes.placeholder_notes()


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
