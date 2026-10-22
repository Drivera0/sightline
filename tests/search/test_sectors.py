"""C-S1: the Python port of sectors.ts (§6 test 1). The TS side checks the same vectors in
web/src/map/heat/sectorVectors.test.ts; this keeps the committed file in step with the code."""

from __future__ import annotations

import json
from pathlib import Path

from sightline.contract import LatLon
from sightline.search.grid import make_grid
from sightline.search.sectors import (
    SECTOR_VECTORS,
    _synthetic_flight,
    build_sector_vectors,
    build_sectors,
    lattice_sectors,
    sector_state,
)

ROOT = Path(__file__).resolve().parents[2]
G = make_grid(LatLon(lat=49.375, lon=-122.9375), cell_m=5.0)


def test_the_committed_vectors_are_what_the_code_gives() -> None:
    committed = json.loads((ROOT / SECTOR_VECTORS).read_text())
    demo = ROOT / "web/public/cache/demo/survey.json"
    fresh = build_sector_vectors(str(demo) if demo.is_file() else None)
    by_name = {c["name"]: c for c in committed["cases"]}
    for case in fresh["cases"]:  # without the demo cache, the four synthetic cases still match
        assert case == by_name[case["name"]], case["name"]


def test_an_east_west_flight_becomes_flight_sectors_and_the_rest_outer() -> None:
    layout = build_sectors(G, _synthetic_flight(G, 12, 8))
    assert layout.kind == "flight"
    assert [s.id for s in layout.sectors] == ["S1", "S2", "S3", "N", "E", "S", "W"]
    assert [s.steps for s in layout.sectors[:3]] == [
        (1, 32),
        (33, 64),
        (65, 96),
    ]  # 4 lines of 8 each
    assert sorted(set(layout.cell_sector.tolist())) == list(range(7))  # every sector owns cells


def test_anything_else_is_the_map_reference_lattice() -> None:
    assert build_sectors(G, _synthetic_flight(G, 9, 1)).kind == "lattice"  # one photo per line
    layout = lattice_sectors(G)
    b3 = next(s for s in layout.sectors if s.id == "B3")
    assert (b3.rect["east_min"], b3.rect["south_min"]) == (250.0, 500.0)  # column B, row 3


def test_sector_state_thresholds() -> None:
    assert [sector_state(x) for x in (0.0, 0.02, 0.89, 0.9)] == [
        "not_searched",
        "in_progress",
        "in_progress",
        "searched",
    ]
