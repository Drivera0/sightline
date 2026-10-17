"""Acceptance test for the documented DJI reference photo."""

from __future__ import annotations

import math
from pathlib import Path

import pytest

pytest.importorskip("sightline.contract")

from sightline.geo.pose import read_pose
from sightline.geo.project import footprint


FIXTURE = Path(__file__).parent / "fixtures" / "test_SB_0007.jpg"


@pytest.mark.skipif(not FIXTURE.exists(), reason="DJI fixture has not been supplied")
def test_reference_dji_pose() -> None:
    info = read_pose(FIXTURE)

    assert info is not None
    assert info.pose.alt_agl_m == pytest.approx(51.9, abs=0.2)
    assert info.pose.heading_deg == pytest.approx(215.9, abs=0.2)
    assert info.nadir is True
    corners = footprint(info.pose, 4000, 3000)
    assert len(corners) == 4
    assert _distance_m(corners[0], corners[1], info.pose.lat) == pytest.approx(
        90.0, abs=3.0
    )


def _distance_m(
    first: tuple[float, float], second: tuple[float, float], latitude: float
) -> float:
    east_m = (second[0] - first[0]) * 111_320 * math.cos(math.radians(latitude))
    north_m = (second[1] - first[1]) * 111_320
    return math.hypot(east_m, north_m)
