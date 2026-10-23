"""The demo mission fixture (``web/src/command/__fixtures__/demo_mission.json``) carries the command
post's additions (contract §15, v1.3): base camp, last heard and ETA, the one timeline with every
kind, the legs' photos at their capture times, the photographed flag, the whole-grid prior, and a
story that ends found; the after-action report is built from it."""

from __future__ import annotations

import json
from pathlib import Path

from shapely.geometry import Point, Polygon

from sightline.contract import Mission, Team, TimelineEntry
from sightline.mission import MissionStore
from sightline.mission.report import after_action_markdown, build
from tests.fixtures.demo_mission import FIXTURE, NOW, seed_demo

FIX = json.loads(FIXTURE.read_text())
PRIOR = FIXTURE.parent / "demo_prior.json"
SCENARIOS = FIXTURE.parent / "scenarios"


def test_the_story_ends_found_by_team_one_in_c2() -> None:
    m = Mission.model_validate(FIX["mission"])
    assert m.contract_version == "1.3" and m.status == "found"
    assert (m.found.team, m.found.sector) == ("T1", "C2") and m.found.at < FIX["now"]
    c2 = next(s for s in FIX["sectors"] if s["sector_id"] == "C2")
    assert Polygon(c2["polygon"]).contains(Point(m.found.lon, m.found.lat))
    assert m.base_camp.name == "Trailhead lot"
    # the fleet's simulated person is where the team finds them; drones launch from the base camp
    assert all((d["home"]["lat"], d["home"]["lon"]) == (m.base_camp.lat, m.base_camp.lon)
               for d in FIX["fleet"]["drones"])  # fmt: skip


def test_teams_carry_last_heard_and_eta() -> None:
    teams = [Team.model_validate(t) for t in FIX["teams"]]
    assert all(t.last_heard_at for t in teams)
    assert {t.id for t in teams if t.eta_min is not None} >= {"T1", "T3"}


def test_the_timeline_has_every_kind_and_radio_lines_carry_their_turn() -> None:
    lines = [TimelineEntry.model_validate(x) for x in FIX["timeline"]]
    assert {x.kind for x in lines} == {
        "radio",
        "clue",
        "detection",
        "decision",
        "checkin",
        "drone",
        "found",
    }
    assert all(x.turn_id for x in lines if x.kind == "radio")
    assert lines[-1].kind in ("found", "drone", "checkin")
    found = next(x for x in lines if x.kind == "found")
    assert found.team == "T1" and found.sector == "C2"


def test_leg_photos_land_along_the_legs_at_their_capture_times() -> None:
    photos = FIX["leg_photos"]
    assert len(photos) > 100
    by_seq = {u["seq"]: u for u in FIX["map_updates"]}
    for drone in {p["drone"] for p in photos}:
        times = [p["at"] for p in photos if p["drone"] == drone]
        assert times == sorted(times) and len(set(times)) > 10  # one by one, not at the leg's end
    p = photos[0]
    u = by_seq[p["map_seq"]]
    assert u["source"] == "frame" and u["ref"] == p["frame_id"] == "f0501" and u["at"] == p["at"]
    assert all("2026-10-24T21:5" in x["at"] for x in photos)


def test_the_prior_covers_the_whole_grid_and_photographed_is_a_flag() -> None:
    prior = json.loads(PRIOR.read_text())
    assert len(prior["p"]) == 200 * 200 and min(prior["p"]) > 0
    assert prior["prior_source"].startswith("Koester lost-person rings, hiker")
    flags = sum(n for _, n in FIX["photographed"])
    assert flags == 200 * 200 and 0 < sum(n for v, n in FIX["photographed"] if v) < flags


def test_the_preset_scenarios_each_end_found_without_the_person_in_the_file() -> None:
    files = sorted(SCENARIOS.glob("*.json"))
    assert [f.stem for f in files] == ["dementia", "despondent", "missing-child", "overdue-hiker"]
    for f in files:
        d = json.loads(f.read_text())
        assert (
            d["mission"]["status"] == "found"
            and d["mission"]["scenario_seed"] == d["scenario"]["seed"]
        )
        assert "person" not in d["scenario"] and len(d["prior"]["p"]) == 200 * 200
        assert 3 <= len(d["scenario"]["clues"]) <= 4


def test_the_after_action_report_on_the_demo_mission(tmp_path: Path) -> None:
    store = MissionStore(tmp_path / "m")
    mid = seed_demo(store)
    r = build(store, mid, NOW)
    assert r["found"]["team"] == "T1" and r["found"]["callsign"] == "Team One"
    assert [s["sector"] for s in r["searched"]] == ["C4", "B4"]
    md = after_action_markdown(r)
    assert "**Found** by Team One in sector C2" in md and "| C4 | Team Four | 40% |" in md
    assert "Proposals by" in md and "/ics204/T1.md" in md
