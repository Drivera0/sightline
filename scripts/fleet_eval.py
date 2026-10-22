"""Simulated evaluation of the fleet (LANE_C §5.6, C-F3), v2: does coordinating three drones help,
and does it still help when the world is not ideal?

    bash web/scripts/fetch-caches.sh                     # the demo cache (once)
    uv run python scripts/fleet_eval.py [--trials 2000] [--presets ideal,realistic,harsh]

Three drones from the last known position on the demo mission's grid (``planner_sim.plan_fleet``):

- **coordinated**: the planner on one expected map shared by the fleet;
- **hand-split**: the fixed serpentine order cut into three runs, one per drone;
- **independent**: the planner on each drone's own map, unaware of the others.

Each trial draws the person's cell from the prior (the ground truth, never seen by the planner) and
their visibility; the time to find is when the photo that finds them **reaches the mission**. With no
clue, and with a clue at the start in each sector in turn. Visibility noise 0.15, seeds 1–5.

**Realism presets** (``PRESETS``; assumptions, not measurements) applied to the same plans:

- **wind**: a steady wind from a random direction per seed; the drones fly at max(8, wind + 3) m/s
  airspeed (at most 15), ground speed = airspeed ± wind on the east-west survey lines (``fleet.py``
  ``ground_speed``), so legs take longer or shorter;
- **battery**: DJI Mavic 3 Enterprise endurance at that airspeed (``fleet.py`` ``Airframe``) with the
  20 % reserve; a drone that would run past it lands for a swap (6 min) between legs;
- **GPS drift**: cross-track error N(0, σ) per pass; a person in the gap it leaves between two lines
  is missed (detection × max(0, 1 − |error| / line spacing));
- **packet loss**: a photo's upload fails with probability q and is retried a minute later;
- **link loss**: per drone, outages (Poisson, per hour) of a fixed length; photos taken during one
  reach the mission when the link is back (the fleet's buffering, ``fleet.py``).

**Val only**: the demo cache was built from HERIDAL *test* imagery, so its measured canopy is not
used: every cell's canopy is unknown (0.5) and the prior is the cache's uniform placeholder; only the
grid geometry is kept. Writes ``runs/fleet_eval_v2/result.json`` and prints a table. **Simulated
evaluation**: label it so wherever it is shown.
"""

from __future__ import annotations

import argparse
import json
import math
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SEEDS = (1, 2, 3, 4, 5)
NOISE = 0.15
PLAN_SPEED_MS = 8.0
SWAP_MIN = 6.0  # fly home, swap the battery, fly back (assumption)
PACKET_RETRY_MIN = 1.0
STRATEGIES = (
    ("coordinated", "coordinated"),
    ("hand-split", "split"),
    ("independent", "independent"),
)


@dataclass(frozen=True)
class Realism:
    wind_ms: float = 0.0
    gps_sigma_m: float = 0.0
    packet_loss: float = 0.0
    outages_per_h: float = 0.0
    outage_min: float = 0.0
    battery: bool = False


PRESETS = {
    "ideal": Realism(),
    # a breezy day; DJI's GNSS hover accuracy is ±0.5 m horizontal, track-keeping in wind is worse
    "realistic": Realism(
        wind_ms=6.0,
        gps_sigma_m=2.5,
        packet_loss=0.02,
        outages_per_h=1.0,
        outage_min=3.0,
        battery=True,
    ),
    # strong wind under the 12 m/s limit, poor GNSS in a valley, a weak radio link
    "harsh": Realism(
        wind_ms=10.0,
        gps_sigma_m=6.0,
        packet_loss=0.10,
        outages_per_h=2.0,
        outage_min=8.0,
        battery=True,
    ),
}


@dataclass
class Flown:
    """One pass as flown under a preset: when each cell was photographed, by which drone."""

    drone: str
    cell_time: dict[int, float]


def realise(passes: list, r: Realism, rng: np.random.Generator) -> tuple[list[Flown], dict[str, list[tuple[float, float]]], dict]:  # fmt: skip
    """The plan's passes stretched by the wind, with battery swaps, and each drone's link outages."""
    from sightline.search.fleet import MAVIC_3E, RESERVE_FRAC, Wind, ground_speed

    wind = Wind(speed_ms=r.wind_ms, from_deg=float(rng.uniform(0, 360)))
    air = min(MAVIC_3E.max_speed_ms, max(PLAN_SPEED_MS, r.wind_ms + 3.0)) if r.wind_ms > 0 else PLAN_SPEED_MS  # fmt: skip
    gs = [ground_speed(air, h, wind) for h in (90.0, 270.0)]
    factor = math.inf if min(gs) <= 0 else float(np.mean([PLAN_SPEED_MS / g for g in gs]))
    endurance = (
        100 * (1 - RESERVE_FRAC) / MAVIC_3E.drain_pct_per_min(air) if r.battery else math.inf
    )
    out: list[Flown] = []
    by_drone: dict[str, list] = {}
    for ps in passes:
        by_drone.setdefault(ps.leg.drone_id, []).append(ps)
    for d, mine in by_drone.items():
        shift, airborne = 0.0, 0.0
        for ps in sorted(mine, key=lambda x: x.start_min):
            dur = ps.leg.est_minutes * factor
            if airborne + dur > endurance:
                shift += SWAP_MIN
                airborne = 0.0
            airborne += dur
            out.append(Flown(d, {c: t * factor + shift for c, t in ps.cell_time.items()}))
    horizon_h = 4.0
    outages = {
        d: [
            (s, s + r.outage_min)
            for s in sorted(
                rng.uniform(0, horizon_h * 60, rng.poisson(r.outages_per_h * horizon_h))
            )
        ]
        for d in by_drone
    }
    return out, outages, {"wind_from_deg": round(wind.from_deg or 0.0), "airspeed_ms": air,
                          "time_factor": round(factor, 3), "endurance_min": round(endurance, 1)}  # fmt: skip


def minutes_to_find(scn, flown: list[Flown], outages: dict, cfg, r: Realism, trials: int, seed: int) -> np.ndarray:  # fmt: skip
    """Minutes until the photo that finds the person reaches the mission, per trial (inf: never)."""
    rng = np.random.default_rng(seed)
    cells = rng.choice(scn.prior.size, size=trials, p=scn.prior)
    vis = np.clip(1.0 - scn.canopy[cells] + rng.normal(0.0, NOISE, size=trials), 0.0, 1.0)
    by_cell: dict[int, list[tuple[float, str]]] = {}
    for f in flown:
        for c, t in f.cell_time.items():
            by_cell.setdefault(c, []).append((t, f.drone))
    out = np.full(trials, np.inf)
    for i in range(trials):
        best = math.inf
        for t, d in sorted(by_cell.get(int(cells[i]), ())):
            if t >= best:
                break
            p = cfg.recall * vis[i]
            if r.gps_sigma_m > 0:
                p *= max(0.0, 1.0 - abs(rng.normal(0.0, r.gps_sigma_m)) / cfg.line_spacing_m)
            if rng.random() >= p:
                continue
            arrive = t
            for s, e in outages.get(d, ()):
                if s <= t < e:
                    arrive = e  # kept on board until the link is back
            if r.packet_loss > 0 and rng.random() < r.packet_loss:
                arrive += PACKET_RETRY_MIN
            best = min(best, arrive)
        out[i] = best
    return out


def main(argv: list[str] | None = None) -> int:
    from sightline.contract import MapFile
    from sightline.geo.clues import DEFAULT_RADIUS_M
    from sightline.search.grid import local_m_to_latlon
    from sightline.search.planner import PlannerConfig
    from sightline.search.planner_sim import plan_fleet, scenario, summary, with_clue
    from sightline.search.sectors import lattice_sectors

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)  # fmt: skip
    ap.add_argument("--map", type=Path, default=ROOT / "web/public/cache/demo/map.json")
    ap.add_argument("--trials", type=int, default=2000)
    ap.add_argument("--horizon", type=float, default=120.0, help="minutes of flight simulated")
    ap.add_argument("--presets", default="ideal,realistic,harsh")
    ap.add_argument("--out", type=Path, default=ROOT / "runs/fleet_eval_v2")
    args = ap.parse_args(argv)
    if not args.map.is_file():
        print(f"no {args.map}: run `bash web/scripts/fetch-caches.sh` first")
        return 1
    presets = [p.strip() for p in args.presets.split(",") if p.strip()]

    m = MapFile.model_validate_json(args.map.read_text())
    cfg = PlannerConfig()
    # val only: no canopy measured on the cache's (test) photos; every cell unknown
    base = scenario(m.grid, m.lkp, m.prior.p, [None] * len(m.prior.p), cfg)
    layout = lattice_sectors(base.grid)
    radius = DEFAULT_RADIUS_M["sighting"]
    t0 = time.perf_counter()
    centres = [
        local_m_to_latlon(
            base.grid,
            (s.rect["east_min"] + s.rect["east_max"]) / 2,
            (s.rect["south_min"] + s.rect["south_max"]) / 2,
        )
        for s in layout.sectors
    ]
    scenarios = [
        ("no clue", [base]),
        (
            f"a clue at the start ({radius:.0f} m), each sector in turn",
            [with_clue(base, at, radius) for at in centres],
        ),
    ]
    # the plans don't depend on the realism (it changes how they are flown): plan once, with slack
    plans = {
        (label, name): [plan_fleet(sc, strategy, cfg, 3, args.horizon * 1.5) for sc in scns]
        for label, scns in scenarios
        for name, strategy in STRATEGIES
    }
    rows = []
    for preset in presets:
        r = PRESETS[preset]
        for label, scns in scenarios:
            for name, _ in STRATEGIES:
                per = max(1, args.trials // len(scns))
                per_seed, flights = [], []
                for seed in SEEDS:
                    mins = []
                    for k, (sc, ps) in enumerate(zip(scns, plans[(label, name)], strict=True)):
                        rng = np.random.default_rng(seed * 1000 + k)
                        flown, outages, info = realise(ps, r, rng)
                        mins.append(
                            minutes_to_find(sc, flown, outages, cfg, r, per, seed * 100 + k)
                        )
                        if k == 0:
                            flights.append(info)
                    per_seed.append(summary(np.concatenate(mins), horizon=args.horizon))
                pooled = {
                    k: None if any(x[k] is None for x in per_seed)
                    else round(float(np.mean([x[k] for x in per_seed])), 3)
                    for k in per_seed[0]
                }  # fmt: skip
                spread = [x["found_within_30_min"] for x in per_seed]
                rows.append({"preset": preset, "scenario": label, "strategy": name, **pooled,
                             "found_within_30_min_range": [min(spread), max(spread)],
                             "per_seed": per_seed, "flight": flights})  # fmt: skip
        print(f"  {preset} done ({time.perf_counter() - t0:.0f} s)", flush=True)

    result = {
        "simulated": True,
        "version": 2,
        "map": str(args.map.relative_to(ROOT) if args.map.is_relative_to(ROOT) else args.map),
        "grid": f"{m.grid.rows}×{m.grid.cols} cells of {m.grid.cell_m:.0f} m",
        "canopy": "unknown everywhere (0.5): the demo cache's canopy comes from test photos (val only)",
        "prior": m.params.prior_source or "placeholder",
        "visibility_noise": NOISE,
        "trials_per_row_per_seed": args.trials,
        "seeds": SEEDS,
        "horizon_min": args.horizon,
        "presets": {k: asdict(PRESETS[k]) for k in presets},
        "swap_min": SWAP_MIN,
        "packet_retry_min": PACKET_RETRY_MIN,
        "rows": rows,
        "seconds": round(time.perf_counter() - t0, 1),
    }
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "result.json").write_text(json.dumps(result, indent=2))
    table = render(result)
    (args.out / "table.md").write_text(table + "\n")
    print(table)
    print(f"\n{args.trials} trials per row and seed, {len(SEEDS)} seeds; {result['seconds']} s; wrote {args.out / 'result.json'}")  # fmt: skip
    return 0


def render(result: dict) -> str:
    fmt = lambda x: "> 2 h" if x is None else f"{x:.0f}"
    lines = [
        f"Simulated evaluation · {result['grid']} · canopy unknown (val only) · visibility noise {result['visibility_noise']} · {result['horizon_min']:.0f} min · seeds {len(result['seeds'])}",
        "",
        "| Preset | Scenario | Strategy | Median min to find | P90 | Found within 30 min (seed range) | Found within 2 h |",
        "|---|---|---|---|---|---|---|",
    ]  # fmt: skip
    for r in result["rows"]:
        lo, hi = r["found_within_30_min_range"]
        lines.append(f"| {r['preset']} | {r['scenario']} | {r['strategy']} | {fmt(r['median_min'])} | {fmt(r['p90_min'])} | {r['found_within_30_min']:.1%} ({lo:.1%}–{hi:.1%}) | {r['found_within_horizon']:.1%} |")  # fmt: skip
    return "\n".join(lines)


if __name__ == "__main__":
    raise SystemExit(main())
