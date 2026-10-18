"""Tiling of full-size images into 1024 px training tiles (docs/LANE_A_ML.md §6.1, §7)."""

from __future__ import annotations

import random

import numpy as np

from sightline.ml.tiling import (
    Tile,
    apply_masks,
    boxes_in_tile,
    masked_regions_in_tile,
    select_tiles,
    tile_grid,
    tile_positions,
)
from sightline.ml.types import Box


def test_positions_snap_last_tile_to_edge() -> None:
    # 4000 wide, 1024 tiles, stride 819: 0, 819, 1638, 2457, then snap to 2976
    assert tile_positions(4000, 1024, 819) == [0, 819, 1638, 2457, 2976]
    assert tile_positions(3000, 1024, 819) == [0, 819, 1638, 1976]


def test_positions_exact_fit_has_no_extra_tile() -> None:
    assert tile_positions(1843, 1024, 819) == [0, 819]


def test_positions_image_smaller_than_tile() -> None:
    assert tile_positions(750, 1024, 819) == [0]


def test_grid_4000x3000_gives_20_tiles() -> None:
    tiles = tile_grid(4000, 3000, tile_px=1024, overlap=0.2)
    assert len(tiles) == 20
    assert tiles[0] == Tile(0, 0, 1024, 1024)
    assert tiles[-1] == Tile(2976, 1976, 4000, 3000)
    assert all(t.x1 - t.x0 == 1024 and t.y1 - t.y0 == 1024 for t in tiles)


def test_grid_4000x2250_gives_15_tiles() -> None:
    assert len(tile_grid(4000, 2250)) == 15


def test_grid_clamps_tile_to_small_image() -> None:
    assert tile_grid(1000, 750) == [Tile(0, 0, 1000, 750)]


def test_box_fully_inside_tile_is_kept_in_tile_coords() -> None:
    tile = Tile(819, 0, 1843, 1024)
    assert boxes_in_tile([Box(900, 100, 960, 160)], tile) == [Box(81, 100, 141, 160)]


def test_straddling_box_lands_only_where_at_least_half_inside() -> None:
    left, right = Tile(0, 0, 1024, 1024), Tile(819, 0, 1843, 1024)
    # 60 px wide box from 990 to 1050: 34 px inside the left tile (57%), all inside the right one
    box = Box(990, 100, 1050, 160)
    assert boxes_in_tile([box], left) == [Box(990, 100, 1024, 160)]
    assert boxes_in_tile([box], right) == [Box(171, 100, 231, 160)]
    # 60 px wide box from 1000 to 1060: 24 px inside the left tile (40%) -> dropped there
    box = Box(1000, 100, 1060, 160)
    assert boxes_in_tile([box], left) == []
    assert boxes_in_tile([box], right) == [Box(181, 100, 241, 160)]


def test_slivers_under_8px_are_dropped_even_if_half_inside() -> None:
    tile = Tile(0, 0, 1024, 1024)
    # 10 px wide box, 6 px inside (60%) but the sliver is only 6 px wide
    assert boxes_in_tile([Box(1018, 100, 1028, 160)], tile) == []


def test_select_tiles_keeps_all_positive_and_a_seeded_quarter_of_empty() -> None:
    positive = [(Tile(0, 0, 1, 1), [Box(0, 0, 1, 1)])] * 3
    empty = [(Tile(i, 0, i + 1, 1), []) for i in range(100)]
    chosen = select_tiles(positive + empty, empty_keep_frac=0.25, rng=random.Random(7))
    n_pos = sum(1 for _, b in chosen if b)
    n_empty = sum(1 for _, b in chosen if not b)
    assert n_pos == 3
    assert n_empty == 25
    again = select_tiles(positive + empty, empty_keep_frac=0.25, rng=random.Random(7))
    assert again == chosen


def test_tile_name_encodes_offset() -> None:
    assert Tile(2976, 1976, 4000, 3000).name("train_BRS_0052") == "train_BRS_0052_2976_1976"


def test_partly_visible_person_is_masked_not_left_as_background() -> None:
    left = Tile(0, 0, 1024, 1024)
    # 40 % inside the left tile: no label there, so its visible part must be masked (2 px pad)
    box = Box(1000, 100, 1060, 160)
    assert boxes_in_tile([box], left) == []
    assert masked_regions_in_tile([box], left) == [Box(998, 98, 1024, 162)]
    # a labelled person (>= 50 % inside) is never masked
    assert masked_regions_in_tile([Box(990, 100, 1050, 160)], left) == []
    # a sliver (60 % inside but 6 px wide) is masked too
    assert masked_regions_in_tile([Box(1018, 100, 1028, 160)], left) == [Box(1016, 98, 1024, 162)]
    # a person entirely outside the tile is ignored
    assert masked_regions_in_tile([Box(2000, 100, 2060, 160)], left) == []


def test_apply_masks_blacks_out_region_but_keeps_labelled_neighbour() -> None:
    pixels = np.full((20, 20, 3), 200, dtype=np.uint8)
    masks = [Box(0, 0, 10, 10)]
    keep = [Box(8, 8, 15, 15)]  # overlaps the mask corner
    out = apply_masks(pixels, masks, keep)
    assert out[0, 0].tolist() == [0, 0, 0]
    assert out[7, 7].tolist() == [0, 0, 0]
    assert out[9, 9].tolist() == [200, 200, 200]  # inside the kept box: restored
    assert out[15, 15].tolist() == [200, 200, 200]
    assert pixels[0, 0].tolist() == [200, 200, 200]  # input untouched
    assert (apply_masks(pixels, [], keep) == pixels).all()
