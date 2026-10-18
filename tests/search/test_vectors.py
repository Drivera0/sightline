"""Test-vector generator for the TypeScript mirror (LANE_C_SEARCH section 6.5)."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from sightline.contract import Grid, LatLon
from sightline.search.grid import cells_within_radius
from sightline.search.update import apply_review_not_person, replay
from sightline.search.vectors import write_test_vectors


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_generator_is_deterministic(tmp_path: Path) -> None:
    a, b = tmp_path / "a.json", tmp_path / "b.json"
    write_test_vectors(a)
    write_test_vectors(b)
    assert a.read_bytes() == b.read_bytes()


def test_vectors_cover_the_required_cases(tmp_path: Path) -> None:
    out = tmp_path / "sub" / "v.json"
    write_test_vectors(out)
    v = _load(out)
    names = [c["name"] for c in v["step_cases"]]
    assert "three-cell example" in names
    assert sum(len(c["prior"]["p"]) == 25 for c in v["step_cases"]) >= 3
    assert len(v["review_cases"]) >= 2
    assert any(c["expected"] == [] for c in v["radius_cases"])
    three = v["step_cases"][names.index("three-cell example")]
    np.testing.assert_allclose(three["after"][0]["p"], [0.1852, 0.4444, 0.3704], atol=1e-4)


def test_expected_values_match_python_functions(tmp_path: Path) -> None:
    out = tmp_path / "v.json"
    write_test_vectors(out)
    v = _load(out)

    for case in v["step_cases"]:
        prior = np.array(case["prior"]["p"])
        steps = [[(int(i), float(q)) for i, q in s["cells"]] for s in case["steps"]]
        for k, expected in enumerate(case["after"], start=1):
            p, outside = replay(prior, case["prior"]["outside"], steps[:k])
            assert p.tolist() == expected["p"], case["name"]
            assert outside == expected["outside"], case["name"]
            assert abs(p.sum() + outside - 1.0) < 1e-9

    for case in v["radius_cases"]:
        grid = Grid.model_validate(case["grid"])
        at = LatLon(lat=case["lat"], lon=case["lon"])
        assert cells_within_radius(grid, at, case["radius_m"]) == case["expected"], case["name"]

    for case in v["review_cases"]:
        grid = Grid.model_validate(case["grid"])
        p, outside = apply_review_not_person(
            np.array(case["state"]["p"]),
            case["state"]["outside"],
            grid,
            LatLon(lat=case["lat"], lon=case["lon"]),
            case["radius_m"],
            case["review_pod"],
            case["pod_cap"],
        )
        assert p.tolist() == case["expected"]["p"], case["name"]
        assert outside == case["expected"]["outside"], case["name"]
