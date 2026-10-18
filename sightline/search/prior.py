"""The search prior: where the person could be before any photo (LANE_C_SEARCH section 3.2).

Both functions return (p, outside): p is a float64 array of length rows * cols in the
contract's row-major order, and outside is the mass outside the grid, with
sum(p) + outside == 1.

No ring numbers live in this module. Real rings must come from a cited source (Koester,
Lost Person Behavior, hiker category); until then the pipeline uses placeholder_prior.
"""

from __future__ import annotations

import math
from collections.abc import Sequence

import numpy as np

from sightline.contract import Grid, LatLon
from sightline.search.grid import latlon_to_local_m

PLACEHOLDER_OUTSIDE = 0.5


# Uniform prior used until real, cited ring numbers are in.
def placeholder_prior(grid: Grid) -> tuple[np.ndarray, float]:
    """Uniform over every cell with outside = 0.5, so each cell holds 0.5 / (rows * cols)."""
    n_cells = grid.rows * grid.cols
    p = np.full(n_cells, (1.0 - PLACEHOLDER_OUTSIDE) / n_cells, dtype=np.float64)
    return p, PLACEHOLDER_OUTSIDE


def _check_rings(rings: Sequence[tuple[float, float]]) -> tuple[np.ndarray, np.ndarray]:
    if len(rings) == 0:
        raise ValueError("rings must not be empty")
    radii_m: list[float] = []
    fractions: list[float] = []
    for ring in rings:
        if len(ring) != 2:
            raise ValueError(f"each ring must be (radius_m, fraction), got {ring!r}")
        r_m, c = float(ring[0]), float(ring[1])
        if not (math.isfinite(r_m) and r_m > 0):
            raise ValueError(f"ring radius_m must be finite and > 0, got {r_m}")
        if not (math.isfinite(c) and 0 < c <= 1):
            raise ValueError(f"ring fraction must be in (0, 1], got {c}")
        if radii_m and (r_m <= radii_m[-1] or c <= fractions[-1]):
            raise ValueError(f"rings must strictly increase in radius and fraction: {rings!r}")
        radii_m.append(r_m)
        fractions.append(c)
    return np.array(radii_m, dtype=np.float64), np.array(fractions, dtype=np.float64)


# Prior from lost-person distance rings around the LKP.
def ring_prior(
    grid: Grid, lkp: LatLon, rings: Sequence[tuple[float, float]]
) -> tuple[np.ndarray, float]:
    """Spread ring masses over the cells (LANE_C_SEARCH section 3.2).

    rings: [(radius_m, cumulative fraction found within it)], strictly increasing in both,
    fractions in (0, 1]. Ring k (inner radius r_{k-1}, r_0 = 0) holds mass c_k - c_{k-1}
    (c_0 = 0), spread uniformly over its annulus area pi * (r_k^2 - r_{k-1}^2).

    - A cell belongs to the ring that contains its centre. Distance is measured in the
      grid's local metres (latlon_to_local_m for the LKP; cell centres are
      ((col + 0.5) * cell_m, (row + 0.5) * cell_m) in that same frame). A centre exactly on
      a ring boundary belongs to the inner ring.
    - In-grid cell mass = ring mass * cell_m^2 / annulus area.
    - Counting cells by their centre can give a ring slightly more cell area than its
      annulus area (a disc of 100 m on 20 m cells gets about 1.9 % too much). Then the
      ring's cells are scaled down so they hold exactly the ring mass, and outside never
      goes negative.
    - Ring mass not given to in-grid cells, plus 1 - c_last, goes to outside.
    - Cells beyond the last ring get exactly 0: that mass sits in outside. This differs
      from "never let a probability reach exactly 0" (section 11); the lane owner decides
      whether to keep it. A zero cell stays zero under the update.
    """
    radii_m, fractions = _check_rings(rings)
    lkp_east_m, lkp_south_m = latlon_to_local_m(grid, lkp)

    rows, cols = np.divmod(np.arange(grid.rows * grid.cols), grid.cols)
    east_m = (cols + 0.5) * grid.cell_m - lkp_east_m
    south_m = (rows + 0.5) * grid.cell_m - lkp_south_m
    dist_m = np.hypot(east_m, south_m)

    # side="left": the first ring with radius >= distance, so boundary centres go inward.
    ring_of_cell = np.searchsorted(radii_m, dist_m, side="left")

    inner_m = np.concatenate(([0.0], radii_m[:-1]))
    ring_mass = np.diff(np.concatenate(([0.0], fractions)))
    annulus_area_m2 = math.pi * (radii_m**2 - inner_m**2)
    cell_area_m2 = grid.cell_m**2

    p = np.zeros(grid.rows * grid.cols, dtype=np.float64)
    for k in range(len(radii_m)):
        in_ring = ring_of_cell == k
        n_in = int(np.count_nonzero(in_ring))
        if n_in == 0:
            continue
        per_cell = ring_mass[k] * cell_area_m2 / annulus_area_m2[k]
        if per_cell * n_in > ring_mass[k]:
            per_cell = ring_mass[k] / n_in
        p[in_ring] = per_cell

    outside = max(0.0, 1.0 - float(p.sum()))
    return p, outside
