"""Terrain affinity (sightline/geo/terrain_affinity.py) and the prior with it (search/prior.py).

Feature geometry here is synthetic (straight lines and squares on a test grid), except the
committed raster test, which rebuilds a 500 m grid from the repo's offline basemap.
"""

from __future__ import annotations

import gzip
import json
from pathlib import Path

import numpy as np
import pytest

from sightline.contract import LatLon
from sightline.geo import terrain_affinity as ta
from sightline.search.demo_scenario import generate
from sightline.search.grid import cell_containing, local_m_to_latlon, make_grid
from sightline.search.prior import (
    apply_affinity,
    koester_prior,
    placeholder_prior,
    prior_mass_outside,
    prior_source,
)

ROOT = Path(__file__).resolve().parents[2]
PMTILES = ROOT / "web/public/basemap/northshore.pmtiles"
SMALL = Path(__file__).parent / "fixtures/terrain_affinity_creek_500m.json"
LKP = LatLon(lat=49.37, lon=-122.945)
HIKER = "hiker/temperate_mountainous"


@pytest.fixture
def grid():
    return make_grid(LKP, 1000.0, 20.0)  # 50 × 50


def _ns_line(grid, east_m: float) -> list[tuple[float, float]]:
    """A north-south line at ``east_m`` across the whole grid, as [(lon, lat)]."""
    out = []
    for s in (-100.0, grid.rows * grid.cell_m + 100.0):
        p = local_m_to_latlon(grid, east_m, s)
        out.append((p.lon, p.lat))
    return out


def _square(grid, e0, s0, e1, s1) -> list[list[tuple[float, float]]]:
    pts = [(e0, s0), (e1, s0), (e1, s1), (e0, s1), (e0, s0)]
    return [[(p.lon, p.lat) for p in (local_m_to_latlon(grid, e, s) for e, s in pts)]]


def _cols(grid, m: np.ndarray) -> np.ndarray:
    return m.reshape(grid.rows, grid.cols)[grid.rows // 2]


# --- kernels and normalisation -------------------------------------------------------------------


def test_kernel_shape():
    d = np.array([0.0, ta.TRAIL.inner_m, 62.5, ta.TRAIL.outer_m, 1000.0, np.inf])
    k = ta.TRAIL(d)
    assert k[0] == k[1] == ta.TRAIL.near == 2.0
    assert k[2] == pytest.approx(1.5)  # halfway between 25 and 100 m
    assert k[3] == k[4] == k[5] == 1.0
    assert ta.ROAD(np.array([0.0, 50.0, 75.0, 100.0])) == pytest.approx([0.7, 0.7, 0.85, 1.0])
    assert ta.STREAM(np.array([0.0, 40.0, 120.0])) == pytest.approx([1.5, 1.5, 1.0])


def test_roads_do_not_attract():
    assert ta.ROAD.near <= 1.0
    assert ta.TRAIL.near > 1.0 and ta.STREAM.near > 1.0


def test_normalise_mean_one_and_guards():
    m = ta.normalise(np.array([1.0, 2.0, 3.0, 6.0]))
    assert m.mean() == pytest.approx(1.0)
    assert m / m[0] == pytest.approx([1, 2, 3, 6])
    assert np.all(ta.normalise(np.zeros(4)) == 1.0)
    with pytest.raises(ValueError):
        ta.normalise(np.array([1.0, -1.0]))
    with pytest.raises(ValueError):
        ta.normalise(np.array([1.0, np.nan]))


def test_no_features_is_flat(grid):
    a = ta.affinity_raster(grid, ta.Features())
    assert np.all(a.multiplier == 1.0)
    assert np.all(np.isinf(a.road_distance_m))


# --- the raster ----------------------------------------------------------------------------------


def test_trail_raises_cells_near_it(grid):
    a = ta.affinity_raster(grid, ta.Features(trails=[_ns_line(grid, 500.0)]))
    row = _cols(grid, a.multiplier)
    assert a.multiplier.mean() == pytest.approx(1.0)
    near, far = row[24], row[0]  # centres 10 m and 490 m from the trail
    assert near / far == pytest.approx(2.0)
    assert row[24] == row[25] == row.max()  # symmetric about the line
    assert np.all(np.diff(row[:25]) >= 0)  # rising towards it


def test_road_lowers_cells_near_it_and_records_distance(grid):
    a = ta.affinity_raster(grid, ta.Features(roads=[_ns_line(grid, 500.0)]))
    row = _cols(grid, a.multiplier)
    assert row[24] / row[0] == pytest.approx(0.7)
    d = _cols(grid, a.road_distance_m)
    assert d[24] == pytest.approx(10.0) and d[0] == pytest.approx(490.0)
    far = a.far_from_roads(100.0).reshape(grid.rows, grid.cols)[25]
    assert not far[22:28].any() and far[:20].all()


def test_kernels_multiply(grid):
    """A trail and a stream on the same line: 2.0 × 1.5 (Jacobs 2015 §4.3.4: independent)."""
    line = _ns_line(grid, 500.0)
    a = ta.affinity_raster(grid, ta.Features(trails=[line], streams=[line]))
    row = _cols(grid, a.multiplier)
    assert row[24] / row[0] == pytest.approx(3.0)


def test_water_and_cliff_polygons(grid):
    feats = ta.Features(
        water=[_square(grid, 0, 0, 200, 200)], cliffs=[_square(grid, 800, 800, 1000, 1000)]
    )
    m = ta.affinity_raster(grid, feats).multiplier.reshape(grid.rows, grid.cols)
    assert m[2, 2] / m[25, 25] == pytest.approx(ta.WATER_BODY)
    assert m[47, 47] / m[25, 25] == pytest.approx(ta.CLIFF)
    assert m[25, 25] == m[12, 40]


def test_polygon_hole_is_not_inside(grid):
    outer = _square(grid, 0, 0, 600, 600)[0]
    hole = _square(grid, 200, 200, 400, 400)[0]
    m = ta.affinity_raster(grid, ta.Features(water=[[outer, hole]])).multiplier
    m = m.reshape(grid.rows, grid.cols)
    assert m[15, 15] == m[40, 40] > m[5, 5]  # the island is dry land


def test_json_roundtrip(grid, tmp_path):
    a = ta.affinity_raster(grid, ta.Features(trails=[_ns_line(grid, 300.0)]))
    p = tmp_path / "a.json"
    p.write_text(json.dumps(a.to_json()))
    b = ta.load_affinity(p, grid)
    assert b.multiplier == pytest.approx(a.multiplier, abs=1e-4)
    with pytest.raises(ValueError):
        ta.load_affinity(p, make_grid(LKP, 1000.0, 25.0))


# --- the basemap reader ----------------------------------------------------------------------------


def test_tile_ids_follow_the_pmtiles_spec():
    assert [ta.zxy_to_tileid(0, 0, 0)] == [0]
    assert [ta.zxy_to_tileid(1, x, y) for x, y in ((0, 0), (0, 1), (1, 1), (1, 0))] == [1, 2, 3, 4]
    ids = {ta.zxy_to_tileid(4, x, y) for x in range(16) for y in range(16)}
    assert ids == set(range(85, 85 + 256))


def test_mvt_decoder_on_a_hand_built_tile():
    def varint(v):
        out = b""
        while True:
            b, v = v & 0x7F, v >> 7
            out += bytes([b | (0x80 if v else 0)])
            if not v:
                return out

    def field(n, payload: bytes):
        return varint(n << 3 | 2) + varint(len(payload)) + payload

    def packed(vals):
        return b"".join(varint(v) for v in vals)

    zz = lambda v: (v << 1) ^ (v >> 31)
    geom = [1 << 3 | 1, zz(10), zz(20), 2 << 3 | 2, zz(5), zz(0), zz(0), zz(5)]
    feature = field(2, packed([0, 0])) + varint(3 << 3) + varint(2) + field(4, packed(geom))
    value = field(1, b"path")
    layer = field(1, b"roads") + field(2, feature) + field(3, b"kind") + field(4, value)
    layer += varint(5 << 3) + varint(4096)
    tile = field(3, layer)
    out = ta.decode_mvt(tile)
    gtype, props, parts, extent = out["roads"][0]
    assert (gtype, props, extent) == (2, {"kind": "path"}, 4096)
    assert parts == [[(10, 20), (15, 20), (15, 25)]]
    assert ta.classify("roads", gtype, props) == "trails"
    assert gzip.decompress(gzip.compress(tile)) == tile


def test_classify_protomaps_kinds():
    assert ta.classify("roads", 2, {"kind": "minor_road", "kind_detail": "service"}) == "roads"
    assert ta.classify("roads", 2, {"kind": "path", "kind_detail": "track"}) == "trails"
    assert ta.classify("water", 2, {"kind": "stream"}) == "streams"
    assert ta.classify("water", 3, {"kind": "water", "kind_detail": "lake"}) == "water"
    assert ta.classify("earth", 2, {"kind": "cliff"}) == "cliff_lines"
    assert ta.classify("landuse", 3, {"kind": "bare_rock"}) == "cliffs"
    assert ta.classify("landuse", 3, {"kind": "wood"}) is None  # canopy is POD, not location


def test_committed_raster_matches_the_basemap():
    """The small committed raster is what the reader builds from the repo's basemap today."""
    small = ta.load_affinity(SMALL)
    assert small.multiplier.mean() == pytest.approx(1.0, abs=1e-3)
    feats = ta.features_from_pmtiles(PMTILES, ta.grid_bbox(small.grid))
    assert feats.trails and feats.streams and feats.water
    again = ta.affinity_raster(small.grid, feats)
    assert again.multiplier == pytest.approx(small.multiplier, abs=1e-3)
    assert small.multiplier.min() < 0.5
    assert small.multiplier.max() > 1.3


def test_overpass_answer_is_classed():
    def way(tags, pts):
        return {"type": "way", "tags": tags, "geometry": [{"lon": x, "lat": y} for x, y in pts]}

    sq = [(0, 0), (1, 0), (1, 1), (0, 1), (0, 0)]
    doc = {
        "elements": [
            way({"highway": "footway"}, [(0, 0), (1, 1)]),
            way({"highway": "residential"}, [(0, 0), (1, 1)]),
            way({"waterway": "stream"}, [(0, 0), (1, 1)]),
            way({"natural": "water"}, sq),
            way({"natural": "cliff"}, [(0, 0), (1, 1)]),
            way({"natural": "scree"}, sq),
        ]
    }
    c = ta.features_from_overpass(doc).counts()
    assert c == {"trails": 1, "roads": 1, "streams": 1, "cliff_lines": 1, "water": 1, "cliffs": 1}


# --- the prior with it ---------------------------------------------------------------------------


@pytest.fixture
def aff(grid):
    feats = ta.Features(
        trails=[_ns_line(grid, 300.0)],
        roads=[_ns_line(grid, 900.0)],
        water=[_square(grid, 0, 0, 200, 200)],
    )
    return ta.affinity_raster(grid, feats)


@pytest.mark.parametrize("category", [HIKER, "dementia/temperate_flat", None])
def test_prior_with_affinity_keeps_the_mass_bookkeeping(grid, aff, category):
    p0, out0 = koester_prior(grid, LKP, category)
    p1, out1 = koester_prior(grid, LKP, category, affinity=aff)
    assert out1 == out0  # outside unchanged
    assert p1.sum() == pytest.approx(p0.sum(), rel=1e-12)  # same in-grid mass
    assert p1.sum() + out1 == pytest.approx(1.0)
    assert p1 / p0 == pytest.approx(aff.multiplier * p0.sum() / (p0 * aff.multiplier).sum())
    # prior_mass_outside takes no affinity and still adds up to the prior's outside
    assert prior_mass_outside(grid, LKP, category)["total"] == pytest.approx(out1)


def test_placeholder_follows_terrain(grid, aff):
    p, out = koester_prior(grid, LKP, None, affinity=aff)
    u, uout = placeholder_prior(grid)
    assert out == uout
    assert p == pytest.approx(u * aff.multiplier)  # mean-1 multiplier: no rescale needed
    assert np.all(placeholder_prior(grid)[0] == u)  # the placeholder itself stays uniform


def test_prior_without_affinity_is_unchanged(grid):
    p0, _ = koester_prior(grid, LKP, HIKER)
    p1, _ = koester_prior(grid, LKP, HIKER, affinity=None)
    p2, _ = koester_prior(grid, LKP, HIKER, affinity=np.ones(grid.rows * grid.cols))
    assert np.array_equal(p0, p1)
    assert p2 == pytest.approx(p0)


def test_apply_affinity_guards(grid):
    p, _ = placeholder_prior(grid)
    with pytest.raises(ValueError):
        apply_affinity(grid, p, np.ones(3))
    with pytest.raises(ValueError):
        apply_affinity(grid, p, -np.ones(p.size))
    assert np.array_equal(apply_affinity(grid, p, np.zeros(p.size)), p)


def test_prior_source_says_terrain():
    assert prior_source(HIKER) == prior_source(HIKER, affinity=False)
    assert "terrain affinity" in prior_source(HIKER, affinity=True)
    assert prior_source(None, affinity=True).startswith("placeholder")


# --- the scenario generator ----------------------------------------------------------------------


def test_scenario_defaults_unchanged_and_min_road_distance(grid, aff):
    base = generate(1101, grid)
    assert generate(1101, grid, affinity=None, min_road_distance_m=None) == base
    for seed in range(1, 30):
        s = generate(seed, grid, affinity=aff, min_road_distance_m=150.0)
        rc = cell_containing(grid, s.person)
        assert rc is not None
        assert aff.road_distance_m[rc[0] * grid.cols + rc[1]] >= 150.0
        assert "terrain" in s.prior_source
    with pytest.raises(ValueError):
        generate(1101, grid, min_road_distance_m=50.0)
