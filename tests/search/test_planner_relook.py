"""The planner's re-look leg (a short low pass over one spot) and ``expected_on_cells``."""

from __future__ import annotations

import math

import pytest

from sightline.contract import Drone, LatLon
from sightline.search.grid import latlon_to_local_m, make_grid
from sightline.search.planner import (
    PlannerConfig,
    expected_clearance,
    expected_on_cells,
    is_home_leg,
    relook_leg,
)
from sightline.search.sectors import lattice_sectors

LKP = LatLon(lat=49.375, lon=-122.9374)


class _Live:
    def __init__(self, grid) -> None:
        import numpy as np

        class Base:
            pass

        self.base = Base()
        self.base.grid = grid
        n = grid.rows * grid.cols
        self._p = np.full(n, 0.5 / n)

    def p(self):
        return self._p, 0.5

    def canopy(self):
        return [None] * len(self._p)


def _drone(at: LatLon) -> Drone:
    return Drone(id="D1", name="Drone 1", simulated=True, position=at, altitude_m=50, speed_ms=8,
                 battery_pct=100, max_wind_kmh=43, status="idle", leg_id=None)  # fmt: skip


def test_the_relook_leg_starts_over_the_spot_at_its_altitude() -> None:
    grid = make_grid(LKP, size_m=1000, cell_m=5)
    target = LatLon(lat=LKP.lat - 0.0005, lon=LKP.lon + 0.0005)
    leg = relook_leg(_drone(LKP), target, grid, "C3", 25.0, 20.0)
    assert leg.altitude_m == 25.0 and leg.sector_id == "C3" and not is_home_leg(leg)
    assert leg.waypoints[0] == pytest.approx((target.lon, target.lat))
    tx, ty = latlon_to_local_m(grid, target)
    pts = [latlon_to_local_m(grid, LatLon(lat=la, lon=lo)) for lo, la in leg.waypoints]
    assert all(abs(x - tx) <= 10.001 and abs(y - ty) <= 10.001 for x, y in pts)
    souths = sorted({round(y - ty, 3) for x, y in pts[1:]})
    assert souths == [-5.0, 5.0]  # lines 10 m apart: one photo's width at 25 m
    transit = math.dist(latlon_to_local_m(grid, LKP), (tx, ty))
    assert leg.est_minutes > transit / 8 / 60  # transit + the pattern + a second per photo
    assert leg.est_minutes < transit / 8 / 60 + 0.5


def test_expected_on_cells_matches_expected_clearance_on_a_sector() -> None:
    grid = make_grid(LKP, size_m=1000, cell_m=5)
    layout = lattice_sectors(grid)
    live = _Live(grid)
    leg = relook_leg(_drone(LKP), LKP, grid, layout.sectors[0].id, 25.0, 20.0)
    cfg = PlannerConfig()
    cells = layout.cells_of(leg.sector_id)
    assert expected_on_cells(cells, live, 1.0, cfg) == pytest.approx(
        expected_clearance(leg, live, layout, 1.0, cfg)
    )
    assert expected_on_cells([], live, 1.0, cfg) == 0.0
