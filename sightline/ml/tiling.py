"""Cut full-size images into overlapping training tiles (docs/LANE_A_ML.md §6.1).

Rules:
- tile 1024 px, overlap 0.2 → stride 819; the last tile in each row/column snaps to the edge;
- a box is kept in a tile if ≥ 50 % of its original area is inside, and the clipped box is
  at least 8 px on each side;
- every tile with a box is kept, plus a seeded fraction (25 %) of the empty tiles.
"""

from __future__ import annotations

import random
from dataclasses import dataclass

from sightline.ml.types import Box

TILE_PX = 1024
OVERLAP = 0.2
MIN_INSIDE_FRAC = 0.5
MIN_SIDE_PX = 8
EMPTY_KEEP_FRAC = 0.25


@dataclass(frozen=True)
class Tile:
    """Pixel window ``[x0, x1) × [y0, y1)`` inside the source image."""

    x0: int
    y0: int
    x1: int
    y1: int

    @property
    def width_px(self) -> int:
        return self.x1 - self.x0

    @property
    def height_px(self) -> int:
        return self.y1 - self.y0

    def name(self, stem: str) -> str:
        return f"{stem}_{self.x0}_{self.y0}"


def tile_positions(size_px: int, tile_px: int, stride_px: int) -> list[int]:
    """Start offsets along one axis. The final tile is moved back so it ends at the edge."""
    if size_px <= tile_px:
        return [0]
    starts = list(range(0, size_px - tile_px + 1, stride_px))
    if starts[-1] + tile_px < size_px:
        starts.append(size_px - tile_px)
    return starts


def tile_grid(width: int, height: int, tile_px: int = TILE_PX, overlap: float = OVERLAP) -> list[Tile]:
    """Row-major list of tiles covering the image."""
    stride = max(1, round(tile_px * (1 - overlap)))
    return [
        Tile(x, y, min(x + tile_px, width), min(y + tile_px, height))
        for y in tile_positions(height, tile_px, stride)
        for x in tile_positions(width, tile_px, stride)
    ]


def boxes_in_tile(
    boxes: list[Box],
    tile: Tile,
    min_inside_frac: float = MIN_INSIDE_FRAC,
    min_side_px: int = MIN_SIDE_PX,
) -> list[Box]:
    """Boxes that belong to this tile, clipped and expressed in tile coordinates."""
    kept: list[Box] = []
    for box in boxes:
        clipped = box.clipped(tile.x0, tile.y0, tile.x1, tile.y1)
        if clipped is None:
            continue
        if clipped.area_px < min_inside_frac * box.area_px:
            continue
        if clipped.width_px < min_side_px or clipped.height_px < min_side_px:
            continue
        kept.append(clipped.shifted(-tile.x0, -tile.y0))
    return kept


def select_tiles(
    tiles: list[tuple[Tile, list[Box]]],
    empty_keep_frac: float = EMPTY_KEEP_FRAC,
    rng: random.Random | None = None,
) -> list[tuple[Tile, list[Box]]]:
    """Keep every tile with a box and a seeded ``empty_keep_frac`` of the empty ones.

    The number of empty tiles kept is ``round(n_empty * empty_keep_frac)`` so the ratio
    holds per image, not only in expectation. Order of the input is preserved.
    """
    rng = rng or random.Random(7)
    empty_idx = [i for i, (_, boxes) in enumerate(tiles) if not boxes]
    n_keep = round(len(empty_idx) * empty_keep_frac)
    keep_empty = set(rng.sample(empty_idx, n_keep)) if n_keep else set()
    return [tb for i, tb in enumerate(tiles) if tb[1] or i in keep_empty]


def tiles_for_image(
    width: int,
    height: int,
    boxes: list[Box],
    seed_key: str,
    tile_px: int = TILE_PX,
    overlap: float = OVERLAP,
    empty_keep_frac: float = EMPTY_KEEP_FRAC,
    seed: int = 7,
) -> list[tuple[Tile, list[Box]]]:
    """Grid + box assignment + empty-tile sampling for one image.

    ``seed_key`` (normally the image stem) makes the sampling deterministic per image,
    independent of the order images are processed in (needed for multiprocessing).
    """
    grid = [(t, boxes_in_tile(boxes, t)) for t in tile_grid(width, height, tile_px, overlap)]
    return select_tiles(grid, empty_keep_frac, random.Random(f"{seed}:{seed_key}"))
