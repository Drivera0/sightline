"""Bayesian update tests (LANE_C_SEARCH sections 3.4, 3.5 and 7, items 1-4)."""

from __future__ import annotations

import numpy as np
import pytest

from sightline.contract import LatLon
from sightline.search.grid import cell_center, cells_within_radius, make_grid
from sightline.search.update import apply_review_not_person, apply_step, replay

DEMO_LKP = LatLon(lat=49.37, lon=-122.945)


def test_three_cell_example() -> None:
    p, outside = apply_step(np.array([0.5, 0.3, 0.2]), 0.0, [(0, 0.8), (1, 0.2)])
    np.testing.assert_allclose(p, [0.1852, 0.4444, 0.3704], atol=1e-4)
    assert outside == 0.0
    assert p.dtype == np.float64


def test_conservation_after_random_steps_and_review() -> None:
    rng = np.random.default_rng(7)
    grid = make_grid(DEMO_LKP)
    n = grid.rows * grid.cols
    raw = rng.random(n)
    p = 0.6 * raw / raw.sum()
    outside = 0.4
    for _ in range(20):
        idx = rng.choice(n, size=40, replace=False)
        pods = rng.uniform(0.0, 0.95, size=40)
        p, outside = apply_step(p, outside, list(zip(idx.tolist(), pods.tolist(), strict=True)))
        assert p.sum() + outside == pytest.approx(1.0, abs=1e-9)
    p, outside = apply_review_not_person(p, outside, grid, DEMO_LKP, 10.0)
    assert p.sum() + outside == pytest.approx(1.0, abs=1e-9)


def test_pod_at_cap_leaves_no_zero() -> None:
    p, _ = apply_step(np.array([0.9, 0.1]), 0.0, [(0, 0.95)])
    assert np.all(p > 0)
    # Repeated looks at the cap still never reach zero.
    for _ in range(50):
        p, _ = apply_step(p, 0.0, [(0, 0.95)])
    assert p[0] > 0


def test_untouched_cells_and_outside_rise_by_one_over_d() -> None:
    p0 = np.array([0.2, 0.3, 0.1, 0.15])
    outside0 = 0.25
    cells = [(0, 0.5), (2, 0.7)]
    d = 1.0 - (0.2 * 0.5 + 0.1 * 0.7)
    p, outside = apply_step(p0, outside0, cells)
    assert p[1] == pytest.approx(p0[1] / d, rel=1e-12)
    assert p[3] == pytest.approx(p0[3] / d, rel=1e-12)
    assert outside == pytest.approx(outside0 / d, rel=1e-12)
    assert p[0] == pytest.approx(0.2 * 0.5 / d, rel=1e-12)


def test_inputs_not_mutated_and_empty_step_is_copy() -> None:
    p0 = np.array([0.5, 0.3, 0.2])
    snapshot = p0.copy()
    cells = [(0, 0.8)]
    apply_step(p0, 0.0, cells)
    np.testing.assert_array_equal(p0, snapshot)
    assert cells == [(0, 0.8)]

    p, outside = apply_step(p0, 0.0, [])
    np.testing.assert_array_equal(p, p0)
    assert p is not p0
    assert outside == 0.0


def test_review_does_not_mutate_input() -> None:
    grid = make_grid(DEMO_LKP)
    p0 = np.full(grid.rows * grid.cols, 0.5 / 2500)
    snapshot = p0.copy()
    apply_review_not_person(p0, 0.5, grid, DEMO_LKP, 10.0)
    np.testing.assert_array_equal(p0, snapshot)


@pytest.mark.parametrize("pod", [-0.1, 1.1])
def test_pod_out_of_range_raises(pod: float) -> None:
    with pytest.raises(ValueError):
        apply_step(np.array([0.5, 0.5]), 0.0, [(0, pod)])


def test_non_positive_denominator_raises() -> None:
    # All the mass is in one cell and the look is certain: D = 0.
    with pytest.raises(ValueError):
        apply_step(np.array([1.0, 0.0]), 0.0, [(0, 1.0)])


def test_review_applies_capped_pod_to_cells_in_radius() -> None:
    grid = make_grid(DEMO_LKP)
    n = grid.rows * grid.cols
    p0 = np.full(n, 0.5 / n)
    at = cell_center(grid, 1275)
    cells = cells_within_radius(grid, at, 12.0)

    # review_pod above the cap is clipped to the cap.
    p, outside = apply_review_not_person(p0, 0.5, grid, at, 12.0, review_pod=0.99, pod_cap=0.95)
    expected_p, expected_out = apply_step(p0, 0.5, [(i, 0.95) for i in cells])
    np.testing.assert_allclose(p, expected_p, rtol=0, atol=0)
    assert outside == expected_out


def test_replay_matches_sequential_steps() -> None:
    p0 = np.array([0.4, 0.3, 0.2])
    steps = [[(0, 0.5)], [(1, 0.3), (2, 0.1)], []]
    p, outside = replay(p0, 0.1, steps)
    q, q_out = p0, 0.1
    for s in steps:
        q, q_out = apply_step(q, q_out, s)
    np.testing.assert_array_equal(p, q)
    assert outside == q_out


def test_a_reweight_factor_outside_0_20_is_refused() -> None:
    """Contract §12.3 invariant 2, as TS applyReweight (live.test.ts)."""
    from sightline.search.update import MAX_FACTOR, apply_reweight

    p = np.array([0.5, 0.5])
    for bad in (0.0, -1.0, MAX_FACTOR + 0.001):
        with pytest.raises(ValueError):
            apply_reweight(p, 0.0, [(0, bad)])
    q, out = apply_reweight(p, 0.0, [(0, MAX_FACTOR)])
    assert q.sum() + out == pytest.approx(1.0, abs=1e-12)
