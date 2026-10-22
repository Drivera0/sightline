"""Simulated evaluation of the planner against a fixed sector order (LANE_C §5.4, C-P2).

    bash web/scripts/fetch-caches.sh                     # the demo cache (once)
    uv run python scripts/planner_eval.py [--map web/public/cache/demo/map.json] [--trials 2000]

On the demo mission's map (Mount Seymour: grid, labelled placeholder prior, canopy measured from
its photos), one drone from the last known position: minutes until it finds a simulated person,
with the planner vs the sectors in a fixed serpentine order, for 3 seeds × 3 levels of
visibility noise. Prints a table and writes ``runs/planner_eval/result.json``. **Simulated
evaluation**: label it so wherever it is shown (``sightline/search/planner_sim.py``).
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SEEDS = (1, 2, 3)
NOISES = (0.0, 0.15, 0.30)  # the visibility noise of sightline/search/sim.py (0.15 default)


def main(argv: list[str] | None = None) -> int:
    from sightline.contract import MapFile
    from sightline.mission.effects import CLUE_RADIUS_M
    from sightline.search.grid import local_m_to_latlon
    from sightline.search.planner import PlannerConfig
    from sightline.search.planner_sim import minutes_to_find, plan, scenario, summary, with_clue
    from sightline.search.sectors import lattice_sectors

    radius = CLUE_RADIUS_M["sighting"]

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
    known = sum(c is not None for c in m.canopy)
    layout = lattice_sectors(base.grid)
    t0 = time.perf_counter()

    def run(scns: list, label: str) -> list[dict]:
        """Both strategies over the scenarios (pooled), per noise level."""
        rows = []
        for strategy in ("static", "planner"):
            plans = [plan(sc, strategy, cfg, args.horizon) for sc in scns]
            n = max(1, args.trials // len(scns))
            for noise in NOISES:
                per_seed = []
                for seed in SEEDS:
                    mins = np.concatenate(
                        [
                            minutes_to_find(sc, ps, cfg, n, noise, seed * 100 + k)
                            for k, (sc, ps) in enumerate(zip(scns, plans, strict=True))
                        ]
                    )
                    per_seed.append(summary(mins, horizon=args.horizon))
                pooled = {
                    k: None
                    if any(r[k] is None for r in per_seed)
                    else round(float(np.mean([r[k] for r in per_seed])), 3)
                    for k in per_seed[0]
                }
                rows.append(
                    {
                        "scenario": label,
                        "strategy": strategy,
                        "noise": noise,
                        **pooled,
                        "per_seed": per_seed,
                    }
                )
        return rows

    centres = []
    for sec in layout.sectors:
        r = sec.rect
        centres.append(
            local_m_to_latlon(
                base.grid,
                (r["east_min"] + r["east_max"]) / 2,
                (r["south_min"] + r["south_max"]) / 2,
            )
        )
    rows = run([base], "no clue (flat placeholder prior)")
    clue_label = f"a clue at the start ({radius:.0f} m, medium reliability), in each of the 16 sectors in turn"
    rows += run([with_clue(base, at, radius) for at in centres], clue_label)
    result = {
        "simulated": True,
        "map": str(args.map.relative_to(ROOT) if args.map.is_relative_to(ROOT) else args.map),
        "grid": f"{m.grid.rows}×{m.grid.cols} cells of {m.grid.cell_m:.0f} m",
        "prior_source": m.params.prior_source,
        "canopy_known_cells": known,
        "trials_per_row_per_seed": args.trials,
        "seeds": SEEDS,
        "horizon_min": args.horizon,
        "rows": rows,
        "seconds": round(time.perf_counter() - t0, 1),
    }
    out = ROOT / "runs/planner_eval"
    out.mkdir(parents=True, exist_ok=True)
    (out / "result.json").write_text(json.dumps(result, indent=2))

    print(
        f"Simulated evaluation · {result['grid']} · prior {m.params.prior_source} · canopy known for {known} cells · one drone · {args.horizon:.0f} min"
    )
    print(
        "\n| Scenario | Strategy | Visibility noise | Median min to find | Found within 30 min | Found within 2 h |"
    )
    print("|---|---|---|---|---|---|")
    for r in rows:
        med = "> 2 h" if r["median_min"] is None else f"{r['median_min']:.0f}"
        print(
            f"| {r['scenario']} | {r['strategy']} | {r['noise']:.2f} | {med} | {r['found_within_30_min']:.1%} | {r['found_within_horizon']:.1%} |"
        )
    print(
        f"\n{args.trials} trials per row and seed, {len(SEEDS)} seeds; {result['seconds']} s; wrote {out / 'result.json'}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
