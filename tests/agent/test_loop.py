"""LANE_A §6 test 5: the agent loop (sightline/agent/loop.py) against the fake store and C's
stand-ins. Every trigger in §5.6 gives the expected proposal kinds; nothing is dismissed;
superseding works; bad briefings are rejected. No network, no keys."""

from __future__ import annotations

import json
import re
import threading

import cv2
import numpy as np
import pytest

from sightline.agent import loop
from sightline.agent._stubs import StubLiveMap, lattice_sectors
from sightline.agent.llm import ChatResult, FakeChatClient
from sightline.agent.runner import BudgetClient, BudgetExceeded
from sightline.contract import (
    Clue,
    Conditions,
    Detection,
    Drone,
    FleetState,
    Frame,
    LatLon,
    Leg,
    Pose,
    Source,
    Team,
)
from sightline.ml.types import Box, RawDetection
from sightline.search.grid import cell_center, make_grid
from tests.agent.fake_store import FakeMissionStore

LKP = LatLon(lat=49.37, lon=-122.94)
NOW = "2026-10-24T17:00:00.000Z"
YES = json.dumps(
    {
        "person": "yes",
        "posture": "lying",
        "group_size": 1,
        "clothing": "red jacket",
        "reason": "A person lying in the grass.",
    }
)
NO = YES.replace('"yes"', '"no"')
BRIEFING = (
    "Team One, Sightline. Search sector B3 for an adult in a red jacket, possibly lying down."
)
CLEAR = re.compile(r"\bclear(ed)?\b", re.IGNORECASE)


class _CentreDetector:
    def detect_array(self, img_bgr, conf=0.05):
        h, w = img_bgr.shape[:2]
        return [RawDetection(Box(w // 2 - 10, h // 2 - 20, w // 2 + 10, h // 2 + 20), 0.6)]


def _client(verdict: str = YES, briefing: str = BRIEFING) -> FakeChatClient:
    return FakeChatClient({"Is there a person": verdict, "Facts:": briefing})


def _drone(id_: str, status: str = "idle", leg_id: str | None = None) -> Drone:
    return Drone(
        id=id_,
        name=f"Drone {id_[1:]}",
        simulated=True,
        position=LKP,
        altitude_m=50,
        speed_ms=8,
        battery_pct=90,
        max_wind_kmh=35,
        status=status,
        leg_id=leg_id,
    )


def _team(id_: str, callsign: str, status: str, position: LatLon | None) -> Team:
    return Team(
        id=id_,
        callsign=callsign,
        members=3,
        status=status,
        position=position,
        position_at=NOW if position else None,
        note=None,
    )


def _conditions(flyable: bool | None = True, visibility: float = 1.0) -> Conditions:
    return Conditions(
        fetched_at=NOW,
        stale=False,
        area="Seymour",
        sources=[],
        wind_kmh=10,
        gust_kmh=15,
        wind_dir_deg=270,
        precip_mm_h=0,
        precip_prob=0.1,
        temp_c=8,
        visibility_km=10,
        sunset=None,
        civil_twilight_end=None,
        alerts=[],
        flyable=flyable,
        flyable_until=None,
        flyability_reason="gusts 40 km/h above the fleet limit" if flyable is False else "ok",
        visibility_factor=visibility,
        exposure_band="low",
        exposure_note="heuristic",
    )


@pytest.fixture(autouse=True)
def _fresh_conditions_memory():
    loop._last_conditions.clear()


@pytest.fixture
def mission():
    """A mission with all probability in sector B3, two standby teams and one searching, an
    idle drone D1 and a flying drone D2, and one frame with a detection inside B3."""
    store = FakeMissionStore()
    m = store.create("Seymour", "Seymour", LKP, "live", subject="adult, red jacket")
    mid = m.mission_id
    grid = make_grid(LKP, 1000, 20)
    layout = lattice_sectors(grid)
    p = np.zeros(grid.rows * grid.cols)
    p[layout.cells_of("B3")] = 1 / len(layout.cells_of("B3"))
    store.live_maps[mid] = StubLiveMap(grid, p)
    b3 = cell_center(grid, int(layout.cells_of("B3")[len(layout.cells_of("B3")) // 2]))

    store.upsert_team(mid, _team("T1", "Team One", "standby", b3))
    store.upsert_team(mid, _team("T2", "Team Two", "standby", LatLon(lat=49.36, lon=-122.95)))
    store.upsert_team(mid, _team("T3", "Team Three", "searching", None))
    old = Leg(
        id="L900",
        drone_id="D2",
        sector_id="A1",
        waypoints=[],
        altitude_m=50,
        est_minutes=8,
        expected_clearance=0.01,
        score_per_min=0.001,
        reason="r",
        status="flying",
    )
    store.put_fleet(
        mid,
        FleetState(
            simulated=True,
            drones=[_drone("D1"), _drone("D2", "flying", "L900")],
            legs=[old],
            updated_at=NOW,
        ),
    )
    store.put_conditions(mid, _conditions())

    corners = ((-122.95, 49.37), (-122.94, 49.37), (-122.94, 49.36), (-122.95, 49.36))
    frame = Frame(
        id="f0001",
        file="frames/f0001.jpg",
        width_px=1000,
        height_px=750,
        flight_index=0,
        source=Source(image="x.jpg", x0=0, y0=0),
        pose=Pose(lat=b3.lat, lon=b3.lon, alt_agl_m=50, heading_deg=0, gsd_m=0.02),
        footprint=corners,
        score=0.5,
        rank=1,
        n_candidates=1,
    )
    img = np.random.default_rng(0).integers(0, 255, (750, 1000, 3), dtype=np.uint8)
    store.append_frame(mid, frame, cv2.imencode(".jpg", img)[1].tobytes())
    dets = [
        Detection(
            id="f0001-d01",
            box_px=(480, 340, 510, 400),
            conf=0.6,
            crop=None,
            lat=b3.lat,
            lon=b3.lon,
            radius_m=10,
        ),
        Detection(
            id="f0001-d02",
            box_px=(100, 100, 130, 160),
            conf=0.21,
            crop=None,
            lat=b3.lat,
            lon=b3.lon,
            radius_m=10,
        ),
    ]
    store.append_detections(mid, "f0001", dets, {})
    return store, mid, b3


def _kinds(ps) -> list[str]:
    return [p.kind for p in ps]


def _handle(store, mid, event, ref, client=None, **kw):
    return loop.handle(event, store, mid, ref, client=client, detector=_CentreDetector(), **kw)


# --- detection ---------------------------------------------------------------------------------


def test_near_miss_called_a_person_is_proposed_for_the_queue(mission) -> None:
    store, mid, _ = mission
    (p,) = _handle(store, mid, "detection", "f0001-d02", _client())
    assert p.kind == "promote_detection" and p.target == {"detection": "f0001-d02"}
    assert p.created_by == "verifier" and p.status == "pending"
    assert "0.21" in p.reason and "0.29" in p.reason
    assert {e.kind for e in p.evidence} == {"crop", "relook", "trace"}
    assert store.state(mid)["verdicts"][0].detection_id == "f0001-d02"


def test_no_proposal_for_a_no_a_queue_item_or_without_a_model(mission) -> None:
    store, mid, _ = mission
    assert _handle(store, mid, "detection", "f0001-d02", _client(verdict=NO)) == []
    assert _handle(store, mid, "detection", "f0001-d01", _client()) == []  # badge only
    assert len(store.state(mid)["verdicts"]) == 2
    assert _handle(store, mid, "detection", "f0001-d02", None) == []


# --- review ------------------------------------------------------------------------------------


def test_confirmed_sighting_alerts_everyone_and_sends_the_nearest_standby_team(mission) -> None:
    store, mid, _ = mission
    out = _handle(store, mid, "review", "f0001-d01", _client(), answer="person")
    assert _kinds(out) == ["alert", "assign_sector"]
    alert, assign = out
    assert alert.target == {"team": "all"} and alert.briefing == BRIEFING
    assert assign.target == {"team": "T1", "sector": "B3"}  # T1 is in B3, T2 is far away
    assert loop.check_briefing(assign.briefing, {"team": "Team One", "sector": "B3"}) == []


def test_unsure_gets_a_verdict_and_not_person_nothing(mission) -> None:
    store, mid, _ = mission
    assert _handle(store, mid, "review", "f0001-d01", _client(), answer="unsure") == []
    assert len(store.state(mid)["verdicts"]) == 1
    assert _handle(store, mid, "review", "f0001-d01", _client(), answer="not_person") == []


# --- clues, legs and superseding ---------------------------------------------------------------


def _clue(store, mid, at: LatLon, text: str = "blue backpack") -> Clue:
    return store.add_clue(
        mid,
        Clue(
            id="",
            kind="object",
            text=text,
            lat=at.lat,
            lon=at.lon,
            radius_m=30,
            reliability="high",
            reported_by="T2",
            source="form",
            at=NOW,
            confirmed=True,
        ),
    )


def test_a_clue_sends_a_drone_and_supersedes_its_older_proposal(mission) -> None:
    store, mid, b3 = mission
    c = _clue(store, mid, b3)
    (first,) = _handle(store, mid, "clue", c.id)
    assert first.kind == "drone_leg" and first.target["drone"] == "D1"  # idle drone, best leg
    assert first.leg.sector_id == "B3" and first.leg.id == first.target["leg"] == "L001"
    assert c.id in first.reason and "sector B3" in first.reason
    assert [leg.id for leg in store.state(mid)["fleet"].legs] == ["L900"]  # fleet untouched

    c2 = _clue(store, mid, b3, "torn jacket")
    (second,) = _handle(store, mid, "clue", c2.id)
    assert second.target["leg"] == "L002"
    statuses = {p.id: p.status for p in store.state(mid)["proposals"]}
    assert statuses[first.id] == "superseded" and statuses[second.id] == "pending"


def test_a_flying_drone_gets_a_retask(mission) -> None:
    store, mid, _ = mission
    fleet = store.state(mid)["fleet"]
    store.put_fleet(mid, fleet.model_copy(update={"drones": [fleet.drones[1]]}))  # only D2
    (p,) = _handle(store, mid, "leg_done", "L900")
    assert p.kind == "retask_drone" and p.target["drone"] == "D2"


def test_leg_done_plans_the_next_leg_for_that_drone(mission) -> None:
    store, mid, _ = mission
    (p,) = _handle(store, mid, "leg_done", "L900")
    assert p.target["drone"] == "D2" and "L900 is done" in p.reason


# --- conditions --------------------------------------------------------------------------------


def test_unflyable_conditions_recall_drones_once(mission) -> None:
    store, mid, _ = mission
    assert _handle(store, mid, "conditions", mid) == []
    store.put_conditions(mid, _conditions(flyable=False))
    (p,) = _handle(store, mid, "conditions", mid)
    assert p.kind == "alert" and p.target == {"drone": "all"} and "gusts" in p.reason
    assert _handle(store, mid, "conditions", mid) == []  # only on the change


def test_visibility_drop_replans(mission) -> None:
    store, mid, _ = mission
    _handle(store, mid, "conditions", mid)
    store.put_conditions(mid, _conditions(visibility=0.5))
    out = _handle(store, mid, "conditions", mid)
    assert out and out[0].kind == "drone_leg" and "0.50" in out[0].reason


# --- ticks: team assignments -------------------------------------------------------------------


def test_tick_assigns_standby_teams_once_each(mission) -> None:
    store, mid, _ = mission
    out = _handle(store, mid, "tick", mid, _client())
    assert _kinds(out) == ["assign_sector", "assign_sector"]
    assert {p.target["team"] for p in out} == {"T1", "T2"}
    assert _handle(store, mid, "tick", mid, _client()) == []  # one pending per team


# --- invariants --------------------------------------------------------------------------------


def test_never_dismisses_and_never_says_clear(mission) -> None:
    store, mid, b3 = mission
    client = _client(briefing="All clear in sector B3, Team One.")
    _handle(store, mid, "detection", "f0001-d02", client)
    _handle(store, mid, "review", "f0001-d01", client, answer="person")
    _handle(store, mid, "clue", _clue(store, mid, b3).id)
    _handle(store, mid, "tick", mid, client)
    proposals = store.state(mid)["proposals"]
    assert proposals and "dismiss_detection" not in _kinds(proposals)
    for p in proposals:
        assert not CLEAR.search(" ".join(filter(None, [p.summary, p.reason, p.briefing])))
    assert any(e.kind == "proposal" for e in store.trace_entries(mid))


# --- briefings ---------------------------------------------------------------------------------


FACTS = {"team": "Team Two", "sector": "B3", "daylight_left": "2 h 40 min"}


@pytest.mark.parametrize(
    "text,problem",
    [
        ("Team Two, search sector B3; 2 h 40 min of daylight left.", None),
        ("Team Two, sector B3 is clear.", "clear"),
        ("Team Two, sector B3, 3 h of daylight left.", "numbers not in the facts"),
        ("word " * 61, "more than 60 words"),
        # live, from Nemotron: read aloud, this is one breathless line
        (
            "Team Two sector B3 photo shows adult hiker in blue jacket dark head covering sitting",
            "no punctuation",
        ),
        ("Team Two, search sector B3.", None),  # short and punctuated
        # live, from Nemotron, on a confirmed sighting: never tell teams to stop
        (
            "Team, a person was seen in sector B3. No further action is needed.",
            "tells the team to stop",
        ),
    ],
)
def test_check_briefing(text: str, problem: str | None) -> None:
    problems = loop.check_briefing(text, FACTS)
    assert (problems == []) if problem is None else any(problem in x for x in problems)


def test_bad_briefings_are_retried_then_replaced_by_the_template() -> None:
    client = FakeChatClient({"Facts:": "Team Two: sector B3 is cleared, 5 h left."})
    text = loop.write_briefing(FACTS, client)
    assert len(client.calls) == 2  # one retry
    assert text == loop.template_briefing(FACTS) and loop.check_briefing(text, FACTS) == []

    fixed = FakeChatClient({"Facts:": ["Sector B3 is cleared.", "Team Two, search sector B3."]})
    assert loop.write_briefing(FACTS, fixed) == "Team Two, search sector B3."


def test_a_run_on_briefing_is_rewritten_as_sentences() -> None:
    client = FakeChatClient(
        {
            "Facts:": [
                "Team Two sector B3 search it now daylight two h forty min left go",
                "Team Two, search sector B3. 2 h 40 min of daylight left.",
            ]
        }
    )
    assert (
        loop.write_briefing(FACTS, client)
        == "Team Two, search sector B3. 2 h 40 min of daylight left."
    )
    assert "read aloud" in client.calls[1]["messages"][-1]["content"]


def test_every_briefing_model_call_is_in_the_trace() -> None:
    """Found in the live end-to-end run: only the verifier's calls were traced."""
    store = FakeMissionStore()
    mid = store.create("m", "a", LatLon(lat=0, lon=0), "live").mission_id
    client = FakeChatClient({"Facts:": ["Sector B3 is clear.", "Team Two, search sector B3."]})
    assert (
        loop.write_briefing(FACTS, client, store, mid, ("T2", "B3"))
        == "Team Two, search sector B3."
    )
    calls = [e for e in store.trace_entries(mid) if e.kind == "model_call"]
    assert [e.summary for e in calls] == ['briefing rejected: says "clear"', "briefing"]
    assert (
        calls[0].input == {"facts": FACTS}
        and calls[0].refs == ["T2", "B3"]
        and calls[0].tokens_in is not None
    )


def test_briefing_without_a_model_is_the_template() -> None:
    assert loop.write_briefing(FACTS, None) == loop.template_briefing(FACTS)


# --- budget ------------------------------------------------------------------------------------


def test_budget_stops_model_calls_and_notes_it_once() -> None:
    notes = []
    base = FakeChatClient(default=ChatResult("ok", [], "m", 1, 600, 500))
    client = BudgetClient(base, 2000, threading.Semaphore(4), lambda: notes.append(1))
    client.chat([{"role": "user", "content": "a"}], model="m")
    client.chat([{"role": "user", "content": "a"}], model="m")  # 2200 used: over
    with pytest.raises(BudgetExceeded):
        client.chat([{"role": "user", "content": "a"}], model="m")
    assert notes == [1] and len(base.calls) == 2
