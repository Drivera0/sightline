"""Simulated evaluation of the planner v2 changes (Koester prior, ground-team awareness, re-plans
for every idle drone), on validation data only:

    uv run python scripts/planner_v2_eval.py [--canopy-from runs/creek/<run>/missions/<id>]

The map is a new mission's 1 km grid of 5 m cells at the creek scenario's last known point. Its
canopy is what the creek run's photos measured (HERIDAL **val** crops; ``scripts/creek_run.py``),
``unknown_canopy`` (0.5) elsewhere; the team rows are also run on a synthetic canopy (each sector
one value from U(0, 0.9), seed 0), labelled. The demo cache map is not used: its canopy comes from
HERIDAL test photos. Minutes until a simulated person is found (``planner_sim.plan_mission`` +
``minutes_to_find``), visibility noise 0.15, 5 seeds of the person draw:

(a) prior: the person drawn from Koester's rings (weight 1: as if the rings were right), the
    planner believing the uniform prior or the Koester blend; 1 and 3 drones. Plus the reverse
    (person uniform, planner Koester) to show the cost when the category is wrong.
(b) team awareness: 3 drones + 2 teams; the drone discount and the walking time on or off.
(c) re-plans: 3 drones + 2 teams, a clue in each sector in turn; the best leg only per event vs
    the best leg plus every idle drone; with and without the agent's opening legs.
(d) terrain affinity (``--affinity``, off by default): the person drawn from the rings with or
    without the terrain multiplier (``geo/terrain_affinity.py``, from the offline basemap), the
    planner believing the Koester blend with or without it; 1 and 3 drones, the same seeds.

Writes ``runs/planner_v2/result.json`` and prints the tables. **Simulated evaluation**: label it
so wherever it is shown.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SEEDS = (1, 2, 3, 4, 5)
NOISE = 0.15


def _val_canopy(mission: Path | None) -> tuple[list[float | None], str]:
    """Canopy per cell from a creek run's map log (val crops), or all unknown."""
    from sightline.contract import MapBase, MapUpdate
    from sightline.search.live import LiveMap

    if mission is None:
        runs = sorted((ROOT / "runs/creek").glob("*/missions/*/map_updates.jsonl"))
        done = [r.parent for r in runs if (r.parents[2] / "creek_run.json").is_file()]
        mission = done[-1] if done else None
    if mission is None:
        return [None] * 40000, "unknown everywhere (no creek run found)"
    live = LiveMap.from_base(MapBase.model_validate_json((mission / "map_base.json").read_text()))
    for line in (mission / "map_updates.jsonl").read_text().splitlines():
        live.apply(MapUpdate.model_validate_json(line))
    c = live.canopy()
    src = str(mission.relative_to(ROOT) if mission.is_relative_to(ROOT) else mission)
    return c, f"{src}: {sum(v is not None for v in c)} cells measured on val crops"


def main(argv: list[str] | None = None) -> int:
    from sightline.geo.clues import DEFAULT_RADIUS_M
    from sightline.search.fleet import Scenario as FleetScenario
    from sightline.search.grid import local_m_to_latlon, make_grid
    from sightline.search.planner import PlannerConfig
    from sightline.search.planner_sim import (
        minutes_to_find,
        plan_mission,
        scenario,
        summary,
        with_clue,
    )
    from sightline.search.prior import koester_prior, placeholder_prior
    from sightline.search.sectors import lattice_sectors

    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--canopy-from", type=Path, default=None, help="a creek run's mission folder")
    ap.add_argument("--trials", type=int, default=2000)
    ap.add_argument("--horizon", type=float, default=120.0, help="minutes simulated")
    ap.add_argument("--affinity", action="store_true", help="add study (d): terrain affinity")
    ap.add_argument("--only-affinity", action="store_true", help="run study (d) alone")
    args = ap.parse_args(argv)
    args.affinity = args.affinity or args.only_affinity
    t0 = time.perf_counter()

    lkp = FleetScenario.load("creek").lkp
    grid = make_grid(lkp, 1000.0, 5.0)
    layout = lattice_sectors(grid)
    cfg = PlannerConfig()
    v1 = PlannerConfig(team_discount=0.0, walking_kmh=None)  # the planner before v2
    canopy, canopy_src = _val_canopy(args.canopy_from)
    rng = np.random.default_rng(0)
    synthetic = np.empty(grid.rows * grid.cols)
    for s in layout.sectors:
        synthetic[layout.cells_of(s.id)] = rng.uniform(0.0, 0.9)
    uniform = placeholder_prior(grid)[0].tolist()
    base = scenario(grid, lkp, uniform, canopy, cfg)
    synth = scenario(grid, lkp, uniform, synthetic.tolist(), cfg)
    radius = DEFAULT_RADIUS_M["sighting"]
    centres = [
        local_m_to_latlon(grid, (s.rect["east_min"] + s.rect["east_max"]) / 2,
                          (s.rect["south_min"] + s.rect["south_max"]) / 2)
        for s in layout.sectors
    ]  # fmt: skip

    def score(pairs: list[tuple]) -> dict:
        """pairs: (truth scenario, passes); pooled over them, per seed, then the seeds' mean."""
        per = max(1, args.trials // len(pairs))
        per_seed = [
            summary(np.concatenate([minutes_to_find(truth, ps, cfg, per, NOISE, seed * 100 + k)
                                    for k, (truth, ps) in enumerate(pairs)]), horizon=args.horizon)
            for seed in SEEDS
        ]  # fmt: skip
        pooled = {
            k: None
            if any(r[k] is None for r in per_seed)
            else round(float(np.mean([r[k] for r in per_seed])), 3)
            for k in per_seed[0]
        }
        spread = [r["found_within_30_min"] for r in per_seed]
        return {
            **pooled,
            "found_30_min_seed_range": [min(spread), max(spread)],
            "per_seed": per_seed,
        }

    rows: list[dict] = []
    if args.only_affinity:
        _affinity_rows(rows, grid, lkp, canopy, cfg, args, score)
        return _report(rows, grid, canopy_src, args, t0)

    # (a) prior
    for cat in ("hiker/temperate_mountainous", "dementia/temperate_mountainous"):
        truth = scenario(
            grid, lkp, koester_prior(grid, lkp, cat, weight=1.0)[0].tolist(), canopy, cfg
        )
        believed = scenario(grid, lkp, koester_prior(grid, lkp, cat)[0].tolist(), canopy, cfg)
        for n in (1, 3):
            for name, belief in (("uniform", base), ("Koester 0.8 blend", believed)):
                ps = plan_mission(belief, cfg, n, 0, args.horizon)
                rows.append({"study": "a", "scenario": f"person from {cat} rings", "drones": n,
                             "variant": f"planner believes {name}", **score([(truth, ps)])})  # fmt: skip
        if cat.startswith("dementia"):
            for name, belief in (("uniform", base), ("Koester 0.8 blend", believed)):
                ps = plan_mission(belief, cfg, 3, 0, args.horizon)
                rows.append({"study": "a", "scenario": "person uniform (category wrong)", "drones": 3,
                             "variant": f"planner believes {name} ({cat})", **score([(base, ps)])})  # fmt: skip

    # (b) team awareness: 3 drones, 2 teams
    variants = (
        ("v1: teams ignored by drones, nearest team", v1),
        ("drone discount only", PlannerConfig(walking_kmh=None)),
        ("walking time only", PlannerConfig(team_discount=0.0)),
        ("v2: discount 0.5 + walking time", cfg),
    )
    for label, scn in (("val canopy", base), ("synthetic sector canopy", synth)):
        clued = [with_clue(scn, at, radius) for at in centres]
        for name, c in variants:
            rows.append({"study": "b", "scenario": f"{label}, no clue", "drones": 3, "teams": 2,
                         "variant": name, **score([(scn, plan_mission(scn, c, 3, 2, args.horizon))])})  # fmt: skip
            pairs = [(cl, plan_mission(scn, c, 3, 2, args.horizon, clue=cl)) for cl in clued]
            rows.append({"study": "b", "scenario": f"{label}, a clue at minute 0 in each sector",
                         "drones": 3, "teams": 2, "variant": name, **score(pairs)})  # fmt: skip

    # (c) re-plans: one leg per event vs every idle drone
    clued = [with_clue(base, at, radius) for at in centres]
    for opening, clue_min in ((False, 0.0), (True, 0.0), (True, 10.0)):
        for replan in ("one", "idle"):
            pairs = [(cl, plan_mission(base, cfg, 3, 2, args.horizon, replan=replan, opening=opening,
                                       clue=cl, clue_min=clue_min)) for cl in clued]  # fmt: skip
            rows.append({"study": "c", "drones": 3, "teams": 2,
                         "scenario": f"{'opening legs' if opening else 'no opening legs'}, clue at minute {clue_min:.0f}",
                         "variant": "best leg only (v1)" if replan == "one" else "best leg + every idle drone (v2)",
                         **score(pairs)})  # fmt: skip

    if args.affinity:
        _affinity_rows(rows, grid, lkp, canopy, cfg, args, score)
    return _report(rows, grid, canopy_src, args, t0)


def _affinity_rows(rows, grid, lkp, canopy, cfg, args, score) -> None:
    """Study (d): rings with and without the terrain affinity, as truth and as belief."""
    from sightline.geo.terrain_affinity import affinity_raster, features_from_pmtiles, grid_bbox
    from sightline.search.planner_sim import plan_mission, scenario
    from sightline.search.prior import koester_prior

    pmtiles = ROOT / "web/public/basemap/northshore.pmtiles"
    aff = affinity_raster(grid, features_from_pmtiles(pmtiles, grid_bbox(grid)))
    for cat in ("hiker/temperate_mountainous", "dementia/temperate_mountainous"):
        truths = {
            "rings × terrain": koester_prior(grid, lkp, cat, weight=1.0, affinity=aff)[0],
            "rings only": koester_prior(grid, lkp, cat, weight=1.0)[0],
        }
        beliefs = {
            "Koester 0.8 blend": koester_prior(grid, lkp, cat)[0],
            "Koester 0.8 blend × terrain": koester_prior(grid, lkp, cat, affinity=aff)[0],
        }
        for tname, tp in truths.items():
            truth = scenario(grid, lkp, tp.tolist(), canopy, cfg)
            for n in (1, 3):
                for bname, bp in beliefs.items():
                    belief = scenario(grid, lkp, bp.tolist(), canopy, cfg)
                    ps = plan_mission(belief, cfg, n, 0, args.horizon)
                    rows.append({"study": "d", "scenario": f"person from {cat} {tname}",
                                 "drones": n, "variant": f"planner believes {bname}",
                                 **score([(truth, ps)])})  # fmt: skip


def _report(rows, grid, canopy_src, args, t0) -> int:
    result = {
        "simulated": True,
        "grid": f"{grid.rows}×{grid.cols} cells of {grid.cell_m:.0f} m at the creek LKP",
        "canopy": canopy_src,
        "visibility_noise": NOISE,
        "trials_per_row_per_seed": args.trials,
        "seeds": SEEDS,
        "horizon_min": args.horizon,
        "team_model": "2 teams from the LKP, 3 km/h straight line, 60 min per sector, POD 0.5 per pass",
        "rows": rows,
        "seconds": round(time.perf_counter() - t0, 1),
    }
    out = ROOT / ("runs/planner_v2_affinity" if args.only_affinity else "runs/planner_v2")
    out.mkdir(parents=True, exist_ok=True)
    (out / "result.json").write_text(json.dumps(result, indent=2))

    print(
        f"Simulated evaluation · {result['grid']} · canopy {canopy_src} · noise {NOISE} · {args.horizon:.0f} min"
    )
    print(
        "\n| Study | Scenario | Drones | Variant | Median min | Found ≤ 30 min (seed range) | Found ≤ 2 h |"
    )
    print("|---|---|---|---|---|---|---|")
    for r in rows:
        med = "> 2 h" if r["median_min"] is None else f"{r['median_min']:.0f}"
        lo, hi = r["found_30_min_seed_range"]
        print(f"| {r['study']} | {r['scenario']} | {r['drones']} | {r['variant']} | {med} | "
              f"{r['found_within_30_min']:.1%} ({lo:.1%}–{hi:.1%}) | {r['found_within_horizon']:.1%} |")  # fmt: skip
    print(
        f"\n{args.trials} trials per row and seed, {len(SEEDS)} seeds; {result['seconds']} s; wrote {out / 'result.json'}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
