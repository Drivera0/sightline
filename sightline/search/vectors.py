"""Test vectors for the TypeScript mirror of the update (LANE_C_SEARCH section 6.5).

Run `uv run python -m sightline.search.vectors` to rewrite
web/src/search/__fixtures__/update_vectors.json. Every expected value comes from the
Python functions in update.py and grid.py; web/src/search/update.test.ts checks that
update.ts gives the same values within 1e-9.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np

from sightline.contract import Grid, LatLon
from sightline.search.grid import cell_center, cells_within_radius, local_m_to_latlon, make_grid
from sightline.search.update import apply_review_not_person, apply_step

DEFAULT_OUT = Path("web/src/search/__fixtures__/update_vectors.json")
SEED = 7
DEMO_LKP = LatLon(lat=49.37, lon=-122.945)


def _state(p: np.ndarray, outside: float) -> dict[str, Any]:
    return {"p": [float(x) for x in p], "outside": float(outside)}


def _random_prior(rng: np.random.Generator, n: int) -> tuple[np.ndarray, float]:
    outside = float(rng.uniform(0.1, 0.5))
    raw = rng.random(n) + 0.01
    return (1.0 - outside) * raw / raw.sum(), outside


def _random_step(rng: np.random.Generator, n: int) -> list[tuple[int, float]]:
    k = int(rng.integers(0, 11))  # 0 gives an empty step
    idx = rng.choice(n, size=k, replace=False)
    pods = rng.uniform(0.0, 0.95, size=k)
    return [(int(i), float(q)) for i, q in zip(idx, pods, strict=True)]


def _step_case(
    name: str, p: np.ndarray, outside: float, steps: list[list[tuple[int, float]]]
) -> dict[str, Any]:
    after = []
    cur_p, cur_out = p, outside
    for cells in steps:
        cur_p, cur_out = apply_step(cur_p, cur_out, cells)
        after.append(_state(cur_p, cur_out))
    return {
        "name": name,
        "prior": _state(p, outside),
        "steps": [{"cells": [[i, q] for i, q in cells]} for cells in steps],
        "after": after,
    }


def _radius_case(name: str, grid: Grid, at: LatLon, radius_m: float) -> dict[str, Any]:
    return {
        "name": name,
        "grid": grid.model_dump(),
        "lat": at.lat,
        "lon": at.lon,
        "radius_m": radius_m,
        "expected": cells_within_radius(grid, at, radius_m),
    }


def _review_case(
    name: str,
    grid: Grid,
    p: np.ndarray,
    outside: float,
    at: LatLon,
    radius_m: float,
    review_pod: float,
    pod_cap: float,
) -> dict[str, Any]:
    new_p, new_out = apply_review_not_person(p, outside, grid, at, radius_m, review_pod, pod_cap)
    return {
        "name": name,
        "grid": grid.model_dump(),
        "state": _state(p, outside),
        "lat": at.lat,
        "lon": at.lon,
        "radius_m": radius_m,
        "review_pod": review_pod,
        "pod_cap": pod_cap,
        "expected": _state(new_p, new_out),
    }


# Build every case; pure and deterministic (seed 7).
def build_test_vectors(seed: int = SEED) -> dict[str, Any]:
    """All cases with inputs and the Python results, as a JSON-ready dict."""
    rng = np.random.default_rng(seed)
    small = make_grid(DEMO_LKP, size_m=100.0, cell_m=20.0)
    big = make_grid(DEMO_LKP)
    n_small = small.rows * small.cols

    step_cases = [
        _step_case("three-cell example", np.array([0.5, 0.3, 0.2]), 0.0, [[(0, 0.8), (1, 0.2)]])
    ]
    for k in range(4):
        p, outside = _random_prior(rng, n_small)
        steps = [_random_step(rng, n_small) for _ in range(8)]
        step_cases.append(_step_case(f"5x5 random {k}", p, outside, steps))

    radius_cases = []
    for label, grid in (("50x50", big), ("5x5", small)):
        c = grid.cell_m
        # The cell at the middle row/column; on the 50x50 its north-west corner is the LKP.
        mid = (grid.rows // 2) * grid.cols + grid.cols // 2
        centre = cell_center(grid, mid)
        radius_cases += [
            _radius_case(f"{label} LKP r=1", grid, DEMO_LKP, 1.0),
            _radius_case(f"{label} cell centre r=9", grid, centre, 9.0),
            _radius_case(f"{label} cell centre r=12", grid, centre, 12.0),
            _radius_case(f"{label} cell centre r=15", grid, centre, 15.0),
            _radius_case(
                f"{label} near west edge r=15",
                grid,
                local_m_to_latlon(grid, 3.0, 2.5 * c),
                15.0,
            ),
            _radius_case(
                f"{label} near south-east corner r=25",
                grid,
                local_m_to_latlon(grid, grid.cols * c - 4.0, grid.rows * c - 7.0),
                25.0,
            ),
            _radius_case(
                f"{label} outside north r=5",
                grid,
                local_m_to_latlon(grid, 1.5 * c, -30.0),
                5.0,
            ),
            _radius_case(
                f"{label} outside north r=35",
                grid,
                local_m_to_latlon(grid, 1.5 * c, -30.0),
                35.0,
            ),
            _radius_case(f"{label} cell centre r=0", grid, centre, 0.0),
        ]

    review_cases = []
    p, outside = _random_prior(rng, n_small)
    review_cases.append(
        _review_case("5x5 centre r=10", small, p, outside, DEMO_LKP, 10.0, 0.9, 0.95)
    )
    p, outside = _random_prior(rng, n_small)
    review_cases.append(
        _review_case(
            "5x5 near edge r=25, review_pod above cap",
            small,
            p,
            outside,
            local_m_to_latlon(small, 6.0, 91.0),
            25.0,
            0.99,
            0.95,
        )
    )
    n_big = big.rows * big.cols
    p, outside = _random_prior(rng, n_big)
    review_cases.append(_review_case("50x50 LKP r=10", big, p, outside, DEMO_LKP, 10.0, 0.9, 0.95))

    return {
        "seed": seed,
        "note": "Generated by `python -m sightline.search.vectors`; do not edit by hand.",
        "step_cases": step_cases,
        "radius_cases": radius_cases,
        "review_cases": review_cases,
        "live_cases": _live_cases(seed + 1),
    }


def _live_cases(seed: int) -> list[dict[str, Any]]:
    """A live mission's map (C-L1): ``map_base`` + a log of step and reweight updates, with the
    state after each from ``LiveMap.apply`` (the TS ``replayLive`` must agree)."""
    from sightline.contract import CONTRACT_VERSION, Distribution, MapBase, MapUpdate, Params
    from sightline.search.live import LiveMap

    rng = np.random.default_rng(seed)
    grid = make_grid(DEMO_LKP, size_m=100.0, cell_m=20.0)
    n = grid.rows * grid.cols
    cases = []
    for k in range(3):
        p, outside = _random_prior(rng, n)
        base = MapBase(
            contract_version=CONTRACT_VERSION,
            grid=grid,
            lkp=DEMO_LKP,
            params=Params(recall=0.8, recall_source="vectors", pod_cap=0.95, review_pod=0.9),
            prior=Distribution(p=[float(x) for x in p], outside=float(outside)),
            canopy=[None] * n,
        )
        live = LiveMap.from_base(base)
        updates, after = [], []
        for seq in range(1, 31):  # past one checkpoint (every 25)
            if rng.random() < 0.6:
                kind, cells = "step", _random_step(rng, n)
            else:
                idx = rng.choice(n, size=int(rng.integers(1, 8)), replace=False)
                kind, cells = "reweight", [(int(i), float(rng.uniform(0.2, 6.0))) for i in idx]
            u = MapUpdate(seq=seq, kind=kind, source="frame" if kind == "step" else "clue",
                          ref=None, cells=cells, at="2026-10-24T22:00:00Z")  # fmt: skip
            live.apply(u)
            updates.append(u.model_dump(mode="json"))
            after.append(_state(*live.p()))
        cases.append({"name": f"5x5 live {k}", "base": base.model_dump(mode="json"),
                      "updates": updates, "after": after})  # fmt: skip
    cases.append(_evidence_case(base))
    return cases


# Write the vectors file the vitest suite reads.
def write_test_vectors(out: Path = DEFAULT_OUT) -> None:
    """Write build_test_vectors() as JSON to out (floats at full precision)."""
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(build_test_vectors(), separators=(",", ":")) + "\n", encoding="utf-8")


def main() -> None:
    write_test_vectors()
    print(f"wrote {DEFAULT_OUT}")


def _evidence_case(base: Any) -> dict[str, Any]:
    """Every kind of evidence through ``LiveMap``'s own methods, in the order a search meets them:
    a photo steps the map, a reviewer says "person" (its look is undone), a team searches a sector,
    a clue raises its surroundings, exposure turns high (shelter). The TS ``replayLive`` must agree."""
    import json as _json
    from pathlib import Path as _Path

    from sightline.contract import CONTRACT_VERSION, Clue, Conditions, MapBase, MapUpdate
    from sightline.search.live import LiveMap
    from sightline.search.sectors import lattice_sectors

    n = base.grid.rows * base.grid.cols
    canopy = [None if i % 3 == 0 else round(0.2 + 0.1 * (i % 7), 2) for i in range(n)]
    base = MapBase.model_validate(
        {**base.model_dump(), "canopy": canopy, "contract_version": CONTRACT_VERSION}
    )
    live = LiveMap.from_base(base)
    at = "2026-10-24T22:00:00Z"
    centre = cell_center(base.grid, n // 2)
    ups: list[MapUpdate] = []

    def take(u: MapUpdate | None) -> None:
        assert u is not None
        u = u.model_copy(update={"seq": len(ups) + 1, "at": at})
        live.apply(u)
        ups.append(u)

    take(MapUpdate(seq=1, kind="step", source="frame", ref="f0001",
                   cells=[(i, 0.6) for i in range(n) if i % 2 == 0], at=at))  # fmt: skip
    take(live.review_update("f0001-d01", "f0001", centre, 25.0, "person"))
    layout = lattice_sectors(base.grid)
    take(live.ground_update([int(i) for i in layout.cells_of("A1")], 0.99, "A1"))  # capped at 0.9
    clue = Clue(id="c001", kind="object", text="pack", lat=centre.lat, lon=centre.lon, at_team_position=False,
                radius_m=20.0, reliability="high", reported_by="T2", source="form", confirmed_by_turn=None,
                at=at, confirmed=True)  # fmt: skip
    take(live.clue_update(clue))
    fx = _json.loads(
        (
            _Path(__file__).resolve().parents[2] / "tests/geo/fixtures/conditions_windy.json"
        ).read_text()
    )
    take(
        live.conditions_update(
            Conditions.model_validate({**fx["conditions"], "exposure_band": "high"})
        )
    )
    after = []
    replayed = LiveMap.from_base(base)
    for u in ups:
        replayed.apply(u)
        after.append(_state(*replayed.p()))
    return {"name": "5x5 evidence: frame, review person, ground, clue, shelter", "base": base.model_dump(mode="json"),
            "updates": [u.model_dump(mode="json") for u in ups], "after": after}  # fmt: skip


if __name__ == "__main__":
    main()
