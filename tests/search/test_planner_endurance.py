"""The planner budgets the fleet's airframe endurance (DJI Mavic 3 Enterprise, fleet.py), not a flat
30 minutes, unless a number is set."""

from __future__ import annotations

import pytest

from sightline.contract import Leg
from sightline.search.fleet import MAVIC_3E
from sightline.search.planner import PlannerConfig, _limits, endurance_min
from tests.search.test_planner import NOW, _drone


def _leg(minutes: float) -> Leg:
    return Leg(id="L1", drone_id="D1", sector_id="B2", waypoints=[[0, 0], [0, 1]], altitude_m=50,
               est_minutes=minutes, expected_clearance=0.1, score_per_min=0.1, reason="r",
               status="proposed")  # fmt: skip


def test_endurance_is_the_airframe_at_the_drones_airspeed() -> None:
    d = _drone()
    assert endurance_min(d, PlannerConfig()) == pytest.approx(100 / MAVIC_3E.drain_pct_per_min(8))
    assert 43 < endurance_min(d, PlannerConfig()) < 45
    assert endurance_min(d, PlannerConfig(endurance_min=30.0)) == 30.0


def test_a_leg_that_fits_the_airframe_but_not_30_minutes_is_allowed() -> None:
    d = _drone(battery=50)  # 30 min: 12 min budget; the airframe at 8 m/s: about 17.6 min
    assert _limits(d, _leg(15), None, NOW, PlannerConfig(), 0.0) is None
    assert _limits(d, _leg(15), None, NOW, PlannerConfig(endurance_min=30.0), 0.0) == "battery"
    assert _limits(d, _leg(19), None, NOW, PlannerConfig(), 0.0) == "battery"
