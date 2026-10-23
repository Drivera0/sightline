"""The search prior: where the person could be before any photo (LANE_C_SEARCH section 3.2).

Every function returns (p, outside): p is a float64 array of length rows * cols in the
contract's row-major order, and outside is the mass outside the grid, with
sum(p) + outside == 1.

**Lost-person rings (Koester, Lost Person Behavior / ISRID).** ``koester_prior`` puts 25 % of
the mass inside the category's 25 % distance from the last known point (the IPP), 25 % between
the 25 % and 50 % rings, 25 % to the 75 % ring, 20 % to the 95 % ring, and the last 5 % outside,
as the distance-ring model of Sava, Twardy, Koester & Sonwalkar 2015 (§3.1) does. That model
scored 0.78 (95 % CI 0.74-0.82) on their Rossmo-style map score over 376 ISRID cases with known
IPP and find points. The quartile distances, exactly as printed:

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

**Within a ring** the share is spread by distance, not evenly by area (``ring_prior``): the
density falls linearly from the ring's inner radius to its outer, where it is ``RING_EDGE`` (a
quarter) of the inner value, and each ring keeps its share. Spread evenly, the demo's 1 km grid,
which lies inside the hiker's first ring (0.7 km), came out flat (39,990 of 40,000 cells equal);
with the falloff it shows the rings around the LKP. The kernel and its edge value are chosen by
hand (the source gives only the quartile distances), not tuned. A ring's part past the grid's
edge is not dropped: it is in ``outside``, and ``prior_mass_outside`` reports how much.

The rings are blended with the uniform prior (``KOESTER_WEIGHT`` of the mass from the rings, the
rest from ``placeholder_prior``): a hedge against a wrong category or IPP, chosen by hand, not
tuned (there are no cases to tune it on). Without a category the prior stays uniform.

**Terrain affinity (optional, off by default).** The rings say how far; they do not say where on
the ground. ``koester_prior(..., affinity=...)`` multiplies the blended prior by a per-cell terrain
multiplier (``sightline.geo.terrain_affinity``: near trails and streams up, in lakes and on cliffs
down, roads mildly down; Jacobs 2015's ISRID find-location PDENs, milder by hand) and rescales the
cells so they hold the same in-grid mass as before. ``outside`` and ``prior_mass_outside`` do not
change: the affinity moves mass between cells, never across the grid's edge. It applies to the
uniform placeholder too (``category`` None), so even the placeholder follows the terrain.
"""

from __future__ import annotations

import math
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np

from sightline.contract import Grid, LatLon
from sightline.search.grid import latlon_to_local_m

PLACEHOLDER_OUTSIDE = 0.5
KM = 1000.0
MILE = 1609.344
QUARTILES = (0.25, 0.50, 0.75, 0.95)
KOESTER_WEIGHT = 0.8  # share of the prior from the rings; the rest uniform (a hedge, not tuned)
RING_EDGE = 0.25  # a ring's density at its outer radius over its inner radius's (by hand)
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


def _annulus_weight(inner_m: float, outer_m: float, edge: float) -> float:
    """The falloff kernel's integral over the annulus, in m²: ∫ w(r) 2πr dr from ``inner_m`` to
    ``outer_m``, with w falling linearly from 1 at ``inner_m`` to ``edge`` at ``outer_m``."""
    a, b = inner_m, outer_m
    slope = (1.0 - edge) / (b - a)
    return math.pi * (b**2 - a**2) - 2.0 * math.pi * slope * (b**3 / 3 - a * b**2 / 2 + a**3 / 6)


def _ring_cells(
    grid: Grid, lkp: LatLon, rings: Sequence[tuple[float, float]], edge: float
) -> tuple[np.ndarray, float, float]:
    """``ring_prior``'s cells and outside, plus the ring mass that lies past the grid's edge."""
    if not 0.0 < edge <= 1.0:
        raise ValueError(f"edge must be in (0, 1], got {edge}")
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
    cell_area_m2 = grid.cell_m**2

    p = np.zeros(grid.rows * grid.cols, dtype=np.float64)
    off_grid = 0.0
    for k in range(len(radii_m)):
        in_ring = ring_of_cell == k
        if not np.any(in_ring):
            off_grid += float(ring_mass[k])
            continue
        t = (dist_m[in_ring] - inner_m[k]) / (radii_m[k] - inner_m[k])
        w = 1.0 - (1.0 - edge) * np.clip(t, 0.0, 1.0)
        cells = ring_mass[k] * w * cell_area_m2 / _annulus_weight(inner_m[k], radii_m[k], edge)
        if cells.sum() > ring_mass[k]:  # centres over-count a small disc: keep the ring's mass
            cells *= ring_mass[k] / cells.sum()
        p[in_ring] = cells
        off_grid += max(0.0, float(ring_mass[k] - cells.sum()))

    outside = max(0.0, 1.0 - float(p.sum()))
    return p, outside, off_grid


# Prior from lost-person distance rings around the LKP.
def ring_prior(
    grid: Grid, lkp: LatLon, rings: Sequence[tuple[float, float]], edge: float = RING_EDGE
) -> tuple[np.ndarray, float]:
    """Spread ring masses over the cells (LANE_C_SEARCH section 3.2).

    rings: [(radius_m, cumulative fraction found within it)], strictly increasing in both,
    fractions in (0, 1]. Ring k (inner radius r_{k-1}, r_0 = 0) holds mass c_k - c_{k-1}
    (c_0 = 0), spread over its annulus by distance: the density falls linearly from the inner
    radius to the outer, where it is ``edge`` (``RING_EDGE``, a quarter) of the inner radius's.
    The ring's mass is unchanged: it is divided by the kernel's integral over the whole annulus
    (``_annulus_weight``), so a ring that runs past the grid keeps its in-grid density and the
    part beyond the grid goes to ``outside``. ``edge`` = 1 is the old even spread by area.

    - A cell belongs to the ring that contains its centre. Distance is measured in the
      grid's local metres (latlon_to_local_m for the LKP; cell centres are
      ((col + 0.5) * cell_m, (row + 0.5) * cell_m) in that same frame). A centre exactly on
      a ring boundary belongs to the inner ring (its kernel weight there is ``edge``).
    - In-grid cell mass = ring mass * w(distance) * cell_m^2 / (integral of w over the annulus).
    - Counting cells by their centre can give a ring slightly more than its mass (a disc of
      100 m on 20 m cells gets about 1.9 % too much). Then the ring's cells are scaled down
      so they hold exactly the ring mass, and outside never goes negative.
    - Ring mass not given to in-grid cells (the annulus past the grid's edge), plus
      1 - c_last, goes to outside: none is dropped, so sum(p) + outside = 1.
      ``prior_mass_outside`` splits it.
    - Cells beyond the last ring get exactly 0: that mass sits in outside. This differs
      from "never let a probability reach exactly 0" (section 11); the lane owner decides
      whether to keep it. A zero cell stays zero under the update.
    """
    p, outside, _ = _ring_cells(grid, lkp, rings, edge)
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


def _multiplier(grid: Grid, affinity: Any) -> np.ndarray:
    m = np.asarray(getattr(affinity, "multiplier", affinity), dtype=np.float64).ravel()
    if m.size != grid.rows * grid.cols:
        raise ValueError(f"affinity has {m.size} cells, the grid {grid.rows * grid.cols}")
    if not np.all(np.isfinite(m)) or np.any(m < 0):
        raise ValueError("affinity must be finite and non-negative")
    return m


def apply_affinity(grid: Grid, p: np.ndarray, affinity: Any) -> np.ndarray:
    """``p`` × the per-cell ``affinity`` (an array or a ``TerrainAffinity``), rescaled so the cells
    hold the same total as ``p``: the outside mass is untouched. All-zero product: ``p`` as is."""
    q = p * _multiplier(grid, affinity)
    total = float(q.sum())
    return q * (float(p.sum()) / total) if total > 0 else p.copy()


def koester_prior(
    grid: Grid,
    lkp: LatLon,
    category: str | None,
    weight: float = KOESTER_WEIGHT,
    affinity: Any = None,
) -> tuple[np.ndarray, float]:
    """``weight`` × the category's distance rings around the LKP + (1 − ``weight``) × the uniform
    placeholder; the placeholder alone when ``category`` is None. Ring k holds the quartile share
    (25, 25, 25, 20 %), falling off with distance across the ring (``ring_prior``); the 5 % beyond
    the 95 % ring, and any ring's part past the grid's edge, is outside the grid
    (``prior_mass_outside`` says how much of each). With ``affinity`` (a per-cell multiplier,
    ``sightline.geo.terrain_affinity``), the cells are multiplied by it and rescaled to the same
    in-grid total (``apply_affinity``), the placeholder included; ``outside`` is unchanged."""
    uniform_p, uniform_out = placeholder_prior(grid)
    if category is None:
        if affinity is not None:
            uniform_p = apply_affinity(grid, uniform_p, affinity)
        return uniform_p, uniform_out
    if category not in CATEGORIES:
        raise ValueError(f"unknown lost-person category {category!r}: {sorted(CATEGORIES)}")
    if not 0.0 <= weight <= 1.0:
        raise ValueError(f"weight must be in [0, 1], got {weight}")
    rings = list(zip(CATEGORIES[category].rings_m, QUARTILES, strict=True))
    ring_p, ring_out = ring_prior(grid, lkp, rings)
    p = weight * ring_p + (1 - weight) * uniform_p
    if affinity is not None:
        p = apply_affinity(grid, p, affinity)
    return p, weight * ring_out + (1 - weight) * uniform_out


def prior_mass_outside(
    grid: Grid, lkp: LatLon, category: str | None, weight: float = KOESTER_WEIGHT
) -> dict[str, float]:
    """Where ``koester_prior``'s ``outside`` comes from, so a grid smaller than the outer rings says
    how much it leaves out: ``beyond_rings`` (the rings' last 5 %), ``off_grid`` (ring mass whose
    annulus lies past the grid's edge), ``uniform`` (the placeholder's half outside, at its blend
    weight) and ``total`` (= ``koester_prior``'s ``outside``)."""
    if category is None:
        return {"beyond_rings": 0.0, "off_grid": 0.0, "uniform": PLACEHOLDER_OUTSIDE,
                "total": PLACEHOLDER_OUTSIDE}  # fmt: skip
    rings = list(zip(CATEGORIES[category].rings_m, QUARTILES, strict=True))
    _, ring_out, off_grid = _ring_cells(grid, lkp, rings, RING_EDGE)
    return {
        "beyond_rings": weight * (ring_out - off_grid),
        "off_grid": weight * off_grid,
        "uniform": (1 - weight) * PLACEHOLDER_OUTSIDE,
        "total": weight * ring_out + (1 - weight) * PLACEHOLDER_OUTSIDE,
    }


def prior_source(
    category: str | None, weight: float = KOESTER_WEIGHT, affinity: bool = False
) -> str:
    """``params.prior_source`` (contract 1.1) for the prior ``koester_prior`` gave."""
    terrain = " × terrain affinity (Jacobs 2015 ISRID find locations)" if affinity else ""
    if category is None:
        return "placeholder" + terrain
    c = CATEGORIES[category]
    return (
        f"Koester lost-person rings, {c.name} (n={c.n}; {c.source}), weight {weight:g} + uniform"
        + terrain
    )
