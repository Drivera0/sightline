"""scripts/fleet_eval.py v2: the realism presets change how a plan is flown, never the plan."""

from __future__ import annotations

import importlib.util
import math
import sys
from pathlib import Path

import numpy as np
import pytest

_PATH = Path(__file__).resolve().parents[2] / "scripts" / "fleet_eval.py"
_spec = importlib.util.spec_from_file_location("fleet_eval", _PATH)
fe = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
sys.modules["fleet_eval"] = fe  # dataclasses look the module up
_spec.loader.exec_module(fe)


class _Leg:
    def __init__(self, drone: str, minutes: float) -> None:
        self.drone_id, self.est_minutes = drone, minutes


class _Pass:
    def __init__(self, drone: str, start: float, minutes: float, cells: dict[int, float]) -> None:
        self.leg, self.start_min, self.cell_time = _Leg(drone, minutes), start, cells


def _passes() -> list:
    # one drone, five 10-minute legs, one cell per leg photographed mid-leg
    return [_Pass("D1", 10.0 * k, 10.0, {k: 10.0 * k + 5}) for k in range(5)]


def test_ideal_flies_the_plan_as_planned() -> None:
    flown, outages, info = fe.realise(_passes(), fe.PRESETS["ideal"], np.random.default_rng(0))
    assert [f.cell_time for f in flown] == [p.cell_time for p in _passes()]
    assert (
        outages == {"D1": []} and info["time_factor"] == 1.0 and math.isinf(info["endurance_min"])
    )


def test_wind_stretches_and_the_battery_adds_swaps() -> None:
    r = fe.Realism(wind_ms=6.0, battery=True)
    flown, _, info = fe.realise(_passes(), r, np.random.default_rng(0))
    assert info["time_factor"] > 1.0 and info["endurance_min"] == pytest.approx(36.0, abs=0.1)
    times = [next(iter(f.cell_time.values())) for f in flown]
    # 36 min of flight per battery: one swap within five stretched 10-minute legs
    k = times[0] / 5  # (info rounds it)
    gaps = np.diff(times)
    assert k == pytest.approx(info["time_factor"], abs=1e-3)
    per_battery = int(info["endurance_min"] // (10 * k))
    swaps = math.ceil(5 / per_battery) - 1
    assert (
        sorted(np.round(gaps - 10 * k, 6)) == [0.0] * (4 - swaps) + [fe.SWAP_MIN] * swaps
        and swaps >= 1
    )


class _Scn:
    prior = np.array([1.0, 0.0, 0.0, 0.0, 0.0])
    canopy = np.zeros(5)


class _Cfg:
    recall = 1.0
    line_spacing_m = 20.0


def test_a_photo_taken_during_an_outage_arrives_when_the_link_is_back() -> None:
    flown = [fe.Flown("D1", {0: 5.0})]
    r = fe.Realism()
    assert set(fe.minutes_to_find(_Scn(), flown, {"D1": []}, _Cfg(), r, 20, 1)) <= {5.0, math.inf}
    out = fe.minutes_to_find(_Scn(), flown, {"D1": [(4.0, 12.0)]}, _Cfg(), r, 20, 1)
    assert set(out[np.isfinite(out)]) == {12.0}


def test_gps_drift_misses_some_finds() -> None:
    flown = [fe.Flown("D1", {0: 5.0})]
    clean = fe.minutes_to_find(_Scn(), flown, {}, _Cfg(), fe.Realism(), 400, 2)
    drift = fe.minutes_to_find(_Scn(), flown, {}, _Cfg(), fe.Realism(gps_sigma_m=10.0), 400, 2)
    assert np.isfinite(drift).mean() < np.isfinite(clean).mean()
