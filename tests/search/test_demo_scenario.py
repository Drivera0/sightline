"""Demo scenarios (contract §15, v1.3; ``sightline/search/demo_scenario.py``): a seed gives the same
search every time, presets fix the category, and the person's position never reaches the API."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sightline.api.app import create_app
from sightline.api.missions import MissionContext
from sightline.contract import LatLon
from sightline.geo.roads import distance_to_road_m
from sightline.mission import MissionStore, validate_mission
from sightline.mission.queue import LocalQueue
from sightline.search.demo_scenario import (
    DISTRACTORS,
    MIN_ROAD_M,
    PRESETS,
    STAGING,
    demo_affinity,
    generate,
    pick_distractors,
    preset_seed,
)
from sightline.search.grid import make_grid
from sightline.search.prior import koester_prior
from tests.fixtures.drone_photos import LKP

GRID = make_grid(LatLon(lat=49.37, lon=-122.945), size_m=1000.0, cell_m=5.0)
SURVEY = [(-122.9471, 49.3685), (-122.9429, 49.3715)]


def test_the_same_seed_gives_the_same_scenario_field_for_field() -> None:
    a, b = generate(7, GRID, SURVEY), generate(7, GRID, SURVEY)
    assert a == b
    assert generate(8, GRID, SURVEY) != a


@pytest.mark.parametrize("key", list(PRESETS))
def test_presets_fix_the_category_and_draw_a_whole_scenario(key: str) -> None:
    name, seed, kind = PRESETS[key]
    aff = demo_affinity(GRID)  # the basemap's roads, as the demo's presets use them
    s = generate(preset_seed(key), GRID, SURVEY, affinity=aff, min_road_distance_m=MIN_ROAD_M)
    assert s.name == name and s.kind == kind and preset_seed(name) == seed
    assert 49.3685 <= s.lkp.lat <= 49.3715 and -122.9471 <= s.lkp.lon <= -122.9429  # in the survey
    assert 3 <= len(s.clues) <= 4
    assert [c.minutes for c in s.clues] == sorted(c.minutes for c in s.clues)
    assert s.last_seen_at < s.call_at
    # deeper in the terrain: the LKP's and the person's cells at least 300 m from any road (the
    # affinity's raster); the LKP within a cell of that by the exact distance; base camp on a road
    from sightline.search.grid import cell_containing

    def cell_road_m(p: LatLon) -> float:
        r, c = cell_containing(GRID, p)
        return float(aff.road_distance_m[r * GRID.cols + c])

    assert cell_road_m(s.lkp) >= MIN_ROAD_M and cell_road_m(s.person) >= MIN_ROAD_M
    assert distance_to_road_m(s.lkp.lat, s.lkp.lon) >= MIN_ROAD_M - 10
    assert s.lkp_road_m == pytest.approx(distance_to_road_m(s.lkp.lat, s.lkp.lon), abs=0.1)
    assert distance_to_road_m(s.base_camp["lat"], s.base_camp["lon"]) < 15
    assert s.base_camp["name"] == STAGING[0][0] or s.base_camp["name"].startswith("Road access")
    assert s.survey_launch["from"] == s.base_camp["name"] and s.survey_launch["transit_m"] > 0
    p, _ = koester_prior(
        GRID, s.lkp, s.category, affinity=aff
    )  # the person: where the prior has mass
    r, c = cell_containing(GRID, s.person)
    assert p[r * GRID.cols + c] > 0
    if s.category is None:
        assert "placeholder" in s.prior_source  # no checked rings for this category: said so


FRAMES = [(f"f{k + 1:04d}", 49.3686 + 0.0028 * (k % 10) / 10, -122.9470 + 0.0040 * (k // 10) / 10)
          for k in range(100)]  # fmt: skip


def test_each_scenario_throws_two_or_three_distractors_where_they_fit() -> None:
    s = generate(1101, GRID, SURVEY, frames=FRAMES)
    assert s == generate(1101, GRID, SURVEY, frames=FRAMES)  # deterministic, distractors too
    # the distractors have their own random stream: the rest of the scenario is the same without them
    bare = generate(1101, GRID, SURVEY)
    assert bare.distractors == [] and (bare.lkp, bare.person, bare.clues) == (
        s.lkp,
        s.person,
        s.clues,
    )
    kinds = {k for k, *_ in DISTRACTORS}
    for seed in (1101, 2202, 3303, 4404, 7, 8):
        ds = pick_distractors(seed, FRAMES, generate(seed, GRID, SURVEY).person)
        assert 1 <= len(ds) <= 3 and len({d.kind for d in ds}) == len(ds)
        for d in ds:
            assert d.kind in kinds and d.near_frame in {f[0] for f in FRAMES}
            assert (d.review, d.object) in {("object", "backpack"), ("object", "fire ring"),
                                            ("object", "shelter"), ("not_subject", None)}  # fmt: skip
            assert (d.trail_m <= 40.0) == (d.kind != "shelter")
    assert "distractors" in s.public() and "person" not in s.public()


def test_the_public_scenario_leaves_the_person_out() -> None:
    s = generate(1101, GRID, SURVEY)
    pub = s.public()
    assert "person" not in pub and str(s.person.lat) not in json.dumps(pub)
    with pytest.raises(KeyError):
        preset_seed("lost tourist")


@pytest.fixture
def client(tmp_path: Path):
    store = MissionStore(tmp_path / "missions")
    ctx = MissionContext(store, queue=LocalQueue(), detector_factory=lambda: None, hooks=None)
    ctx.start()
    app = create_app(
        cache_root=tmp_path / "c", data_root=tmp_path / "u", missions=ctx, rate_limit=None
    )
    with TestClient(app) as c:
        yield c, store
    ctx.queue.stop()


def test_the_api_sets_a_demo_missions_scenario_before_the_search_starts(client) -> None:
    http, store = client
    body = {"name": "Demo", "area_name": "Mount Seymour", "lkp": LKP, "mode": "demo"}
    mid = http.post("/missions", json=body).json()["mission_id"]
    r = http.post(f"/missions/{mid}/scenario", json={"preset": "dementia"})
    assert r.status_code == 200, r.text
    pub = r.json()
    assert "person" not in pub and pub["name"] == "Dementia walk-away" and pub["seed"] == 4404
    m = store.get(mid)
    assert m.scenario_seed == 4404 and m.subject == pub["subject"]
    assert (m.area.lkp.lat, m.area.lkp.lon) == (pub["lkp"]["lat"], pub["lkp"]["lon"])
    assert m.base_camp.name == pub["base_camp"]["name"]
    base = store.live(mid).base
    assert base.lkp == m.area.lkp and "dementia" in base.params.prior_source
    assert all(t.position.lat == m.base_camp.lat for t in store.state(mid)["teams"])
    assert validate_mission(store.root, mid) == []  # its truth-key check included
    assert '"person":' not in json.dumps([e.model_dump() for e in store.events(mid)])
    # the same seed again gives the same scenario; a live mission can't have one
    assert http.post(f"/missions/{mid}/scenario", json={"seed": 4404}).json() == pub
    live = http.post("/missions", json={**body, "mode": "live"}).json()["mission_id"]
    assert http.post(f"/missions/{live}/scenario", json={"seed": 1}).status_code == 409


def test_no_scenario_once_the_map_has_moved(client) -> None:
    http, _store = client
    body = {"name": "Demo", "area_name": "Mount Seymour", "lkp": LKP, "mode": "demo"}
    mid = http.post("/missions", json=body).json()["mission_id"]
    http.post(f"/missions/{mid}/clues", json={"kind": "object", "text": "glove", "lat": LKP["lat"],
                                             "lon": LKP["lon"], "reported_by": "command", "source": "form"})  # fmt: skip
    r = http.post(f"/missions/{mid}/scenario", json={"seed": 3})
    assert r.status_code == 409 and "before the search starts" in r.json()["detail"]
