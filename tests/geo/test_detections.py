"""Acceptance tests for detection georeferencing."""

from __future__ import annotations

import pytest

from sightline import contract
from sightline.geo.detections import SIMULATED_RADIUS_M, georef_detection
from sightline.ml.types import Box


def test_box_centre_is_georeferenced() -> None:
    pose = contract.Pose(
        lat=49.37,
        lon=-122.945,
        alt_agl_m=None,
        heading_deg=0.0,
        gsd_m=0.02,
    )
    point, radius_m = georef_detection(Box(450, 325, 550, 425), pose, 1000, 750)

    assert point.lat == pytest.approx(pose.lat)
    assert point.lon == pytest.approx(pose.lon)
    assert radius_m == SIMULATED_RADIUS_M
