"""The fleet's airframe, wind and battery (DJI Mavic 3 Enterprise numbers): no API needed."""

from __future__ import annotations

import math

import pytest

from sightline.contract import Drone, LatLon, Leg
from sightline.search.fleet import (
    MAVIC_3E,
    RESERVE_FRAC,
    DroneSim,
    Scenario,
    Wind,
    _to_ll,
    ground_speed,
)

LKP = LatLon(lat=49.375, lon=-122.9375)


def test_drain_matches_dji_hover_and_cruise_endurance() -> None:
    assert 100 / MAVIC_3E.drain_pct_per_min(0.0) == pytest.approx(38.0)  # max hovering time
    assert 100 / MAVIC_3E.drain_pct_per_min(9.0) == pytest.approx(45.0)  # max flight time at 9 m/s
    assert MAVIC_3E.drain_pct_per_min(15.0) == pytest.approx(100 / 38)
    assert MAVIC_3E.drain_pct_per_min(5.0) < MAVIC_3E.drain_pct_per_min(0.0)
    assert MAVIC_3E.drain_pct_per_min(12.0) > MAVIC_3E.drain_pct_per_min(9.0)
    assert MAVIC_3E.max_wind_ms == 12.0


def test_ground_speed_is_airspeed_plus_or_minus_the_wind() -> None:
    from_north = Wind(speed_ms=3.0, from_deg=0.0)
    assert ground_speed(8.0, 180.0, from_north) == pytest.approx(11.0)  # tailwind
    assert ground_speed(8.0, 0.0, from_north) == pytest.approx(5.0)  # headwind
    assert ground_speed(8.0, 90.0, from_north) == pytest.approx(math.sqrt(64 - 9))  # crabbing
    assert ground_speed(8.0, 90.0, Wind()) == 8.0
    assert ground_speed(8.0, 0.0, Wind(speed_ms=3.0)) == pytest.approx(
        math.sqrt(55)
    )  # no direction
    assert ground_speed(8.0, 0.0, Wind(speed_ms=9.0, from_deg=0.0)) == 0.0  # can't make headway


def test_wind_from_conditions() -> None:
    w = Wind.from_conditions({"wind_kmh": 36.0, "wind_dir_deg": 270.0})
    assert (w.speed_ms, w.from_deg) == (pytest.approx(10.0), 270.0)
    assert Wind.from_conditions(None) == Wind()
    assert Wind.from_conditions({"wind_kmh": None, "wind_dir_deg": None}).speed_ms == 0.0


class _Pool:
    positive = None
    negatives = ()


def _drone(battery: float = 100.0) -> DroneSim:
    d = Drone(id="D1", name="Drone 1", simulated=True, position=LKP, altitude_m=50, speed_ms=8,
              battery_pct=battery, max_wind_kmh=43.2, status="idle", leg_id=None)  # fmt: skip
    scn = Scenario(name="t", lkp=LKP, drones=[d], hidden=LKP, positive={}, clue=None)
    sim = DroneSim(d, None, "m", scn, _Pool(), photo_every_m=1e9, out=lambda s: None)
    sim._photo = lambda: None  # type: ignore[method-assign]  # no photos in these tests
    return sim


def _leg(east_m: float) -> Leg:
    wps = [_to_ll(LKP, east_m, 0.0), _to_ll(LKP, east_m + 2000.0, 0.0)]
    return Leg(id="L1", drone_id="D1", sector_id="B2", waypoints=wps, altitude_m=50, est_minutes=5,
               expected_clearance=0.1, score_per_min=0.1, reason="r", status="approved")  # fmt: skip


def test_a_headwind_slows_the_drone_and_the_drain_follows_airspeed() -> None:
    calm, windy = _drone(), _drone()
    legs = {"L1": _leg(2000.0)}  # 2 km east to the leg's start
    calm.step(60.0, legs)
    windy.step(60.0, legs, Wind(speed_ms=4.0, from_deg=90.0))  # from the east: a headwind
    east = lambda s: s._pos_m()[0]
    assert east(calm) == pytest.approx(480.0)  # 8 m/s for a minute
    assert east(windy) == pytest.approx(240.0)  # 8 - 4 m/s
    # same airspeed, same minute in the air: the same drain
    assert calm.drone.battery_pct == pytest.approx(windy.drone.battery_pct)
    assert 100 - calm.drone.battery_pct == pytest.approx(MAVIC_3E.drain_pct_per_min(8.0))


def test_the_drone_turns_home_keeping_the_reserve() -> None:
    sim = _drone(battery=RESERVE_FRAC * 100 + 3)
    legs = {"L1": _leg(500.0)}
    for _ in range(60):
        sim.step(10.0, legs, Wind(speed_ms=5.0, from_deg=90.0))
        if sim.returning:
            break
    assert sim.returning and sim.leg is None and sim.drone.status == "returning"
    assert sim.leg_status == {"L1": "flying"}  # telemetry never cancels a leg (only the store does)
    for _ in range(200):
        sim.step(10.0, legs, Wind(speed_ms=5.0, from_deg=90.0))
        if not sim.returning:
            break
    assert sim.drone.status == "idle" and math.hypot(*sim._pos_m()) < 1.0
    assert sim.drone.battery_pct > RESERVE_FRAC * 100 - 1


def test_no_new_leg_above_the_wind_limit() -> None:
    sim = _drone()
    sim.step(10.0, {"L1": _leg(100.0)}, Wind(speed_ms=13.0, from_deg=0.0))
    assert sim.leg is None and sim.leg_status == {}
    sim.step(10.0, {"L1": _leg(100.0)}, Wind(speed_ms=5.0, from_deg=0.0))
    assert sim.leg is not None and sim.leg.id == "L1"


def test_waiting_in_the_air_drains_at_the_hover_rate_and_landed_drains_nothing() -> None:
    sim = _drone()
    sim.step(60.0, {})
    assert sim.drone.battery_pct == 100.0  # on the ground at the launch point
    sim._set(position=LatLon(lat=LKP.lat + 0.001, lon=LKP.lon))
    sim.step(60.0, {})
    assert 100 - sim.drone.battery_pct == pytest.approx(100 / 38)


def test_a_recall_cancels_the_leg_and_flies_home_in_any_wind_without_photos() -> None:
    """The store cancels the leg and approves a home leg (planner.home_leg); the sim turns home at
    once, even above the wind limit that holds any other leg, takes no photos and lands."""
    from sightline.search.planner import home_leg, is_home_leg

    sim = _drone()
    photos = []
    sim._photo = lambda: photos.append(1)  # type: ignore[method-assign]
    sim.step(60.0, {"L1": _leg(200.0)})
    assert sim.leg is not None and sim.drone.status == "flying"
    taken = len(photos)
    home = home_leg(sim.drone, LKP, "L2", "Recall: gusts")
    assert is_home_leg(home) and not is_home_leg(_leg(0.0))
    assert home.sector_id is None and home.waypoints[-1] == (LKP.lon, LKP.lat)
    gusty = Wind(speed_ms=14.0, from_deg=90.0)  # above the Mavic 3E's 12 m/s; a tailwind home
    sim.step(1.0, {"L2": home}, gusty)  # L1 is gone from the approved legs: the store cancelled it
    assert sim.leg is not None and sim.leg.id == "L2" and sim.drone.status == "returning"
    for _ in range(100):
        sim.step(10.0, {"L2": home}, gusty)
        if sim.leg is None:
            break
    assert sim.leg_status["L2"] == "done" and sim.drone.status == "idle"
    assert math.hypot(*sim._pos_m()) < 1.0 and len(photos) == taken
