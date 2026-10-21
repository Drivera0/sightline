"""Stand-ins for lane C's live map, sectors and planner until C-S1, C-L1 and C-P1 land.

Same names and signatures as contract §14 and LANE_C_SPRINT.md §4 (the subset the agent uses).
``sightline.agent.loop`` imports C's real modules when they exist and these otherwise; delete
this file when they have all merged. Every reason they write says "stub planner".
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

import numpy as np

from sightline.agent._contract_v12 import Leg
from sightline.contract import Grid
from sightline.search.grid import local_m_to_latlon

LATTICE_SIZE = 4  # 4 x 4 sectors, A1..D4 (LANE_C §5.1)
STUB_MINUTES = 8.0  # every stub leg takes this long
STUB_POD = 0.5  # share of a sector's probability a stub leg is assumed to rule out


@dataclass(frozen=True)
class Sector:
    id: str
    label: str
    kind: Literal["flight", "outer", "lattice"]
    rect: dict[str, float]  # east_m / south_m bounds from the grid's north-west corner
    steps: tuple[int, int] | None = None


@dataclass(frozen=True)
class SectorLayout:
    kind: Literal["flight", "lattice"]
    sectors: list[Sector]
    cell_sector: np.ndarray = field(repr=False)  # sector index per cell

    def cells_of(self, sector_id: str) -> np.ndarray:
        i = next(k for k, s in enumerate(self.sectors) if s.id == sector_id)
        return np.flatnonzero(self.cell_sector == i)


def lattice_sectors(grid: Grid) -> SectorLayout:
    """A 4 × 4 lattice over the grid: rows A–D from north, columns 1–4 from west."""
    sectors, cell_sector = [], np.zeros(grid.rows * grid.cols, np.int16)
    rows = np.arange(grid.rows * grid.cols) // grid.cols
    cols = np.arange(grid.rows * grid.cols) % grid.cols
    for r in range(LATTICE_SIZE):
        for c in range(LATTICE_SIZE):
            sid = f"{'ABCD'[r]}{c + 1}"
            r0, r1 = r * grid.rows // LATTICE_SIZE, (r + 1) * grid.rows // LATTICE_SIZE
            c0, c1 = c * grid.cols // LATTICE_SIZE, (c + 1) * grid.cols // LATTICE_SIZE
            cell_sector[(rows >= r0) & (rows < r1) & (cols >= c0) & (cols < c1)] = len(sectors)
            rect = {
                "east_min": c0 * grid.cell_m,
                "east_max": c1 * grid.cell_m,
                "south_min": r0 * grid.cell_m,
                "south_max": r1 * grid.cell_m,
            }
            sectors.append(Sector(sid, f"Sector {sid}", "lattice", rect))
    return SectorLayout("lattice", sectors, cell_sector)


@dataclass
class _Base:
    grid: Grid


class StubLiveMap:
    """The parts of C's ``LiveMap`` the agent reads: ``base.grid``, ``p()``, ``sector_poa``."""

    def __init__(self, grid: Grid, p: np.ndarray | None = None, outside: float = 0.0) -> None:
        n = grid.rows * grid.cols
        self.base = _Base(grid)
        self._p = np.full(n, (1 - outside) / n) if p is None else np.asarray(p, float)
        self._outside = outside

    def p(self) -> tuple[np.ndarray, float]:
        return self._p, self._outside

    def sector_poa(self, layout: SectorLayout) -> dict[str, float]:
        return {s.id: float(self._p[layout.cells_of(s.id)].sum()) for s in layout.sectors}


def _lawnmower(grid: Grid, rect: dict[str, float]) -> list[tuple[float, float]]:
    """Two passes across the sector, as [lon, lat] waypoints."""
    pts = []
    ends = (rect["east_min"], rect["east_max"])
    for i, frac in enumerate((0.25, 0.75)):
        south = rect["south_min"] + frac * (rect["south_max"] - rect["south_min"])
        for east in ends if i == 0 else ends[::-1]:
            ll = local_m_to_latlon(grid, east, south)
            pts.append((ll.lon, ll.lat))
    return pts


def propose_legs(live, layout, fleet, conditions, now: str, k: int = 3) -> list[Leg]:
    """Stub: the highest-POA sectors with no approved or flying leg, one per idle or flying
    drone, best first. No legs when conditions say it isn't flyable."""
    if conditions is not None and conditions.flyable is False:
        return []
    poa = live.sector_poa(layout)
    taken = {leg.sector_id for leg in fleet.legs if leg.status in ("approved", "flying")}
    ranked = [s for s in sorted(poa, key=poa.get, reverse=True) if s not in taken]
    sectors = {s.id: s for s in layout.sectors}
    legs = []
    for drone in fleet.drones:
        if drone.status not in ("idle", "flying") or not ranked:
            continue
        sid = ranked.pop(0)
        gain = STUB_POD * poa[sid]
        legs.append(
            Leg(
                id="",
                drone_id=drone.id,
                sector_id=sid,
                waypoints=_lawnmower(live.base.grid, sectors[sid].rect),
                altitude_m=drone.altitude_m,
                est_minutes=STUB_MINUTES,
                expected_clearance=gain,
                score_per_min=gain / STUB_MINUTES,
                reason=(
                    f"Sector {sid}: expected to rule out {gain:.1%} of the probability in "
                    f"{STUB_MINUTES:.0f} min (stub planner)"
                ),
                status="proposed",
            )
        )
    return sorted(legs, key=lambda leg: leg.score_per_min, reverse=True)[:k]


def propose_assignments(live, layout, tasks, teams) -> list[tuple[str, str, str]]:
    """Stub: standby teams paired with the highest-POA sectors not assigned or searched."""
    poa = live.sector_poa(layout)
    busy = {t.sector_id for t in tasks if t.state in ("assigned", "in_progress", "searched")}
    open_sectors = [s for s in sorted(poa, key=poa.get, reverse=True) if s not in busy]
    out = []
    for team in (t for t in teams if t.status == "standby"):
        if not open_sectors:
            break
        sid = open_sectors.pop(0)
        out.append(
            (team.id, sid, f"Sector {sid} holds {poa[sid]:.1%} of the probability (stub planner)")
        )
    return out
