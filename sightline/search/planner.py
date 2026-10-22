"""The information-gain planner (LANE_C §5.3, C-P1): which sector each drone should fly next, and
which sector each ground team on standby should take. Pure math over the live map.

**Drone legs.** For each drone, one lawnmower leg per sector: lines ``line_spacing_m`` apart (one
photo's width on the ground, so the lines tile the sector), a photo every ``photo_spacing_m``.
``est_minutes`` = transit from the drone to the start + the leg, at ``speed_ms``, + 1 s per photo.
Its value is the probability it is expected to rule out:

    expected_clearance = Σ_cells p_i · POD_i,  POD_i = min(pod_cap, recall · (1 − canopy_i) · visibility)

on the current map (unknown canopy → ``unknown_canopy``). ``score_per_min`` = that / minutes.
Constraints: nothing when conditions say it isn't flyable; a leg must fit the battery (minus the
reserve and the flight home) and finish before ``flyable_until`` and civil twilight.
Several drones: sequential greedy on the *expected* map: take the best (drone, leg), apply its
expected step to a copy of the map, re-score the rest, repeat; drones spread out on their own,
and a re-task after a clue falls out of the same rule.

Ground teams count: a sector a team is assigned to or searching (``tasks``) is worth
``team_discount`` (0.5) less to a drone, since the team is about to step it; 1.0 would exclude it.
Once the team reports it searched at POD x, the map has the step and the discount no longer applies.

**Ground teams** (``propose_assignments``): sectors not yet assigned or searched, valued at
POA × (1 − the POD a drone would get there): teams add the most where tree cover hides people
from the camera. Each (team on standby, sector) pair is ranked by that value per minute of the
team's time, walking there from its last position (straight line at ``walking_kmh``; the last
known point when it hasn't reported) plus ``team_search_min`` searching; the best pair goes
first, greedily. Both times are assumptions, not measured (stated in ``PlannerConfig``).
``walking_kmh=None`` gives the old rule: best sector first, to the nearest team.

Every reason is in numbers. Built by lane A for lane C (issue #64); lane C owns this file.
"""

from __future__ import annotations

import itertools
import math
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import numpy as np

from sightline.contract import Conditions, Drone, FleetState, Grid, LatLon, Leg, SectorTask, Team
from sightline.search.grid import latlon_to_local_m, local_m_to_latlon
from sightline.search.sectors import Sector, SectorLayout

TEAM_BUSY = ("assigned", "in_progress")  # task states a drone plans around


@dataclass(frozen=True)
class PlannerConfig:
    altitude_m: float = 50.0
    line_spacing_m: float = 20.0  # one photo's width on the ground at 50 m with the demo camera
    photo_spacing_m: float = 15.0
    # None: the fleet's airframe at the drone's airspeed (fleet.py ``Airframe``, DJI Mavic 3
    # Enterprise: about 44 min at 8 m/s); a number overrides it (planner_sim: no battery limit)
    endurance_min: float | None = None
    reserve_frac: float = 0.2
    unknown_canopy: float = 0.5
    recall: float = 0.864
    pod_cap: float = 0.95
    seconds_per_photo: float = 1.0
    # A sector with a ground team assigned or searching is worth this much less to a drone.
    team_discount: float = 0.5
    # Assumptions (no SAR source verified): a team's straight-line pace off trail with gear, and
    # the time it takes to search one lattice sector (250 m square on the 1 km mission grid).
    walking_kmh: float | None = 3.0
    team_search_min: float = 60.0


def _t(iso: str) -> datetime:
    return datetime.fromisoformat(iso)


def _canopy(live: Any, cfg: PlannerConfig) -> np.ndarray:
    """Per-cell canopy from the live map; unknown cells get ``cfg.unknown_canopy``."""
    n = live.base.grid.rows * live.base.grid.cols
    get = getattr(live, "canopy", None)
    values = get() if callable(get) else [None] * n
    return np.array([cfg.unknown_canopy if v is None else v for v in values], dtype=np.float64)


def _home(drone: Drone, grid: Grid, lkp: LatLon) -> tuple[float, float]:
    """Where the drone is now, in local metres (the last known position when it hasn't reported)."""
    return latlon_to_local_m(grid, drone.position or lkp)


def _lawnmower(rect: dict[str, float], spacing: float) -> list[tuple[float, float]]:
    """East–west lines ``spacing`` apart across the sector, alternating direction (local metres)."""
    pts: list[tuple[float, float]] = []
    n = max(1, math.ceil((rect["south_max"] - rect["south_min"]) / spacing))
    for i in range(n):
        south = min(rect["south_min"] + (i + 0.5) * spacing, rect["south_max"])
        row = [(rect["east_min"], south), (rect["east_max"], south)]
        pts += row if i % 2 == 0 else row[::-1]
    return pts


def _length(pts: list[tuple[float, float]]) -> float:
    return sum(math.dist(a, b) for a, b in itertools.pairwise(pts))


def candidate_legs(
    drone: Drone, layout: SectorLayout, grid: Grid, cfg: PlannerConfig, lkp: LatLon | None = None
) -> list[Leg]:
    """One lawnmower leg per sector for ``drone`` (value not yet scored: ``expected_clearance`` 0)."""
    lkp = lkp or local_m_to_latlon(grid, grid.cols * grid.cell_m / 2, grid.rows * grid.cell_m / 2)
    home = _home(drone, grid, lkp)
    legs = []
    for s in layout.sectors:
        pts = _lawnmower(s.rect, cfg.line_spacing_m)
        survey_m = _length(pts)
        transit_m = math.dist(home, pts[0])
        photos = survey_m / cfg.photo_spacing_m
        minutes = (transit_m + survey_m) / drone.speed_ms / 60 + photos * cfg.seconds_per_photo / 60
        legs.append(
            Leg(
                id="",
                drone_id=drone.id,
                sector_id=s.id,
                waypoints=[
                    (ll.lon, ll.lat) for ll in (local_m_to_latlon(grid, e, so) for e, so in pts)
                ],
                altitude_m=drone.altitude_m or cfg.altitude_m,
                est_minutes=round(minutes, 1),
                expected_clearance=0.0,
                score_per_min=0.0,
                reason="",
                status="proposed",
            )
        )
    return legs


def home_leg(drone: Drone, home: LatLon, leg_id: str, reason: str) -> Leg:
    """A recall: from where the drone is to its launch point, no sector, no photos (nothing to rule
    out). It is an ordinary leg for the store, so approving it cancels the drone's current leg (the
    re-task path); the fleet sim flies it straight home (``is_home_leg``)."""
    here = drone.position or home
    metres = math.dist(
        (here.lat * 111_320.0, here.lon * 111_320.0 * math.cos(math.radians(here.lat))),
        (home.lat * 111_320.0, home.lon * 111_320.0 * math.cos(math.radians(here.lat))),
    )
    return Leg(
        id=leg_id,
        drone_id=drone.id,
        sector_id=None,
        waypoints=[(here.lon, here.lat), (home.lon, home.lat)],
        altitude_m=drone.altitude_m,
        est_minutes=round(metres / drone.speed_ms / 60, 1),
        expected_clearance=0.0,
        score_per_min=0.0,
        reason=reason,
        status="proposed",
    )


def is_home_leg(leg: Leg) -> bool:
    """A recall leg (``home_leg``): no sector and nothing expected to be ruled out."""
    return leg.sector_id is None and leg.expected_clearance == 0.0


def _pods(
    sector_cells: np.ndarray, canopy: np.ndarray, visibility: float, cfg: PlannerConfig
) -> np.ndarray:
    return np.minimum(cfg.pod_cap, cfg.recall * (1.0 - canopy[sector_cells]) * visibility)


def expected_clearance(
    leg: Leg,
    live: Any,
    layout: SectorLayout,
    visibility: float,
    cfg: PlannerConfig,
    p: np.ndarray | None = None,
) -> float:
    """Σ p_i · POD_i over the leg's sector (``p``: an expected map instead of the live one)."""
    return expected_on_cells(layout.cells_of(leg.sector_id), live, visibility, cfg, p)


def expected_on_cells(
    cells: Any,
    live: Any,
    visibility: float,
    cfg: PlannerConfig = PlannerConfig(),  # noqa: B008 - frozen dataclass, never mutated
    p: np.ndarray | None = None,
) -> float:
    """Σ p_i · POD_i over ``cells`` (cell indices): ``expected_clearance`` for any set of cells,
    e.g. the few under a re-look leg."""
    cells = np.asarray(cells, dtype=np.int64)
    if cells.size == 0:
        return 0.0
    p = live.p()[0] if p is None else p
    return float(np.sum(p[cells] * _pods(cells, _canopy(live, cfg), visibility, cfg)))


def relook_leg(
    drone: Drone,
    target: LatLon,
    grid: Grid,
    sector_id: str,
    altitude_m: float,
    side_m: float,
    cfg: PlannerConfig = PlannerConfig(),  # noqa: B008 - frozen dataclass, never mutated
) -> Leg:
    """A short low pass over one spot: the first waypoint is ``target`` itself (the survey starts
    with a photo there), then a lawnmower over a ``side_m`` square centred on it, its lines one
    photo's width apart at ``altitude_m`` (``line_spacing_m`` scaled by altitude / ``cfg.altitude_m``).
    ``est_minutes`` as for any leg: transit from the drone, the pattern, 1 s per photo. Its value
    (``expected_clearance``) and reason are the caller's: it knows why the spot is worth it."""
    tx, ty = latlon_to_local_m(grid, target)
    spacing = cfg.line_spacing_m * altitude_m / cfg.altitude_m
    half = side_m / 2
    rect = {
        "east_min": tx - half,
        "east_max": tx + half,
        "south_min": ty - half,
        "south_max": ty + half,
    }
    pts = [(tx, ty), *_lawnmower(rect, spacing)]
    home = _home(drone, grid, target)
    survey_m = _length(pts)
    photos = 1 + survey_m / cfg.photo_spacing_m
    minutes = (math.dist(home, pts[0]) + survey_m) / drone.speed_ms / 60
    minutes += photos * cfg.seconds_per_photo / 60
    return Leg(
        id="",
        drone_id=drone.id,
        sector_id=sector_id,
        waypoints=[(ll.lon, ll.lat) for ll in (local_m_to_latlon(grid, e, s) for e, s in pts)],
        altitude_m=altitude_m,
        est_minutes=round(minutes, 2),
        expected_clearance=0.0,
        score_per_min=0.0,
        reason="",
        status="proposed",
    )


def endurance_min(drone: Drone, cfg: PlannerConfig) -> float:
    """Minutes a full battery flies this drone: ``cfg.endurance_min`` when set, else the simulated
    fleet's airframe (DJI Mavic 3 Enterprise, ``fleet.py``) at the drone's airspeed."""
    if cfg.endurance_min is not None:
        return cfg.endurance_min
    from sightline.search.fleet import MAVIC_3E

    return 100 / MAVIC_3E.drain_pct_per_min(drone.speed_ms)


def _limits(
    drone: Drone,
    leg: Leg,
    conditions: Conditions | None,
    now: str,
    cfg: PlannerConfig,
    home_m: float,
) -> str | None:
    """Why the drone can't fly this leg, or None."""
    return_min = home_m / drone.speed_ms / 60
    budget = (
        drone.battery_pct / 100 * endurance_min(drone, cfg) * (1 - cfg.reserve_frac) - return_min
    )
    if leg.est_minutes > budget:
        return "battery"
    if conditions is not None:
        end = _t(now).timestamp() + leg.est_minutes * 60
        for name, at in (
            ("wind", conditions.flyable_until),
            ("daylight", conditions.civil_twilight_end),
        ):
            if at and end > _t(at).timestamp():
                return name
    return None


def propose_legs(
    live: Any,
    layout: SectorLayout,
    fleet: FleetState,
    conditions: Conditions | None,
    now: str,
    k: int = 3,
    cfg: PlannerConfig = PlannerConfig(),  # noqa: B008 - frozen dataclass, never mutated
    tasks: list[SectorTask] | None = None,
) -> list[Leg]:
    """Up to ``k`` legs, best first, at most one per drone (idle or flying: a flying drone's leg is
    a re-task). Nothing when conditions say it isn't flyable. ``tasks``: the sector tasks; a sector
    a ground team is assigned to or searching is worth ``cfg.team_discount`` less."""
    if conditions is not None and conditions.flyable is False:
        return []
    grid = live.base.grid
    centre = local_m_to_latlon(grid, grid.cols * grid.cell_m / 2, grid.rows * grid.cell_m / 2)
    lkp = getattr(live.base, "lkp", None) or centre  # where drones start before they report
    visibility = conditions.visibility_factor if conditions is not None else 1.0
    canopy = _canopy(live, cfg)
    taken = {leg.sector_id for leg in fleet.legs if leg.status in ("approved", "flying")}
    teamed = {t.sector_id for t in tasks or [] if t.state in TEAM_BUSY}
    worth = {s.id: 1.0 - cfg.team_discount if s.id in teamed else 1.0 for s in layout.sectors}
    p = np.array(live.p()[0], dtype=np.float64)
    outside = float(live.p()[1])
    drones = [d for d in fleet.drones if d.status in ("idle", "flying")]
    options: dict[str, list[Leg]] = {}
    for d in drones:
        home = _home(d, grid, lkp)
        ok = []
        for leg in candidate_legs(d, layout, grid, cfg, lkp):
            if leg.sector_id in taken:
                continue
            end = latlon_to_local_m(
                grid, LatLon(lat=leg.waypoints[-1][1], lon=leg.waypoints[-1][0])
            )
            if _limits(d, leg, conditions, now, cfg, math.dist(end, home)) is None:
                ok.append(leg)
        options[d.id] = ok

    chosen: list[Leg] = []
    while len(chosen) < k:
        best: tuple[float, Leg, float, Leg | None] | None = None
        for d in drones:
            if any(c.drone_id == d.id for c in chosen):
                continue
            # value = the expected step × worth (a team's sector counts less); ranked per minute
            scored = sorted(
                (
                    (
                        float(
                            np.sum(
                                p[layout.cells_of(leg.sector_id)]
                                * _pods(layout.cells_of(leg.sector_id), canopy, visibility, cfg)
                            )
                        )
                        * worth[leg.sector_id],
                        leg,
                    )
                    for leg in options[d.id]
                    if leg.sector_id not in {c.sector_id for c in chosen}
                ),
                key=lambda x: -x[0] / x[1].est_minutes,
            )
            if not scored or scored[0][0] <= 0:
                continue
            value, leg = scored[0]
            runner_up = scored[1][1] if len(scored) > 1 else None
            runner_value = scored[1][0] if len(scored) > 1 else 0.0
            if best is None or value / leg.est_minutes > best[0] / best[1].est_minutes:
                best = (value, leg, runner_value, runner_up)
        if best is None:
            break
        value, leg, runner_gain, runner_up = best
        gain = value / worth[leg.sector_id]  # what the photos are expected to rule out
        drone = next(d for d in drones if d.id == leg.drone_id)
        rate = value / leg.est_minutes
        why = [
            f"Sector {leg.sector_id}: expected to rule out {gain:.1%} of the probability in {leg.est_minutes:.0f} min ({rate:.2%}/min)"
        ]
        if leg.sector_id in teamed:
            why[0] += f", counted at {worth[leg.sector_id]:.0%} as a ground team is assigned there"
        if runner_up is not None and runner_gain > 0:
            ratio = rate / (runner_gain / runner_up.est_minutes)
            why.append(
                f"{ratio:.1f}× the next best for {drone.name} (sector {runner_up.sector_id})"
            )
        limits = [f"within battery ({drone.battery_pct:.0f}%)"]
        if conditions is not None:
            if conditions.flyable:
                limits.append("wind limit")
            if conditions.civil_twilight_end:
                spare = (
                    _t(conditions.civil_twilight_end).timestamp() - _t(now).timestamp()
                ) / 60 - leg.est_minutes
                limits.append(f"finishes {spare:.0f} min before civil twilight")
        reason = " — ".join(why) + ". " + "; ".join(limits).capitalize() + "."
        chosen.append(
            leg.model_copy(
                update={
                    "expected_clearance": round(gain, 4),
                    "score_per_min": round(rate, 6),
                    "reason": reason,
                }
            )
        )
        # The expected map after this leg: the next drone plans around it.
        cells = layout.cells_of(leg.sector_id)
        pod = _pods(cells, canopy, visibility, cfg)
        denom = 1.0 - float(np.sum(p[cells] * pod))
        p[cells] *= 1.0 - pod
        p /= denom
        outside /= denom
    return chosen


def propose_assignments(
    live: Any,
    layout: SectorLayout,
    tasks: list[SectorTask],
    teams: list[Team],
    cfg: PlannerConfig = PlannerConfig(),  # noqa: B008 - frozen dataclass, never mutated
) -> list[tuple[str, str, str]]:
    """(team id, sector id, reason) for each team on standby: the open sectors where a ground
    team adds the most per minute of its time (walk there + search), greedily by pair."""
    grid = live.base.grid
    p = live.p()[0]
    canopy = _canopy(live, cfg)
    busy = {t.sector_id for t in tasks if t.state in ("assigned", "in_progress", "searched")}
    ranked = []
    for s in layout.sectors:
        if s.id in busy:
            continue
        cells = layout.cells_of(s.id)
        poa = float(p[cells].sum())
        drone_pod = float(np.mean(_pods(cells, canopy, 1.0, cfg)))
        hidden = float(np.mean(canopy[cells]))
        ranked.append((poa * (1 - drone_pod), poa, drone_pod, hidden, s))
    ranked.sort(key=lambda x: -x[0])
    free = [t for t in teams if t.status == "standby"]
    lkp = getattr(live.base, "lkp", None) or local_m_to_latlon(
        grid, grid.cols * grid.cell_m / 2, grid.rows * grid.cell_m / 2
    )
    out = []
    while free and ranked:
        if cfg.walking_kmh is None:  # the old rule: best sector first, to the nearest team
            _, poa, drone_pod, hidden, s = ranked[0]
            team, dist = _nearest(free, s, grid)
            walk = None
        else:
            pace = cfg.walking_kmh * 1000 / 60  # metres a minute
            pairs = [
                (
                    r[0] / (_dist(t.position or lkp, r[4], grid) / pace + cfg.team_search_min),
                    i,
                    r,
                    t,
                )
                for i, r in enumerate(ranked)
                for t in free
            ]
            _, _, (_, poa, drone_pod, hidden, s), team = max(pairs, key=lambda x: (x[0], -x[1]))
            dist = _dist(team.position or lkp, s, grid)
            walk = dist / pace
        ranked = [r for r in ranked if r[4] is not s]
        nearest = _nearest(free, s, grid)[0] is team
        free.remove(team)
        if dist is None:
            where = ""
        elif walk is None:
            where = f"; {team.callsign} is nearest ({dist:.0f} m)"
        elif team.position is None:
            where = (
                f"; {team.callsign} has no position yet: about {walk:.0f} min on foot from the "
                "last known point"
            )
        elif nearest:
            where = f"; {team.callsign} is nearest ({dist:.0f} m, about {walk:.0f} min on foot)"
        else:
            where = f"; {team.callsign} is {dist:.0f} m away (about {walk:.0f} min on foot)"
        out.append(
            (
                team.id,
                s.id,
                (
                    f"Sector {s.id} holds {poa:.1%} of the probability, {hidden:.0%} of it under tree cover where a drone "
                    f"sees poorly (drone POD {drone_pod:.2f}): a ground team adds the most here{where}."
                ),
            )
        )
    return out


def _centre(s: Sector) -> tuple[float, float]:
    return (
        (s.rect["east_min"] + s.rect["east_max"]) / 2,
        (s.rect["south_min"] + s.rect["south_max"]) / 2,
    )


def _dist(at: LatLon, s: Sector, grid: Grid) -> float:
    """Straight-line metres from ``at`` to the sector's centre."""
    return math.dist(latlon_to_local_m(grid, at), _centre(s))


def _nearest(teams: list[Team], s: Sector, grid: Grid) -> tuple[Team, float | None]:
    centre = _centre(s)
    placed = [
        (math.dist(latlon_to_local_m(grid, t.position), centre), t) for t in teams if t.position
    ]
    if placed:
        d, t = min(placed, key=lambda x: x[0])
        return t, d
    return teams[0], None
