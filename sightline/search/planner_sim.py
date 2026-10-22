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

``plan_fleet`` flies several drones; ``plan_mission`` (planner v2) adds ground teams and replays
the agent's events (opening legs, leg done, clue, a sector searched) with its re-plan rule.

Built by lane A for lane C (issue #64); lane C owns this file.
"""

from __future__ import annotations

import heapq
import itertools
import math
from dataclasses import dataclass
from typing import Literal

import numpy as np

from sightline.contract import Drone, FleetState, Grid, LatLon, Leg, SectorTask, Team
from sightline.search.grid import latlon_to_local_m
from sightline.search.planner import (
    PlannerConfig,
    candidate_legs,
    propose_assignments,
    propose_legs,
)
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
    leg: Leg | None  # None: a ground team's search (``plan_mission``)
    start_min: float  # when the leg starts (the drone leaves the previous leg's end)
    cell_time: dict[int, float]  # minute each covered cell is photographed (or walked)
    pod: float | None = None  # a team's POD per pass; None: a drone's, recall · visibility
    sector_id: str = ""


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
    """Minutes until a drone (or a ground team) finds the person, per trial (inf when not within
    the plan). A drone pass finds them with probability recall · v; a team's with its ``pod``."""
    rng = np.random.default_rng(seed)
    cells = rng.choice(scn.prior.size, size=trials, p=scn.prior)
    vis = np.clip(1.0 - scn.canopy[cells] + rng.normal(0.0, noise, size=trials), 0.0, 1.0)
    out = np.full(trials, np.inf)
    by_cell: dict[int, list[tuple[float, float | None]]] = {}
    for ps in passes:
        for c, t in ps.cell_time.items():
            by_cell.setdefault(c, []).append((t, ps.pod))
    for i in range(trials):
        for t, pod in sorted(by_cell.get(int(cells[i]), ()), key=lambda x: x[0]):
            if rng.random() < (cfg.recall * vis[i] if pod is None else pod):
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


# --- the mission: drones, ground teams and the agent's re-plans (planner v2) ---------------------

Replan = Literal["one", "idle"]
SIM_NOW = "2026-10-24T12:00:00Z"


@dataclass
class _SimDrone:
    id: str
    pos: tuple[float, float]  # where the current leg started (where it ended, once done)
    leg: Leg | None = None
    path: list[tuple[float, float]] | None = None
    start: float = 0.0
    end: float = 0.0
    pass_i: int = -1

    def flying(self, t: float) -> bool:
        return self.leg is not None and t < self.end

    def at(self, t: float) -> tuple[float, float]:
        """Where the drone is at minute ``t`` (along its leg at an even pace)."""
        if not self.flying(t) or not self.path:
            return self.pos
        todo = (t - self.start) / max(self.end - self.start, 1e-9) * _path_m(self.path)
        for a, b in itertools.pairwise(self.path):
            seg = math.dist(a, b)
            if todo <= seg and seg > 0:
                f = todo / seg
                return (a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]))
            todo -= seg
        return self.path[-1]


@dataclass
class _SimTeam:
    id: str
    pos: tuple[float, float]
    sector: str | None = None
    end: float = 0.0


def _path_m(pts: list[tuple[float, float]]) -> float:
    return sum(math.dist(a, b) for a, b in itertools.pairwise(pts))


def plan_mission(
    scn: Scenario,
    cfg: PlannerConfig,
    drones: int = 3,
    teams: int = 0,
    horizon_min: float = 120.0,
    speed_ms: float = 8.0,
    *,
    replan: Replan = "idle",
    opening: bool = True,
    clue: Scenario | None = None,
    clue_min: float = 0.0,
    team_pod: float = 0.5,
    walk_kmh: float = 3.0,
    search_min: float = 60.0,
) -> list[Pass]:
    """The drones' legs and the teams' searches over ``horizon_min``, event by event as the agent
    would propose them (each proposal approved at once). Everything starts at the last known point.

    - **fleet join** (minute 0, ``opening``): a leg for every idle drone (``loop._on_fleet_join``);
    - **leg done**: that drone's next leg (``loop._on_leg_done``);
    - **clue** (at ``clue_min``; the map becomes ``clue``'s) and **a team's sector searched**: a
      re-plan. ``replan="idle"``: the best leg of the fleet (a re-task when its drone is flying)
      plus one for every other idle drone (``loop._replan`` now); ``"one"``: the best leg only (as
      before planner v2);
    - teams on standby get sectors from ``propose_assignments`` (at minute 0 and when they finish),
      walk there in a straight line at ``walk_kmh``, search for ``search_min`` (line by line, each
      pass finding the person with ``team_pod``, whatever the canopy), then report it searched,
      which steps the map at that POD (capped at 0.9).

    Team awareness is ``cfg``'s: ``team_discount`` for drones, ``walking_kmh`` for assignments
    (0 and None: the planner before v2). The map the planner reads is the *expected* map: each
    leg's expected step when it is chosen (undone for the part a re-task skips) and each team's
    step when it reports. ``minutes_to_find`` takes the passes of drones and teams together."""
    layout = lattice_sectors(scn.grid)
    canopy_list = scn.canopy.tolist()
    pod = np.minimum(cfg.pod_cap, cfg.recall * (1.0 - scn.canopy))
    p = scn.prior.copy()
    lkp_m = latlon_to_local_m(scn.grid, scn.lkp)
    ds = {f"D{i + 1}": _SimDrone(f"D{i + 1}", lkp_m) for i in range(drones)}
    ts = {f"T{i + 1}": _SimTeam(f"T{i + 1}", lkp_m) for i in range(teams)}
    searched: set[str] = set()
    out: list[Pass] = []
    events: list[tuple[float, int, str, str]] = []
    counter = itertools.count()
    no_battery = PlannerConfig(**{**cfg.__dict__, "endurance_min": 1e6})
    centre = {s.id: ((s.rect["east_min"] + s.rect["east_max"]) / 2,
                     (s.rect["south_min"] + s.rect["south_max"]) / 2) for s in layout.sectors}  # fmt: skip

    def push(t: float, kind: str, ref: str) -> None:
        heapq.heappush(events, (t, next(counter), kind, ref))

    def tasks() -> list[SectorTask]:
        busy = [(tm.sector, "in_progress", tm.id) for tm in ts.values() if tm.sector]
        done = [(s, "searched", None) for s in searched]
        return [SectorTask(sector_id=s, state=st, team_id=tid, poa=0.0,
                           pod=team_pod if st == "searched" else None, note=None,
                           updated_at=SIM_NOW) for s, st, tid in busy + done]  # fmt: skip

    def drone(d: _SimDrone, t: float) -> Drone:
        return Drone(id=d.id, name=f"Drone {d.id[1:]}", simulated=True,
                     position=_local_to_latlon(scn.grid, d.at(t)), altitude_m=cfg.altitude_m,
                     speed_ms=speed_ms, battery_pct=100, max_wind_kmh=40,
                     status="flying" if d.flying(t) else "idle",
                     leg_id=d.leg.id if d.flying(t) and d.leg else None)  # fmt: skip

    def plan_for(ids: list[str], t: float, k: int) -> list[Leg]:
        flying = [d.leg.model_copy(update={"status": "flying"})
                  for d in ds.values() if d.flying(t) and d.leg]  # fmt: skip
        fleet = FleetState(simulated=True, drones=[drone(ds[i], t) for i in ids], legs=flying,
                           updated_at=SIM_NOW)  # fmt: skip
        return propose_legs(_ExpectedMap(scn, p, canopy_list), layout, fleet, None, SIM_NOW, k,
                            no_battery, tasks())  # fmt: skip

    def step(cells: np.ndarray, q: np.ndarray, undo: bool = False) -> None:
        p[cells] = p[cells] / (1.0 - q) if undo else p[cells] * (1.0 - q)
        p[:] = p / p.sum()

    def fly(d: _SimDrone, leg: Leg, t: float) -> None:
        if d.flying(t) and d.leg is not None:  # a re-task: the rest of the old leg is not flown
            old = out[d.pass_i]
            skipped = np.array([c for c, ct in old.cell_time.items() if ct > t], dtype=int)
            if skipped.size:
                step(skipped, pod[skipped], undo=True)
            out[d.pass_i] = Pass(old.leg, old.start_min,
                                 {c: ct for c, ct in old.cell_time.items() if ct <= t})  # fmt: skip
            d.pos = d.at(t)
        leg = leg.model_copy(update={"id": f"L{next(counter):03d}"})
        out.append(Pass(leg, t, _cell_times(leg, t, d.pos, scn, layout, cfg, speed_ms)))
        cells = layout.cells_of(leg.sector_id)
        step(cells, pod[cells])
        wps = [latlon_to_local_m(scn.grid, LatLon(lat=w[1], lon=w[0])) for w in leg.waypoints]
        d.leg, d.path, d.start, d.end, d.pass_i = (
            leg,
            [d.pos, *wps],
            t,
            t + leg.est_minutes,
            len(out) - 1,
        )
        push(d.end, "leg_done", leg.id)

    def replan_fleet(t: float, idle_only: bool = False) -> None:
        idle = [i for i, d in ds.items() if not d.flying(t)]
        if idle_only:
            keep = idle
        else:
            best = plan_for(list(ds), t, 1)
            d = ds[best[0].drone_id] if best else None
            if d is not None and d.flying(t) and d.leg is not None:  # loop._abandons_more
                # the live map has only the photos taken so far: undo the rest of the leg's step
                times = out[d.pass_i].cell_time
                cur = layout.cells_of(d.leg.sector_id)
                left = np.array([times.get(int(c), 0.0) > t for c in cur])
                now = np.where(left, p[cur] / (1.0 - pod[cur]), p[cur]).sum()
                if now >= p[layout.cells_of(best[0].sector_id)].sum():
                    best = []
            if not best:
                keep = idle if replan == "idle" else []
            else:
                keep = [best[0].drone_id] + ([i for i in idle if i != best[0].drone_id]
                                             if replan == "idle" else [])  # fmt: skip
        for leg in plan_for(keep, t, len(keep)) if keep else []:
            fly(ds[leg.drone_id], leg, t)

    def assign_teams(t: float) -> None:
        free = [Team(id=tm.id, callsign=f"Team {tm.id[1:]}", members=3, status="standby",
                     position=_local_to_latlon(scn.grid, tm.pos), position_at=SIM_NOW, note=None)
                for tm in ts.values() if tm.sector is None]  # fmt: skip
        if not free:
            return
        expected = _ExpectedMap(scn, p, canopy_list)
        for team_id, sector, _ in propose_assignments(expected, layout, tasks(), free, cfg):
            tm = ts[team_id]
            arrive = t + math.dist(tm.pos, centre[sector]) / (walk_kmh * 1000 / 60)
            rect = next(s.rect for s in layout.sectors if s.id == sector)
            lines = max(1, math.ceil((rect["south_max"] - rect["south_min"]) / cfg.line_spacing_m))
            times = {}
            for i in layout.cells_of(sector):
                south = (int(i) // scn.grid.cols + 0.5) * scn.grid.cell_m
                line = min(lines - 1, int((south - rect["south_min"]) // cfg.line_spacing_m))
                times[int(i)] = arrive + search_min * (line + 0.5) / lines
            out.append(Pass(None, t, times, pod=team_pod, sector_id=sector))
            tm.sector, tm.end = sector, arrive + search_min
            push(tm.end, "team_done", team_id)

    if opening:
        replan_fleet(0.0, idle_only=True)
    assign_teams(0.0)
    if clue is not None:
        push(clue_min, "clue", "")
    while events and events[0][0] < horizon_min:
        t, _, kind, ref = heapq.heappop(events)
        if kind == "leg_done":
            d = next((d for d in ds.values() if d.leg is not None and d.leg.id == ref), None)
            if d is None:  # re-tasked before it finished
                continue
            d.pos = d.path[-1] if d.path else d.pos
            d.leg = None
            for leg in plan_for([d.id], t, 1):
                fly(d, leg, t)
        elif kind == "clue" and clue is not None:
            factor = np.divide(clue.prior, scn.prior, out=np.ones_like(p), where=scn.prior > 0)
            p[:] = p * factor / float(np.sum(p * factor))
            replan_fleet(t)
        elif kind == "team_done":
            tm = ts[ref]
            sector = tm.sector or ""
            cells = layout.cells_of(sector)
            step(cells, np.full(cells.size, min(team_pod, 0.9)))
            searched.add(sector)
            tm.pos, tm.sector = centre[sector], None
            replan_fleet(t)
            assign_teams(t)
    return out
