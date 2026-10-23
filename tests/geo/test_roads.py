"""The basemap's roads, read from the PMTiles archive the map draws (``sightline/geo/roads.py``)."""

from __future__ import annotations

import pytest

from sightline.geo import roads


def test_tile_ids_follow_the_pmtiles_hilbert_order() -> None:
    assert roads.zxy_to_tileid(0, 0, 0) == 0
    assert [roads.zxy_to_tileid(1, x, y) for x, y in ((0, 0), (0, 1), (1, 1), (1, 0))] == [
        1,
        2,
        3,
        4,
    ]
    assert roads.zxy_to_tileid(2, 0, 0) == 5


def test_the_basemap_has_mount_seymour_road_and_the_lot() -> None:
    lines = roads.roads()
    assert len(lines) > 20
    # the trailhead lot at the end of Mount Seymour Road is on a road; the alpine is not
    assert roads.distance_to_road_m(49.36585, -122.94840) < 15
    assert roads.distance_to_road_m(49.3745, -122.9470) > 300
    lat, lon, d = roads.nearest_road_point(49.3700, -122.9450)
    assert d == pytest.approx(roads.distance_to_road_m(49.3700, -122.9450))
    assert roads.distance_to_road_m(lat, lon) < 0.5


def test_many_points_at_once_agree_with_one_at_a_time() -> None:
    pts = [(49.3700, -122.9450), (49.3660, -122.9490), (49.3740, -122.9420)]
    many = roads.distances_m([p[0] for p in pts], [p[1] for p in pts])
    for (lat, lon), d in zip(pts, many, strict=True):
        assert d == pytest.approx(roads.distance_to_road_m(lat, lon), abs=1e-6)


def test_trails_are_not_roads() -> None:
    assert roads.paths() and not set(roads.paths()) & set(roads.roads())
