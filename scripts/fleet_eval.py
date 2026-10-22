"""Simulated evaluation of the fleet (LANE_C §5.6, C-F3): does coordinating three drones help?

    bash web/scripts/fetch-caches.sh                     # the demo cache (once)
    uv run python scripts/fleet_eval.py [--map web/public/cache/demo/map.json] [--trials 2000]

On the demo mission's map (as ``planner_eval.py``), minutes until a simulated person is found by:
one drone with the planner; three drones splitting the fixed serpentine order; three drones each
running the planner alone; three drones coordinated through one shared expected map. With no clue,
and with a clue at the start in each sector in turn. Visibility noise 0.15, 3 seeds. Prints a table
and writes ``runs/fleet_eval/result.json``. **Simulated evaluation**: label it so wherever it is
shown (``sightline/search/planner_sim.py``).
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SEEDS = (1, 2, 3)
NOISE = 0.15
STRATEGIES = (
    ("1 drone, planner", 1, "planner"),
    ("3 drones, fixed order split in three", 3, "split"),
    ("3 drones, each planning alone", 3, "independent"),
    ("3 drones, coordinated", 3, "coordinated"),
)


def main(argv: list[str] | None = None) -> int:
    from sightline.contract import MapFile
    from sightline.geo.clues import DEFAULT_RADIUS_M
    from sightline.search.grid import local_m_to_latlon
    from sightline.search.planner import PlannerConfig
    from sightline.search.planner_sim import (
        minutes_to_find,
        plan,
        plan_fleet,
        scenario,
        summary,
        with_clue,
    )
    from sightline.search.sectors import lattice_sectors

    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--map", type=Path, default=ROOT / "web/public/cache/demo/map.json")
    ap.add_argument("--trials", type=int, default=2000)
    ap.add_argument("--horizon", type=float, default=120.0, help="minutes of flight simulated")
    args = ap.parse_args(argv)
    if not args.map.is_file():
        print(f"no {args.map}: run `bash web/scripts/fetch-caches.sh` first")
        return 1

    m = MapFile.model_validate_json(args.map.read_text())
    cfg = PlannerConfig()
    base = scenario(m.grid, m.lkp, m.prior.p, m.canopy, cfg)
    layout = lattice_sectors(base.grid)
    radius = DEFAULT_RADIUS_M["sighting"]
    t0 = time.perf_counter()

    def passes(sc, n: int, strategy: str):
        if n == 1:
            return plan(sc, strategy, cfg, args.horizon)
        return plan_fleet(sc, strategy, cfg, n, args.horizon)

    def run(scns: list, label: str) -> list[dict]:
        rows = []
        for name, n, strategy in STRATEGIES:
            plans = [passes(sc, n, strategy) for sc in scns]
            per = max(1, args.trials // len(scns))
            per_seed = [
                summary(
                    np.concatenate([minutes_to_find(sc, ps, cfg, per, NOISE, seed * 100 + k)
                                    for k, (sc, ps) in enumerate(zip(scns, plans, strict=True))]),
                    horizon=args.horizon,
                )
                for seed in SEEDS
            ]  # fmt: skip
            pooled = {
                k: None
                if any(r[k] is None for r in per_seed)
                else round(float(np.mean([r[k] for r in per_seed])), 3)
                for k in per_seed[0]
            }
            rows.append({"scenario": label, "strategy": name, **pooled, "per_seed": per_seed})
        return rows

    centres = [
        local_m_to_latlon(
            base.grid,
            (s.rect["east_min"] + s.rect["east_max"]) / 2,
            (s.rect["south_min"] + s.rect["south_max"]) / 2,
        )
        for s in layout.sectors
    ]
    rows = run([base], "no clue (flat placeholder prior)")
    rows += run(
        [with_clue(base, at, radius) for at in centres],
        f"a clue at the start ({radius:.0f} m, medium), in each sector in turn",
    )
    result = {
        "simulated": True,
        "map": str(args.map.relative_to(ROOT) if args.map.is_relative_to(ROOT) else args.map),
        "grid": f"{m.grid.rows}×{m.grid.cols} cells of {m.grid.cell_m:.0f} m",
        "visibility_noise": NOISE,
        "trials_per_row_per_seed": args.trials,
        "seeds": SEEDS,
        "horizon_min": args.horizon,
        "rows": rows,
        "seconds": round(time.perf_counter() - t0, 1),
    }
    out = ROOT / "runs/fleet_eval"
    out.mkdir(parents=True, exist_ok=True)
    (out / "result.json").write_text(json.dumps(result, indent=2))

    print(
        f"Simulated evaluation · {result['grid']} · visibility noise {NOISE} · {args.horizon:.0f} min"
    )
    print(
        "\n| Scenario | Strategy | Median min to find | P90 | Found within 30 min | Found within 2 h |"
    )
    print("|---|---|---|---|---|---|")
    for r in rows:
        med = "> 2 h" if r["median_min"] is None else f"{r['median_min']:.0f}"
        p90 = "> 2 h" if r["p90_min"] is None else f"{r['p90_min']:.0f}"
        print(
            f"| {r['scenario']} | {r['strategy']} | {med} | {p90} | {r['found_within_30_min']:.1%} | {r['found_within_horizon']:.1%} |"
        )
    print(
        f"\n{args.trials} trials per row and seed, {len(SEEDS)} seeds; {result['seconds']} s; wrote {out / 'result.json'}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
