"""Simulated evaluation of the planner (LANE_C §5.4, C-P2). **A simulation, not a field test:**
label it "Simulated evaluation" wherever it is shown.

One drone, starting at the last known position, flies lawnmower legs over the 4 × 4 lattice
sectors (the same legs as ``planner.candidate_legs``), with either

- **static**: the sectors in a fixed order (A1 A2 A3 A4, B4 B3 B2 B1, C1 … , a serpentine), or
- **planner**: ``planner.propose_legs`` before every leg, on the map *expected* after the legs so
  far (each leg's expected step applied; nothing found yet).

Neither plan depends on where the person is (until they are found), so each is computed once and
every trial replays it. A trial draws the person's cell from the prior (renormalised inside the
grid: a person outside it can't be found by either), and their visibility v = clip(1 − canopy +
N(0, noise), 0, 1), once per trial (a person stays put). Each time a leg's line passes over that
cell, the drone finds them with probability recall · v. The time is when the line passes the
cell: the leg's start + its transit + the line's place in the leg. Cells whose canopy no photo
has measured get ``unknown_canopy`` (0.5), for the truth and for the planner alike.

Built by lane A for lane C (issue #64); lane C owns this file.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal

import numpy as np

from sightline.contract import Drone, FleetState, Grid, LatLon, Leg
from sightline.search.grid import latlon_to_local_m
from sightline.search.planner import PlannerConfig, candidate_legs, propose_legs
from sightline.search.sectors import SectorLayout, lattice_sectors

Strategy = Literal["static", "planner"]


@dataclass
class Scenario:
    grid: Grid
    lkp: LatLon
    prior: np.ndarray  # in-grid probability, summing to 1
    canopy: np.ndarray  # per cell, unknown already replaced by cfg.unknown_canopy


@dataclass(frozen=True)
class Pass:
    leg: Leg
    start_min: float  # when the leg starts (the drone leaves the previous leg's end)
    cell_time: dict[int, float]  # minute each covered cell is photographed


class _ExpectedMap:
    """What ``propose_legs`` reads: base.grid/lkp, p(), canopy()."""

    def __init__(self, scn: Scenario, p: np.ndarray, canopy_list: list[float]) -> None:
        self.base = type("Base", (), {"grid": scn.grid, "lkp": scn.lkp})()
        self._p, self._canopy = p, canopy_list

    def p(self) -> tuple[np.ndarray, float]:
        return self._p, 0.0

    def canopy(self) -> list[float]:
        return self._canopy


def with_clue(scn: Scenario, at: LatLon, radius_m: float, reliability: str = "medium") -> Scenario:
    """The scenario after a clue (the live map's labelled heuristic factors): the person is then
    drawn from this map, so the clue is informative, as a real clue is meant to be."""
    from sightline.search.grid import cells_within_radius
    from sightline.search.live import CLUE_FACTOR

    p = scn.prior.copy()
    near = set(cells_within_radius(scn.grid, at, radius_m))
    ring = set(cells_within_radius(scn.grid, at, 2 * radius_m)) - near
    p[list(near)] *= CLUE_FACTOR[reliability]
    p[list(ring)] *= math.sqrt(CLUE_FACTOR[reliability])
    return Scenario(scn.grid, scn.lkp, p / p.sum(), scn.canopy)


def scenario(
    grid: Grid, lkp: LatLon, prior: list[float], canopy: list[float | None], cfg: PlannerConfig
) -> Scenario:
    p = np.asarray(prior, dtype=np.float64)
    c = np.array([cfg.unknown_canopy if v is None else v for v in canopy], dtype=np.float64)
    return Scenario(grid, lkp, p / p.sum(), c)


def _serpentine(layout: SectorLayout) -> list[str]:
    rows = [[s.id for s in layout.sectors if s.id[0] == r] for r in "ABCD"]
    return [sid for i, row in enumerate(rows) for sid in (row if i % 2 == 0 else row[::-1])]


def _cell_times(
    leg: Leg,
    start: float,
    prev_end: tuple[float, float],
    scn: Scenario,
    layout: SectorLayout,
    cfg: PlannerConfig,
    speed_ms: float,
) -> dict[int, float]:
    """Minute each cell of the leg's sector is photographed: transit, then line by line."""
    first = latlon_to_local_m(scn.grid, LatLon(lat=leg.waypoints[0][1], lon=leg.waypoints[0][0]))
    transit = math.dist(prev_end, first) / speed_ms / 60
    survey = leg.est_minutes - transit
    rect = next(s.rect for s in layout.sectors if s.id == leg.sector_id)
    lines = max(1, math.ceil((rect["south_max"] - rect["south_min"]) / cfg.line_spacing_m))
    out = {}
    for i in layout.cells_of(leg.sector_id):
        row = int(i) // scn.grid.cols
        south = (row + 0.5) * scn.grid.cell_m
        line = min(lines - 1, int((south - rect["south_min"]) // cfg.line_spacing_m))
        out[int(i)] = start + transit + survey * (line + 0.5) / lines
    return out


def plan(
    scn: Scenario,
    strategy: Strategy,
    cfg: PlannerConfig,
    horizon_min: float = 120.0,
    speed_ms: float = 8.0,
) -> list[Pass]:
    """The legs the drone flies, in order, until ``horizon_min`` (nobody found)."""
    layout = lattice_sectors(scn.grid)
    order = _serpentine(layout)
    p = scn.prior.copy()
    canopy_list = scn.canopy.tolist()
    pod = np.minimum(cfg.pod_cap, cfg.recall * (1.0 - scn.canopy))
    pos = latlon_to_local_m(scn.grid, scn.lkp)
    t, k, out = 0.0, 0, []
    while t < horizon_min:
        here = _local_to_latlon(scn.grid, pos)
        drone = Drone(
            id="D1",
            name="Drone 1",
            simulated=True,
            position=here,
            altitude_m=cfg.altitude_m,
            speed_ms=speed_ms,
            battery_pct=100,
            max_wind_kmh=40,
            status="idle",
            leg_id=None,
        )
        if strategy == "static":
            leg = next(
                x
                for x in candidate_legs(drone, layout, scn.grid, cfg, here)
                if x.sector_id == order[k % len(order)]
            )
        else:
            fleet = FleetState(
                simulated=True, drones=[drone], legs=[], updated_at="2026-10-24T12:00:00Z"
            )
            # battery is swapped between legs here (the endurance limit is not what is compared)
            legs = propose_legs(
                _ExpectedMap(scn, p, canopy_list),
                layout,
                fleet,
                None,
                "2026-10-24T12:00:00Z",
                k=1,
                cfg=PlannerConfig(**{**cfg.__dict__, "endurance_min": 1e6}),
            )
            if not legs:
                break
            leg = legs[0]
        out.append(Pass(leg, t, _cell_times(leg, t, pos, scn, layout, cfg, speed_ms)))
        cells = layout.cells_of(leg.sector_id)
        p[cells] *= 1.0 - pod[cells]  # the expected map after this leg, nobody found
        p /= p.sum()
        t += leg.est_minutes
        last = leg.waypoints[-1]
        pos = latlon_to_local_m(scn.grid, LatLon(lat=last[1], lon=last[0]))
        k += 1
    return out


def _local_to_latlon(grid: Grid, pos: tuple[float, float]) -> LatLon:
    from sightline.search.grid import local_m_to_latlon

    return local_m_to_latlon(grid, pos[0], pos[1])


def minutes_to_find(
    scn: Scenario, passes: list[Pass], cfg: PlannerConfig, trials: int, noise: float, seed: int
) -> np.ndarray:
    """Minutes until the drone finds the person, per trial (inf when not within the plan)."""
    rng = np.random.default_rng(seed)
    cells = rng.choice(scn.prior.size, size=trials, p=scn.prior)
    vis = np.clip(1.0 - scn.canopy[cells] + rng.normal(0.0, noise, size=trials), 0.0, 1.0)
    out = np.full(trials, np.inf)
    by_cell: dict[int, list[float]] = {}
    for ps in passes:
        for c, t in ps.cell_time.items():
            by_cell.setdefault(c, []).append(t)
    for i in range(trials):
        for t in sorted(by_cell.get(int(cells[i]), ())):
            if rng.random() < cfg.recall * vis[i]:
                out[i] = t
                break
    return out


def summary(
    minutes: np.ndarray, within: float = 30.0, horizon: float = 120.0
) -> dict[str, float | None]:
    """Median / P90 minutes (None: not reached within the horizon) and the shares found. Only
    finds at or before ``horizon`` count (a leg that starts before it may end after it)."""
    minutes = np.where(minutes <= horizon, minutes, np.inf)
    finite = np.isfinite(minutes)
    with np.errstate(invalid="ignore"):  # a percentile between a find and "not found" is inf
        med, p90 = np.percentile(minutes, [50, 90])
    return {
        "median_min": None if not np.isfinite(med) else round(float(med), 1),
        "p90_min": None if not np.isfinite(p90) else round(float(p90), 1),
        "found_within_30_min": round(float(np.mean(minutes <= within)), 3),
        "found_within_horizon": round(float(finite.mean()), 3),
    }


# --- the fleet (C-F3) ---------------------------------------------------------------------------

FleetStrategy = Literal["coordinated", "independent", "split"]


def plan_fleet(
    scn: Scenario,
    strategy: FleetStrategy,
    cfg: PlannerConfig,
    drones: int = 3,
    horizon_min: float = 120.0,
    speed_ms: float = 8.0,
) -> list[Pass]:
    """The legs ``drones`` drones fly from the last known position until ``horizon_min``. Whichever
    drone is free first takes its next leg:

    - **coordinated**: ``propose_legs`` on one expected map shared by the fleet (every leg any drone
      takes discounts it: the planner's sequential greedy over time);
    - **independent**: the same planner, but each drone on its own expected map, unaware of the others;
    - **split**: the fixed serpentine order cut into ``drones`` equal runs, one per drone, each looping
      over its own run (a lawnmower split, as a team would do it by hand).

    ``minutes_to_find`` takes the passes of all drones together."""
    layout = lattice_sectors(scn.grid)
    order = _serpentine(layout)
    canopy_list = scn.canopy.tolist()
    pod = np.minimum(cfg.pod_cap, cfg.recall * (1.0 - scn.canopy))
    shared = scn.prior.copy()
    own = [scn.prior.copy() for _ in range(drones)]
    start = latlon_to_local_m(scn.grid, scn.lkp)
    pos = [start] * drones
    t = [0.0] * drones
    k = [0] * drones
    run = math.ceil(len(order) / drones)
    out: list[Pass] = []
    no_battery = PlannerConfig(**{**cfg.__dict__, "endurance_min": 1e6})
    while min(t) < horizon_min:
        d = min(range(drones), key=lambda i: (t[i], i))
        here = _local_to_latlon(scn.grid, pos[d])
        drone = Drone(id=f"D{d + 1}", name=f"Drone {d + 1}", simulated=True, position=here,
                      altitude_m=cfg.altitude_m, speed_ms=speed_ms, battery_pct=100,
                      max_wind_kmh=40, status="idle", leg_id=None)  # fmt: skip
        if strategy == "split":
            mine = order[d * run : (d + 1) * run] or order
            sector = mine[k[d] % len(mine)]
            leg = next(
                x
                for x in candidate_legs(drone, layout, scn.grid, cfg, here)
                if x.sector_id == sector
            )
        else:
            p = shared if strategy == "coordinated" else own[d]
            fleet = FleetState(
                simulated=True, drones=[drone], legs=[], updated_at="2026-10-24T12:00:00Z"
            )
            legs = propose_legs(_ExpectedMap(scn, p, canopy_list), layout, fleet, None,
                                "2026-10-24T12:00:00Z", k=1, cfg=no_battery)  # fmt: skip
            if not legs:
                t[d] = math.inf
                continue
            leg = legs[0]
        out.append(Pass(leg, t[d], _cell_times(leg, t[d], pos[d], scn, layout, cfg, speed_ms)))
        cells = layout.cells_of(leg.sector_id)
        for p in (shared, own[d]):
            p[cells] *= 1.0 - pod[cells]
            p /= p.sum()
        t[d] += leg.est_minutes
        last = leg.waypoints[-1]
        pos[d] = latlon_to_local_m(scn.grid, LatLon(lat=last[1], lon=last[0]))
        k[d] += 1
    return out
