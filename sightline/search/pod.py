"""Per-frame overlap, canopy and probability of detection (LANE_C_SEARCH section 3.3).

For one photo, every grid cell under its footprint gets:

- ``overlap`` a = area(cell ∩ footprint) / cell area, in the grid's local metres;
- ``canopy`` c = mean of the canopy classifier over the frame pixels inside that cell;
- ``pod`` = min(pod_cap, recall × (1 − c) × a), or 0 when the cell is held for review.

Held for review ("fix A", a deliberate change from section 3.3 step 5): a cell within
``radius_m`` of any position in ``held`` gets pod 0. The caller passes every candidate
detection of the whole survey, because the simulated frames that overlap are unrelated
photos, and one must not say "nobody here" where another detected someone. With
``held=None`` only the frame's own candidates are used, as the doc first said.

The recall a photo's look is worth (``frame_recall``) comes from the measured POD curve,
``pod_curve.json`` next to this file: detector recall at the frozen threshold 0.29 against the
person's size in the photo (shorter side of the box, px), measured on val by
``scripts/analysis/stress_test.py`` (source: docs/evidence/pod/20261022-104502/pod.json, also its
``source`` key; method and table in docs/report/POD.md). The size is
``PERSON_WIDTH_M`` / the GSD of the pixels the detector saw (``FrameInput.detector_gsd_m``).
Without that GSD, or without the curve file, the caller's constant recall is used.
"""

from __future__ import annotations

import itertools
import json
import math
from collections.abc import Sequence
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from shapely.geometry import Polygon, box

from sightline.contract import Grid, LatLon, Pose
from sightline.geo.project import footprint, latlon_to_pixel
from sightline.search.canopy import canopy_features, mask_from_features
from sightline.search.grid import cell_polygon, cells_within_radius, latlon_to_local_m

MIN_STEP_POD = 0.001
POD_CURVE_PATH = Path(__file__).with_name("pod_curve.json")
PERSON_WIDTH_M = 0.5  # assumed width of a person seen from above (shoulders), metres
# Overlaps below this are float noise on a shared edge, not real coverage.
MIN_OVERLAP = 1e-9
# Sub-pixel bits for cv2.fillPoly (vertices are rounded to 1/16 pixel).
_FILL_SHIFT = 4


@dataclass(frozen=True)
class FrameInput:
    """One survey photo as lane C needs it. Lane D builds it by keyword."""

    frame_id: str
    pose: Pose
    width_px: int
    height_px: int
    image: Path
    candidates: list[tuple[LatLon, float]]  # (position, radius_m) of detections ≥ threshold
    # Metres per pixel of the image the detector ran on (the original photo, not the display
    # frame that ``pose`` describes). None: unknown, and the constant recall is used.
    detector_gsd_m: float | None = None


@dataclass(frozen=True)
class PodCurve:
    """Measured recall against person size: (px, recall) points, px increasing, recall
    non-decreasing. Linear between points, held at the end values outside them."""

    points: tuple[tuple[float, float], ...]
    source: str = ""

    def __post_init__(self) -> None:
        if not self.points:
            raise ValueError("a POD curve needs at least one point")
        px = [p for p, _ in self.points]
        rec = [r for _, r in self.points]
        if any(b <= a for a, b in itertools.pairwise(px)):
            raise ValueError("POD curve px must increase")
        if any(b < a for a, b in itertools.pairwise(rec)):
            raise ValueError("POD curve recall must not decrease with size")
        if not all(0.0 <= r <= 1.0 for r in rec):
            raise ValueError("POD curve recall must be in [0, 1]")

    def recall_at(self, px: float) -> float:
        xs, ys = zip(*self.points, strict=True)
        return float(np.interp(px, xs, ys))


@lru_cache(maxsize=4)
def load_pod_curve(path: Path = POD_CURVE_PATH) -> PodCurve | None:
    """The curve in ``path`` (written by scripts/analysis/stress_test.py --write-curve), or None
    when the file is missing or unreadable."""
    try:
        doc = json.loads(Path(path).read_text(encoding="utf-8"))
        return PodCurve(
            tuple((float(p), float(r)) for p, r in doc["points"]), str(doc.get("source", ""))
        )
    except (OSError, ValueError, KeyError, TypeError):
        return None


def person_px(gsd_m: float, width_m: float = PERSON_WIDTH_M) -> float:
    """How many pixels a person ``width_m`` wide spans at ``gsd_m`` metres per pixel."""
    if gsd_m <= 0:
        raise ValueError("gsd_m must be positive")
    return width_m / gsd_m


def frame_recall(f: FrameInput, fallback: float, curve: PodCurve | None | bool = True) -> float:
    """Detector recall for this photo: the POD curve at the person's size in the detector's
    pixels, else ``fallback`` (the constant). ``curve=True`` loads ``pod_curve.json``;
    ``None``/``False`` always gives ``fallback``."""
    if curve is True:
        curve = load_pod_curve()
    if not curve or f.detector_gsd_m is None:
        return fallback
    return curve.recall_at(person_px(f.detector_gsd_m))


# Overlap, canopy and POD for every grid cell one frame covers.
def frame_step(
    grid: Grid,
    f: FrameInput,
    recall: float,
    pod_cap: float = 0.95,
    held: Sequence[tuple[LatLon, float]] | None = None,
    rgb: np.ndarray | None = None,
    **canopy_thr: float,
) -> tuple[list[tuple[int, float]], dict[int, tuple[float, float]]]:
    """Returns ([(idx, pod)] with pod ≥ 0.001, {idx: (canopy, overlap)}) for one frame.

    Both are sorted by cell index. The dict has every cell with overlap > 0, held or not.
    ``rgb`` (uint8 H×W×3) replaces reading ``f.image``. ``canopy_thr`` passes
    ``exg_thr``, ``std_thr`` and ``shadow_thr`` to the canopy classifier.
    """
    overlaps = frame_overlaps(grid, f.pose, f.width_px, f.height_px)
    if not overlaps:
        return [], {}

    if rgb is None:
        rgb = load_rgb(f.image)
    if rgb.shape[:2] != (f.height_px, f.width_px):
        raise ValueError(
            f"{f.frame_id}: image shape {rgb.shape[:2]} does not match "
            f"height_px×width_px ({f.height_px}, {f.width_px})"
        )
    canopy_px = mask_from_features(canopy_features(rgb), **canopy_thr)

    held_cells = _held_cells(grid, f.candidates if held is None else held)

    steps: list[tuple[int, float]] = []
    cells: dict[int, tuple[float, float]] = {}
    for idx, overlap in overlaps.items():
        canopy = cell_canopy(grid, idx, f.pose, canopy_px)
        cells[idx] = (canopy, overlap)
        if idx in held_cells:
            continue
        pod = min(pod_cap, recall * (1.0 - canopy) * overlap)
        if pod >= MIN_STEP_POD:
            steps.append((idx, pod))
    return steps, cells


# Fraction of each grid cell the frame footprint covers.
def frame_overlaps(grid: Grid, pose: Pose, width_px: int, height_px: int) -> dict[int, float]:
    """{idx: area(cell ∩ footprint) / cell area} for cells with overlap > MIN_OVERLAP, sorted.

    Only the cells in the footprint's bounding window are tested.
    """
    corners_m = [
        latlon_to_local_m(grid, LatLon(lat=lat, lon=lon))
        for lon, lat in footprint(pose, width_px, height_px)
    ]
    shape = Polygon(corners_m)
    c = grid.cell_m
    east_lo, south_lo, east_hi, south_hi = shape.bounds
    row_lo = max(0, math.floor(south_lo / c))
    row_hi = min(grid.rows - 1, math.floor(south_hi / c))
    col_lo = max(0, math.floor(east_lo / c))
    col_hi = min(grid.cols - 1, math.floor(east_hi / c))

    cell_area_m2 = c * c
    out: dict[int, float] = {}
    for row in range(row_lo, row_hi + 1):
        for col in range(col_lo, col_hi + 1):
            square = box(col * c, row * c, (col + 1) * c, (row + 1) * c)
            overlap = shape.intersection(square).area / cell_area_m2
            if overlap > MIN_OVERLAP:
                out[row * grid.cols + col] = float(overlap)
    return out


# Mean canopy over the frame pixels that fall inside one cell.
def cell_canopy(grid: Grid, idx: int, pose: Pose, canopy_px: np.ndarray) -> float:
    """Mean of the bool H×W canopy mask over cell idx projected into the frame.

    Falls back to the whole-frame canopy fraction when the cell covers no pixel centre.
    """
    height_px, width_px = canopy_px.shape
    uv = np.array(
        [
            latlon_to_pixel(LatLon(lat=lat, lon=lon), pose, width_px, height_px)
            for lon, lat in cell_polygon(grid, idx)
        ],
        dtype=np.float64,
    )
    # Pixel (row i, col j) has its centre at (u, v) = (j + 0.5, i + 0.5).
    centres = uv - 0.5
    u_lo = max(0, math.floor(centres[:, 0].min()))
    u_hi = min(width_px - 1, math.ceil(centres[:, 0].max()))
    v_lo = max(0, math.floor(centres[:, 1].min()))
    v_hi = min(height_px - 1, math.ceil(centres[:, 1].max()))
    if u_lo <= u_hi and v_lo <= v_hi:
        window = np.zeros((v_hi - v_lo + 1, u_hi - u_lo + 1), dtype=np.uint8)
        pts = np.round((centres - (u_lo, v_lo)) * (1 << _FILL_SHIFT)).astype(np.int32)
        cv2.fillPoly(window, [pts], 1, lineType=cv2.LINE_8, shift=_FILL_SHIFT)
        inside = window.astype(bool)
        if inside.any():
            return float(canopy_px[v_lo : v_hi + 1, u_lo : u_hi + 1][inside].mean())
    return float(canopy_px.mean())


# Read an image file as uint8 RGB (the only file I/O in this module).
def load_rgb(path: Path) -> np.ndarray:
    """H×W×3 uint8 RGB array of the image at path."""
    with Image.open(path) as image:
        return np.asarray(image.convert("RGB"), dtype=np.uint8)


def _held_cells(grid: Grid, held: Sequence[tuple[LatLon, float]]) -> set[int]:
    found: set[int] = set()
    for position, radius_m in held:
        found.update(cells_within_radius(grid, position, radius_m))
    return found
