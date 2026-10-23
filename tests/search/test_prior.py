"""Prior tests (LANE_C_SEARCH section 7, item 6; section 3.2).

All ring numbers here are synthetic test values, not lost-person statistics.
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from sightline.contract import Grid, LatLon
from sightline.search.grid import make_grid
from sightline.search.prior import RING_EDGE, _annulus_weight, placeholder_prior, ring_prior

DEMO_LKP = LatLon(lat=49.37, lon=-122.945)
SYNTHETIC_RINGS = [(100.0, 0.5), (400.0, 0.9)]


@pytest.fixture
def grid() -> Grid:
    return make_grid(DEMO_LKP)


def _distances_m(grid: Grid) -> np.ndarray:
    """Distance of each cell centre from the grid centre (the LKP for make_grid)."""
    rows, cols = np.divmod(np.arange(grid.rows * grid.cols), grid.cols)
    east_m = (cols + 0.5) * grid.cell_m - grid.cols * grid.cell_m / 2
    south_m = (rows + 0.5) * grid.cell_m - grid.rows * grid.cell_m / 2
    return np.hypot(east_m, south_m)


# --- placeholder ---------------------------------------------------------------------------


def test_placeholder_is_uniform_and_sums_to_one(grid: Grid) -> None:
    p, outside = placeholder_prior(grid)
    assert p.dtype == np.float64
    assert p.shape == (grid.rows * grid.cols,)
    assert outside == 0.5
    assert np.all(p == p[0])
    assert p[0] == pytest.approx(0.5 / 2500)
    assert abs(p.sum() + outside - 1.0) < 1e-12


def test_placeholder_non_square_grid() -> None:
    g = Grid(origin_nw=DEMO_LKP, cell_m=10.0, rows=3, cols=7)
    p, outside = placeholder_prior(g)
    assert p.shape == (21,)
    assert abs(p.sum() + outside - 1.0) < 1e-12


# --- ring prior ----------------------------------------------------------------------------


def test_ring_prior_sums_to_one_with_outside(grid: Grid) -> None:
    p, outside = ring_prior(grid, DEMO_LKP, SYNTHETIC_RINGS)
    assert p.dtype == np.float64
    assert p.shape == (grid.rows * grid.cols,)
    assert 0.0 <= outside <= 1.0
    assert np.all(p >= 0)
    assert abs(p.sum() + outside - 1.0) < 1e-9


def test_ring_prior_mass_decreases_with_distance(grid: Grid) -> None:
    p, _ = ring_prior(grid, DEMO_LKP, SYNTHETIC_RINGS)
    d_m = _distances_m(grid)
    inner = p[d_m <= 100.0]
    outer = p[(d_m > 100.0) & (d_m <= 400.0)]
    beyond = p[d_m > 400.0]
    assert inner.size > 0 and outer.size > 0 and beyond.size > 0
    assert inner.mean() > outer.mean() > beyond.mean()
    # Spread evenly by area (edge = 1), the mass is the same in every cell of a ring.
    even, _ = ring_prior(grid, DEMO_LKP, SYNTHETIC_RINGS, edge=1.0)
    assert np.allclose(even[d_m <= 100.0], even[d_m <= 100.0][0])


def test_ring_inside_grid_keeps_its_mass(grid: Grid) -> None:
    # One disc of radius 200 m holding all the mass, wholly inside the 1 km grid.
    # Counting cells by their centre misjudges the disc area. The worst case is the band of
    # cells cut by the circle: |error| <= 4 * half_diagonal / r = 4 * 14.14 / 200 = 28 %.
    # Measured on this grid for r = 100..450 m it is at most 2.7 % (r = 150 m, 172 cells),
    # and 0.6 % for r = 200 m. Overshoot is clipped to the ring mass, so the in-grid
    # mass lies in [1 - 0.03, 1].
    p, outside = ring_prior(grid, DEMO_LKP, [(200.0, 1.0)])
    assert 1.0 - 0.03 <= p.sum() <= 1.0 + 1e-12
    assert outside == pytest.approx(1.0 - p.sum(), abs=1e-12)


@pytest.mark.parametrize("radius_m", [100.0, 150.0, 250.0, 300.0, 450.0])
def test_disc_discretisation_within_measured_tolerance(grid: Grid, radius_m: float) -> None:
    p, outside = ring_prior(grid, DEMO_LKP, [(radius_m, 1.0)])
    assert 0.97 <= p.sum() <= 1.0 + 1e-12
    assert outside >= 0.0


def test_ring_larger_than_grid_pushes_mass_outside(grid: Grid) -> None:
    # Disc of 2 km radius: the 1 km x 1 km grid holds 1e6 / (pi * 2000^2) of its area.
    p, outside = ring_prior(grid, DEMO_LKP, [(2000.0, 1.0)], edge=1.0)
    expected_in = 1e6 / (math.pi * 2000.0**2)
    assert p.sum() == pytest.approx(expected_in, rel=1e-9)
    assert outside == pytest.approx(1.0 - expected_in, rel=1e-9)
    assert np.allclose(p, p[0])
    # With the falloff the grid (the disc's middle, where the kernel is near 1) holds more of the
    # ring than its share of the area, and the rest is still outside, not dropped.
    p, outside = ring_prior(grid, DEMO_LKP, [(2000.0, 1.0)])
    assert expected_in < p.sum() < 1.0 and p.sum() + outside == pytest.approx(1.0, abs=1e-12)


def test_falloff_within_a_ring(grid: Grid) -> None:
    # Linear from 1 at the inner radius to RING_EDGE at the outer one: on a ray from the LKP the
    # density falls inside each ring, and the outer edge of a ring is RING_EDGE of its inner edge.
    p, _ = ring_prior(grid, DEMO_LKP, [(100.0, 0.5), (400.0, 0.9)])
    d_m = _distances_m(grid)
    ring1 = d_m <= 100.0
    assert np.corrcoef(d_m[ring1], p[ring1])[0, 1] < -0.99
    ring2 = (d_m > 100.0) & (d_m <= 400.0)
    near, far = p[ring2][np.argmin(d_m[ring2])], p[ring2][np.argmax(d_m[ring2])]
    t_near = (d_m[ring2].min() - 100.0) / 300.0
    t_far = (d_m[ring2].max() - 100.0) / 300.0
    expected = (1 - (1 - RING_EDGE) * t_far) / (1 - (1 - RING_EDGE) * t_near)
    assert far / near == pytest.approx(expected, rel=1e-9)


@pytest.mark.parametrize("edge", [0.25, 0.5, 1.0])
def test_annulus_weight_is_the_kernel_integral(edge: float) -> None:
    # The closed form against a fine numeric integral of w(r) 2 pi r over the annulus.
    for a, b in ((0.0, 700.0), (700.0, 1900.0), (3600.0, 11300.0)):
        r = np.linspace(a, b, 200_001)
        w = 1 - (1 - edge) * (r - a) / (b - a)
        numeric = np.trapezoid(w * 2 * np.pi * r, r)
        assert _annulus_weight(a, b, edge) == pytest.approx(numeric, rel=1e-8)


def test_edge_must_be_in_range(grid: Grid) -> None:
    for edge in (0.0, -0.1, 1.5):
        with pytest.raises(ValueError):
            ring_prior(grid, DEMO_LKP, SYNTHETIC_RINGS, edge=edge)


def test_unfound_fraction_goes_outside(grid: Grid) -> None:
    # Ring fully inside the grid with c_last = 0.6: at least 0.4 sits outside.
    p, outside = ring_prior(grid, DEMO_LKP, [(200.0, 0.6)])
    assert outside >= 0.4 - 1e-12
    assert outside == pytest.approx(0.4 + (0.6 - p.sum()), abs=1e-12)
    assert abs(p.sum() + outside - 1.0) < 1e-9


def test_cells_beyond_last_ring_get_zero(grid: Grid) -> None:
    p, _ = ring_prior(grid, DEMO_LKP, SYNTHETIC_RINGS)
    assert np.all(p[_distances_m(grid) > 400.0] == 0.0)


def test_centre_on_boundary_goes_to_inner_ring() -> None:
    # 2 x 2 grid of 20 m cells; LKP at the middle corner; every centre is 14.142 m away.
    g = make_grid(DEMO_LKP, size_m=40.0, cell_m=20.0)
    r_m = math.hypot(10.0, 10.0)
    p, outside = ring_prior(g, DEMO_LKP, [(r_m + 1e-6, 0.5), (100.0, 1.0)])
    assert np.all(p > 0)
    # Inner ring area pi * 200 = 628 m^2 < 4 cells * 400 m^2, so it is clipped to 0.5.
    assert p.sum() == pytest.approx(0.5, abs=1e-9)
    assert outside == pytest.approx(0.5, abs=1e-9)


def test_lkp_off_centre(grid: Grid) -> None:
    # LKP near the north-west corner: most of a 300 m disc falls off the grid.
    lkp = LatLon(lat=grid.origin_nw.lat - 10.0 / 111_320, lon=grid.origin_nw.lon + 1e-5)
    p, outside = ring_prior(grid, lkp, [(300.0, 1.0)])
    assert 0.15 < p.sum() < 0.35  # about a quarter of the disc is inside
    assert abs(p.sum() + outside - 1.0) < 1e-9
    assert np.argmax(p) < grid.cols * 16


def test_inputs_not_mutated(grid: Grid) -> None:
    rings = [(100.0, 0.5), (400.0, 0.9)]
    rings_before = list(rings)
    grid_before = grid.model_copy(deep=True)
    lkp_before = DEMO_LKP.model_copy()
    ring_prior(grid, DEMO_LKP, rings)
    placeholder_prior(grid)
    assert rings == rings_before
    assert grid == grid_before
    assert DEMO_LKP == lkp_before


@pytest.mark.parametrize(
    "rings",
    [
        [],
        [(0.0, 0.5)],
        [(-10.0, 0.5)],
        [(100.0, 0.0)],
        [(100.0, 1.1)],
        [(100.0, -0.1)],
        [(100.0, 0.5), (100.0, 0.9)],
        [(200.0, 0.5), (100.0, 0.9)],
        [(100.0, 0.5), (200.0, 0.5)],
        [(100.0, 0.9), (200.0, 0.5)],
        [(math.inf, 0.5)],
        [(100.0, math.nan)],
        [(100.0, 0.5, 3.0)],
    ],
)
def test_bad_rings_raise(grid: Grid, rings: list) -> None:
    with pytest.raises(ValueError):
        ring_prior(grid, DEMO_LKP, rings)


# --- Koester lost-person rings --------------------------------------------------------------

from sightline.search.prior import (
    CATEGORIES,
    KOESTER_WEIGHT,
    QUARTILES,
    koester_prior,
    prior_mass_outside,
    prior_source,
    subject_category,
)


def _big_grid(cell_m: float = 100.0) -> Grid:
    """A 30 km square: every ring of every category fits (Sava et al. used a 50 km region)."""
    return make_grid(DEMO_LKP, size_m=30_000.0, cell_m=cell_m)


@pytest.mark.parametrize("category", sorted(CATEGORIES))
def test_koester_mass_sums_to_one(grid: Grid, category: str) -> None:
    for g in (grid, _big_grid()):
        p, outside = koester_prior(g, DEMO_LKP, category)
        assert p.sum() + outside == pytest.approx(1.0, abs=1e-12)
        assert (p > 0).all() and 0 <= outside <= 1  # the uniform blend leaves no cell at zero


@pytest.mark.parametrize("category", sorted(CATEGORIES))
def test_koester_ring_shares_match_the_table(category: str) -> None:
    g = _big_grid(25.0)
    p, outside = koester_prior(g, DEMO_LKP, category, weight=1.0)
    d = _distances_m(g)
    radii = CATEGORIES[category].rings_m
    inner = 0.0
    for r_m, share in zip(radii, np.diff((0.0, *QUARTILES)), strict=True):
        in_ring = (d > inner) & (d <= r_m)
        # cells by centre only approximate a disc (the 161 m dementia disc on 25 m cells is the
        # coarsest): within 6 % of the ring's share, never above it
        assert share * 0.94 <= p[in_ring].sum() <= share + 1e-12
        inner = r_m
    assert p[d > radii[-1]].sum() == 0.0 and outside == pytest.approx(0.05, abs=0.015)


def test_hiker_quartiles_are_sava_table_1() -> None:
    c = CATEGORIES["hiker/temperate_mountainous"]
    assert c.rings_m == (700.0, 1900.0, 3600.0, 11300.0) and c.n == 568
    assert CATEGORIES["dementia/temperate_mountainous"].rings_m[1] == pytest.approx(965.6, abs=0.1)


def test_no_category_is_the_uniform_placeholder(grid: Grid) -> None:
    p, outside = koester_prior(grid, DEMO_LKP, None)
    up, uout = placeholder_prior(grid)
    assert np.array_equal(p, up) and outside == uout
    assert prior_source(None) == "placeholder"


def test_blend_weight(grid: Grid) -> None:
    pk, ok = koester_prior(grid, DEMO_LKP, "dementia/temperate_mountainous", weight=1.0)
    pu, ou = placeholder_prior(grid)
    p, outside = koester_prior(grid, DEMO_LKP, "dementia/temperate_mountainous")
    assert np.allclose(p, KOESTER_WEIGHT * pk + (1 - KOESTER_WEIGHT) * pu)
    assert outside == pytest.approx(KOESTER_WEIGHT * ok + (1 - KOESTER_WEIGHT) * ou)
    d = _distances_m(grid)
    assert p[d < 100].mean() > p[d > 400].mean()  # dementia rings are tight: mass near the LKP
    with pytest.raises(ValueError):
        koester_prior(grid, DEMO_LKP, "hunter/temperate_mountainous")


@pytest.mark.parametrize(
    ("subject", "category"),
    [
        ("adult, red jacket, day hiker", "hiker/temperate_mountainous"),
        ("Hiking alone, flat farmland", "hiker/temperate_flat"),
        ("backpacker in the desert", "hiker/dry_mountainous"),
        ("82-year-old with Alzheimer's", "dementia/temperate_mountainous"),
        ("dementia, dry flat", "dementia/temperate_mountainous"),  # no such row: default terrain
        ("hiker/dry_flat", "hiker/dry_flat"),
        ("adult, red jacket", None),
        (None, None),
    ],
)
def test_subject_category(subject: str | None, category: str | None) -> None:
    assert subject_category(subject) == category


@pytest.mark.parametrize("category", [None, *sorted(CATEGORIES)])
def test_prior_mass_outside_adds_up(grid: Grid, category: str | None) -> None:
    # The demo's 1 km grid is smaller than every category's outer rings: what it leaves out is
    # reported, and the parts add up to koester_prior's outside (the cells stay normalised).
    p, outside = koester_prior(grid, DEMO_LKP, category)
    parts = prior_mass_outside(grid, DEMO_LKP, category)
    assert parts["total"] == pytest.approx(outside, abs=1e-12)
    assert parts["beyond_rings"] + parts["off_grid"] + parts["uniform"] == pytest.approx(outside)
    assert p.sum() + parts["total"] == pytest.approx(1.0, abs=1e-12)
    if category is not None:
        assert parts["beyond_rings"] == pytest.approx(KOESTER_WEIGHT * 0.05, abs=1e-9)
        assert parts["off_grid"] > 0.3  # most of every category's rings lie past a 1 km grid


def test_the_demo_grid_shows_the_hiker_rings() -> None:
    # The demo's 1 km grid of 5 m cells lies inside the hiker's first ring (0.7 km). Spread evenly
    # by area it was flat (39,990 of 40,000 cells equal); with the falloff the mass falls with
    # distance from the LKP, so the map shows rings around it.
    g = make_grid(DEMO_LKP, size_m=1000.0, cell_m=5.0)
    p, _ = koester_prior(g, DEMO_LKP, "hiker/temperate_mountainous")
    d = _distances_m(g)
    assert np.unique(np.round(p, 15)).size > 1000
    assert p[d < 50].mean() > 1.4 * p[(d > 450) & (d < 500)].mean()
