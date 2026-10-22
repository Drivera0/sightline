"""The search prior: where the person could be before any photo (LANE_C_SEARCH section 3.2).

Every function returns (p, outside): p is a float64 array of length rows * cols in the
contract's row-major order, and outside is the mass outside the grid, with
sum(p) + outside == 1.

**Lost-person rings (Koester, Lost Person Behavior / ISRID).** ``koester_prior`` puts 25 % of
the mass inside the category's 25 % distance from the last known point (the IPP), 25 % between
the 25 % and 50 % rings, 25 % to the 75 % ring, 20 % to the 95 % ring, each spread uniformly over
its ring's area (``ring_prior``), and the last 5 % outside, as the distance-ring model of
Sava, Twardy, Koester & Sonwalkar 2015 (§3.1) does. That model scored 0.78 (95 % CI 0.74-0.82)
on their Rossmo-style map score over 376 ISRID cases with known IPP and find points. The
quartile distances, exactly as printed:

| category | 25 % | 50 % | 75 % | 95 % | n | source |
|---|---|---|---|---|---|---|
| hiker, temperate mountainous (default) | 0.7 | 1.9 | 3.6 | 11.3 km | 568 | Sava et al. 2015, Table 1 |
| hiker, temperate flat | 0.4 | 1.1 | 2.0 | 6.1 km | 274 | Sava et al. 2015, Table 1 |
| hiker, dry mountainous | 1.0 | 2.0 | 4.0 | 11.9 km | 221 | Sava et al. 2015, Table 1 |
| hiker, dry flat | 0.8 | 1.3 | 4.1 | 8.1 km | 58 | Sava et al. 2015, Table 1 |
| dementia, temperate mountainous | 0.1 | 0.6 | 1.6 | 7.0 mi | 1207 | Koester, ICAR 2025 deck p. 15 (ISRID 2.0) |
| dementia, temperate flat | 0.2 | 0.6 | 1.5 | 5.8 mi | 320 | Koester, ICAR 2025 deck p. 15 (ISRID 2.0) |

Table 1 does not print its unit; the paper's text reads it in km ("the temperate flat category
has a 75 % of 2 km", §5), so km it is. The ICAR slide says miles. Hiker urban (no quartiles
printed) and every other category are left out: nothing else could be checked against a source.

The rings are blended with the uniform prior (``KOESTER_WEIGHT`` of the mass from the rings, the
rest from ``placeholder_prior``): a hedge against a wrong category or IPP, chosen by hand, not
tuned (there are no cases to tune it on). Without a category the prior stays uniform.
"""

from __future__ import annotations

import math
import re
from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

from sightline.contract import Grid, LatLon
from sightline.search.grid import latlon_to_local_m

PLACEHOLDER_OUTSIDE = 0.5
KM = 1000.0
MILE = 1609.344
QUARTILES = (0.25, 0.50, 0.75, 0.95)
KOESTER_WEIGHT = 0.8  # share of the prior from the rings; the rest uniform (a hedge, not tuned)
SAVA_2015 = "Sava, Twardy, Koester & Sonwalkar 2015, Transactions in GIS, Table 1"
ICAR_2025 = "Koester, LPB Updates, ICAR 2025, p. 15 (ISRID 2.0)"


@dataclass(frozen=True)
class Category:
    """One lost-person category: the 25/50/75/95 % crow's-flight distances from the IPP."""

    name: str
    rings_m: tuple[float, float, float, float]
    n: int
    source: str


def _cat(name: str, d: tuple[float, ...], unit: float, n: int, source: str) -> Category:
    return Category(name, tuple(x * unit for x in d), n, source)  # type: ignore[arg-type]


CATEGORIES: dict[str, Category] = {
    c.name: c
    for c in (
        _cat("hiker/temperate_mountainous", (0.7, 1.9, 3.6, 11.3), KM, 568, SAVA_2015),
        _cat("hiker/temperate_flat", (0.4, 1.1, 2.0, 6.1), KM, 274, SAVA_2015),
        _cat("hiker/dry_mountainous", (1.0, 2.0, 4.0, 11.9), KM, 221, SAVA_2015),
        _cat("hiker/dry_flat", (0.8, 1.3, 4.1, 8.1), KM, 58, SAVA_2015),
        _cat("dementia/temperate_mountainous", (0.1, 0.6, 1.6, 7.0), MILE, 1207, ICAR_2025),
        _cat("dementia/temperate_flat", (0.2, 0.6, 1.5, 5.8), MILE, 320, ICAR_2025),
    )
}
DEFAULT_TERRAIN = "temperate_mountainous"
_SUBJECTS = (("dementia", r"dementia|alzheimer"), ("hiker", r"hik(e|er|ers|ing)|backpack(er|ing)"))


# Uniform prior: the fallback when the subject has no category, and the hedge koester_prior blends in.
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


def subject_category(subject: str | None) -> str | None:
    """The category for the mission's free-text ``subject`` (contract §12.2), or None (uniform).

    The contract has no category field (adding one needs a contract change, §10), so it is read
    from the words: "dementia"/"Alzheimer's" or "hiker"/"hiking"/"backpacker"; "flat" and "dry"
    or "desert" choose the terrain, temperate mountainous otherwise (and when that category has
    no row for the terrain). A category name itself ("hiker/temperate_flat") is taken as is."""
    if not subject:
        return None
    text = subject.lower()
    for name in CATEGORIES:
        if name in text:
            return name
    kind = next((k for k, pattern in _SUBJECTS if re.search(rf"\b({pattern})\b", text)), None)
    if kind is None:
        return None
    climate = "dry" if re.search(r"\b(dry|desert)\b", text) else "temperate"
    relief = "flat" if re.search(r"\bflat\b", text) else "mountainous"
    name = f"{kind}/{climate}_{relief}"
    return name if name in CATEGORIES else f"{kind}/{DEFAULT_TERRAIN}"


def koester_prior(
    grid: Grid, lkp: LatLon, category: str | None, weight: float = KOESTER_WEIGHT
) -> tuple[np.ndarray, float]:
    """``weight`` × the category's distance rings around the LKP + (1 − ``weight``) × the uniform
    placeholder; the placeholder alone when ``category`` is None. Ring k holds the quartile share
    (25, 25, 25, 20 %) spread over its area; the 5 % beyond the 95 % ring is outside the grid."""
    uniform_p, uniform_out = placeholder_prior(grid)
    if category is None:
        return uniform_p, uniform_out
    if category not in CATEGORIES:
        raise ValueError(f"unknown lost-person category {category!r}: {sorted(CATEGORIES)}")
    if not 0.0 <= weight <= 1.0:
        raise ValueError(f"weight must be in [0, 1], got {weight}")
    rings = list(zip(CATEGORIES[category].rings_m, QUARTILES, strict=True))
    ring_p, ring_out = ring_prior(grid, lkp, rings)
    p = weight * ring_p + (1 - weight) * uniform_p
    return p, weight * ring_out + (1 - weight) * uniform_out


def prior_source(category: str | None, weight: float = KOESTER_WEIGHT) -> str:
    """``params.prior_source`` (contract 1.1) for the prior ``koester_prior`` gave."""
    if category is None:
        return "placeholder"
    c = CATEGORIES[category]
    return f"Koester lost-person rings, {c.name} (n={c.n}; {c.source}), weight {weight:g} + uniform"
