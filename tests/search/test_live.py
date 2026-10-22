"""LiveMap (contract §14, LANE_C §5.2, C-L1) and the lattice sectors (C-S1)."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from sightline.contract import Clue, Conditions, LatLon, Pose
from sightline.search.grid import cell_containing, cells_within_radius
from sightline.search.live import CLUE_FACTOR, GROUND_POD_MAX, LiveMap
from sightline.search.pod import FrameInput
from sightline.search.sectors import lattice_sectors

LKP = LatLon(lat=49.375, lon=-122.9375)
AT = "2026-10-24T21:40:00Z"
GREY = np.full((750, 1000, 3), 128, dtype=np.uint8)  # no vegetation: canopy 0


def _map() -> LiveMap:
    return LiveMap.start(LKP, size_m=400.0)  # 80 × 80 cells of 5 m


def _frame(fid: str = "f0001", candidates=()) -> FrameInput:
    pose = Pose(lat=LKP.lat, lon=LKP.lon, alt_agl_m=50, heading_deg=0, gsd_m=0.05)  # 50 × 37.5 m
    return FrameInput(fid, pose, 1000, 750, Path("unused.jpg"), list(candidates))


def _idx(m: LiveMap, at: LatLon) -> int:
    r, c = cell_containing(m.base.grid, at)
    return r * m.base.grid.cols + c


def _apply(m: LiveMap, u):
    m.apply(u)
    return u


def _total(m: LiveMap) -> float:
    p, outside = m.p()
    return float(p.sum()) + outside


def test_start_is_the_labelled_placeholder_prior() -> None:
    m = _map()
    assert m.base.params.prior_source == "placeholder" and m.base.grid.cell_m == 5.0
    assert (m.base.grid.rows, m.base.grid.cols) == (80, 80)
    assert abs(_total(m) - 1) < 1e-12 and m.p()[1] == 0.5


def test_a_photo_steps_the_cells_it_saw_and_holds_candidates() -> None:
    m = _map()
    cand = LatLon(lat=LKP.lat, lon=LKP.lon)
    u = m.frame_update(_frame(candidates=[(cand, 5.0)]), recall=0.864, held=[(cand, 5.0)], rgb=GREY)
    assert (u.kind, u.source, u.ref) == ("step", "frame", "f0001")
    pods = dict(u.cells)
    assert pods and max(pods.values()) <= 0.864  # recall × (1 − canopy 0) × overlap ≤ 1
    held = set(cells_within_radius(m.base.grid, cand, 5.0))
    assert held and not held & set(pods)  # where it detected someone, the reviewer decides
    assert {i for i, _, _ in u.canopy} >= set(pods)
    before = m.p()[0][next(iter(pods))]
    _apply(m, u)
    assert m.p()[0][next(iter(pods))] < before and abs(_total(m) - 1) < 1e-12


def test_poor_visibility_lowers_what_a_photo_rules_out() -> None:
    m = _map()
    clear_day = dict(m.frame_update(_frame(), recall=0.864, held=[], rgb=GREY).cells)
    haze = dict(
        m.frame_update(_frame(), recall=0.864, held=[], visibility_factor=0.5, rgb=GREY).cells
    )
    i = max(clear_day, key=clear_day.get)
    assert haze[i] == pytest.approx(clear_day[i] / 2, abs=1e-4)


def test_reviews() -> None:
    m = _map()
    _apply(m, m.frame_update(_frame(), recall=0.864, held=[], rgb=GREY))
    at = LatLon(lat=LKP.lat - 0.0001, lon=LKP.lon + 0.0001)
    assert m.review_update("f0001-d01", "f0001", at, 5.0, "unsure") is None
    no = m.review_update("f0001-d01", "f0001", at, 5.0, "not_person")
    assert no.kind == "step" and {pod for _, pod in no.cells} == {0.9}
    i = _idx(m, at)
    looked = m._frame_pods["f0001"][i]
    yes = m.review_update("f0001-d01", "f0001", at, 5.0, "person")
    assert yes.kind == "reweight" and dict(yes.cells)[i] == pytest.approx(
        1 / (1 - looked), abs=1e-4
    )
    p_before = m.p()[0][i]
    _apply(m, yes)
    assert m.p()[0][i] > p_before


def test_a_searched_sector_is_never_cleared() -> None:
    m = _map()
    layout = lattice_sectors(m.base.grid)
    u = m.ground_update(list(layout.cells_of("B3")), 0.99, "B3")
    assert {pod for _, pod in u.cells} == {GROUND_POD_MAX} and u.ref == "B3"
    poa = m.sector_poa(layout)["B3"]
    _apply(m, u)
    assert 0 < m.sector_poa(layout)["B3"] < poa


def test_a_clue_raises_the_probability_around_it() -> None:
    m = _map()
    clue = Clue(
        id="c001",
        kind="object",
        text="blue backpack",
        lat=LKP.lat,
        lon=LKP.lon,
        radius_m=10,
        reliability="medium",
        reported_by="T2",
        source="radio",
        confirmed_by_turn="r0003",
        at=AT,
        confirmed=True,
    )
    u = m.clue_update(clue)
    factors = dict(u.cells)
    centre = _idx(m, LKP)
    assert factors[centre] == CLUE_FACTOR["medium"]
    assert set(factors.values()) == {
        3.0,
        round(3.0**0.5, 4),
    }  # near, and the ring out to 2 × radius
    p0, out0 = m.p()
    weighted = (
        sum(p0[i] * f for i, f in factors.items()) + p0.sum() - sum(p0[i] for i in factors) + out0
    )
    _apply(m, u)
    assert m.p()[0][centre] == pytest.approx(p0[centre] * 3 / weighted, rel=1e-12)
    assert m.p()[0][centre] > p0[centre] and abs(_total(m) - 1) < 1e-12


def _conditions(band: str) -> Conditions:
    return Conditions(
        fetched_at=AT,
        stale=False,
        area="a",
        sources=[],
        wind_kmh=None,
        gust_kmh=None,
        wind_dir_deg=None,
        precip_mm_h=None,
        precip_prob=None,
        temp_c=None,
        visibility_km=None,
        sunset=None,
        civil_twilight_end=None,
        alerts=[],
        flyable=None,
        flyable_until=None,
        flyability_reason="",
        visibility_factor=1.0,
        exposure_band=band,
        exposure_note="heuristic",
    )


def test_worse_exposure_shelters_once_per_level() -> None:
    m = _map()
    m.base.canopy[0] = 0.8  # a tree-covered cell, as if a photo had seen it
    m = LiveMap.from_base(m.base)
    assert m.conditions_update(_conditions("moderate")) is None
    high = _apply(m, m.conditions_update(_conditions("high")))
    assert dict(high.cells) == {0: 1.5}
    assert m.conditions_update(_conditions("high")) is None  # already sheltered for "high"
    assert dict(m.conditions_update(_conditions("severe")).cells) == {0: 2.0}


def test_a_map_rebuilt_from_its_log_is_the_same_map() -> None:
    m = _map()
    log = [
        _apply(m, m.frame_update(_frame("f0001"), recall=0.864, held=[], rgb=GREY)),
        _apply(m, m.review_update("f0001-d01", "f0001", LKP, 5.0, "not_person")),
        _apply(
            m,
            m.clue_update(
                Clue(
                    id="c001",
                    kind="track",
                    text="tracks",
                    lat=LKP.lat,
                    lon=LKP.lon,
                    radius_m=20,
                    reliability="high",
                    reported_by="T1",
                    source="form",
                    at=AT,
                    confirmed=True,
                )
            ),
        ),
    ]
    again = LiveMap.from_base(m.base)
    for u in log:
        again.apply(u)
    np.testing.assert_array_equal(again.p()[0], m.p()[0])
    assert again.p()[1] == m.p()[1] and again.canopy() == m.canopy()


def test_lattice_sectors() -> None:
    grid = _map().base.grid
    layout = lattice_sectors(grid)
    assert [s.id for s in layout.sectors][:5] == ["A1", "A2", "A3", "A4", "B1"] and len(
        layout.sectors
    ) == 16
    sizes = [len(layout.cells_of(s.id)) for s in layout.sectors]
    assert sum(sizes) == grid.rows * grid.cols and set(sizes) == {400}  # every cell once, 20 × 20
    ring = layout.polygon("A1", grid)
    assert len(ring) == 5 and ring[0] == ring[-1]
    assert ring[0][1] > ring[2][1] and ring[0][0] < ring[1][0]  # NW corner first, then east
    with pytest.raises(KeyError):
        layout.cells_of("Z9")
