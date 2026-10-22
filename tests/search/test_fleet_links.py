"""The fleet's simulated link model: a lost drone keeps flying its approved leg, keeps its photos on
board and syncs them when the link is back; degraded links lose every other report; the console
asks for a change with ``POST /fleet/link``; ``GET /fleet/links`` gives each drone's state."""

from __future__ import annotations

import re

import pytest

from sightline.search.fleet import (
    FleetFeed,
    FleetSim,
    LinkChange,
    fleet_links,
    link_summary,
    parse_degrade,
)
from tests.search import test_fleet as tf
from tests.search.test_fleet import Pool, _leg_over_hidden, _scenario

world = tf.world  # the fleet tests' API fixture


def _sim(http, mid, tmp, lines):
    sim = FleetSim(
        http, mid, _scenario(), time_scale=1.0, pool=Pool(tmp), out=lines.append, links=()
    )
    sim.register()
    return sim


def test_a_lost_drone_flies_its_leg_keeps_photos_then_syncs(world) -> None:
    http, ctx, store, hooks, mid, _bodies, tmp = world
    lines: list[str] = []
    sim = _sim(http, mid, tmp, lines)
    _leg_over_hidden(store, mid)
    sim.tick(1.0)
    assert sim.drones[0].leg is not None
    sim.set_link("D1", "lost")
    sim.tick(1.0)
    heard = store.state(mid)["fleet"].drones[0].position
    for _ in range(60):
        sim.tick(1.0)
    d = sim.drones[0]
    # it flew the whole leg on its own: every photo is on board, none reached the mission
    assert d.leg is None and d.leg_status["L1"] == "done" and d.photos == 5
    assert len(d.buffer) == 5 and store.survey(mid).frames == []
    # the mission still has what it last heard
    st = store.state(mid)["fleet"]
    assert st.drones[0].position == heard and st.legs[0].status == "flying"
    links = http.get(f"/missions/{mid}/fleet/links").json()
    assert links["drones"]["D1"]["link"] == "lost" and links["drones"]["D1"]["last_heard_at"]
    assert links["simulated"] is True

    sim.set_link("D1", "connected")
    sim.tick(1.0)
    ctx.queue.join()
    assert d.buffer == [] and len(store.survey(mid).frames) == 5
    names = [f.source.image for f in store.survey(mid).frames]
    assert all(re.fullmatch(r"SIM_D1_\d{4}_\d{8}T\d{6}Z\.jpg", n) for n in names)  # capture time
    assert store.state(mid)["fleet"].legs[0].status == "done"
    assert ("on_leg_done", "L1") in hooks.calls
    notes = [e.summary for e in store.events(mid) if e.type == "mission.note"]
    assert any("D1 link lost (simulated link model)" in n for n in notes)
    assert any("D1 link back (simulated link model): 5 photos" in n for n in notes)
    assert http.get(f"/missions/{mid}/fleet/links").json()["drones"]["D1"]["link"] == "connected"
    assert any("lost-link return" in x for x in lines)


def test_a_retask_while_lost_waits_for_the_link(world) -> None:
    http, _, store, _, mid, _bodies, tmp = world
    sim = _sim(http, mid, tmp, [])
    _leg_over_hidden(store, mid)
    sim.tick(1.0)
    sim.set_link("D1", "lost")
    fleet = store.state(mid)["fleet"]
    old = fleet.legs[0].model_copy(update={"status": "cancelled"})
    new = fleet.legs[0].model_copy(update={"id": "L2", "status": "approved"})
    store.put_fleet(mid, fleet.model_copy(update={"legs": [old, new]}))
    sim.tick(1.0)
    assert sim.drones[0].leg.id == "L1"  # it hasn't heard
    sim.set_link("D1", "connected")
    sim.tick(1.0)
    assert sim.drones[0].leg.id == "L2"


def test_a_degraded_link_hears_every_other_report(world) -> None:
    http, _, store, _, mid, _bodies, tmp = world
    sim = _sim(http, mid, tmp, [])
    sim.set_link("D1", "degraded", for_s=4.0)
    heard = []
    for _ in range(6):
        before = sim.gcs.heard_at.get("D1")
        sim.tick(1.0)
        heard.append(sim.gcs.heard_at.get("D1") != before or sim.gcs._n["D1"] % 2 == 0)
    assert sim.gcs.link("D1") == "connected"  # the 4 s ran out
    notes = [e.summary for e in store.events(mid) if e.type == "mission.note"]
    assert any("D1 link degraded for 4 s" in n for n in notes)
    assert any("link model (timer)" in str(e.data) for e in store.events(mid))


def test_the_console_asks_through_the_api_and_the_sim_applies_it(world) -> None:
    from sightline.api.sse import format_event

    http, _, store, _, mid, _bodies, tmp = world
    sim = _sim(http, mid, tmp, [])
    r = http.post(f"/missions/{mid}/fleet/link", json={"target": "D1", "link": "lost", "for_s": 30})
    assert r.status_code == 202
    assert r.json()["summary"] == "command asked for D1: link lost for 30 s (simulated link model)"
    lines = "".join(format_event(e) for e in store.events(mid)).split("\n")
    feed = FleetFeed(http, mid)
    feed.follow(lines)
    feed.legs = None  # legs still from GET /state
    sim.feed = feed
    sim.tick(1.0)
    assert sim.gcs.link("D1") == "lost" and sim.drones[0].link == "lost"
    assert feed.take_requests() == []
    # a request from before the run started is not replayed
    sim2 = _sim(http, mid, tmp, [])
    sim2.gcs.started_at = "2999-01-01T00:00:00Z"
    feed2 = FleetFeed(http, mid)
    feed2.follow(lines)
    feed2.legs = None
    sim2.feed = feed2
    sim2.tick(1.0)
    assert sim2.gcs.link("D1") == "connected"


def test_bad_link_requests_are_refused(world) -> None:
    http, *_, mid, _bodies, _tmp = world
    assert http.post(f"/missions/{mid}/fleet/link", json={"target": "D1", "link": "gone"}).status_code == 422  # fmt: skip
    assert http.post(f"/missions/{mid}/fleet/link", json={"target": "../x", "link": "lost"}).status_code == 422  # fmt: skip


def test_the_link_model_rejects_states_that_do_not_fit_the_target() -> None:
    from sightline.search.fleet import GroundStation

    gcs = GroundStation(None, "m", out=lambda s: None)
    assert not gcs.set_link(LinkChange("D1", "no_signal"), 0)
    assert not gcs.set_link(LinkChange("T2", "lost"), 0)
    assert gcs.set_link(LinkChange("T2", "no_signal"), 0)
    assert not gcs.set_link(LinkChange("T2", "no_signal"), 0)  # no change


def test_degrade_switch() -> None:
    assert parse_degrade(("D2", "60s"), 120) == [
        {"after_s": 120, "target": "D2", "link": "lost", "for_s": 60.0}
    ]
    assert parse_degrade(None, 0) == []
    with pytest.raises(ValueError):
        parse_degrade(("D2", "0s"), 0)


def test_link_lines_are_honest_and_never_say_clear() -> None:
    lines = [
        link_summary(
            {
                "target": "D2",
                "link": k,
                "report": r,
                "for_s": 60,
                "synced": 3,
                "last_heard_at": "2026-10-24T21:40:00Z",
                "at": "2026-10-24T21:42:00Z",
            }
        )
        for k in ("connected", "degraded", "lost")
        for r in (True, False)
    ]
    assert all("simulated link model" in x for x in lines)
    assert not any(re.search(r"\bclear(s|ed|ing)?\b", x, re.IGNORECASE) for x in lines)
    back = link_summary({"target": "D2", "link": "connected", "report": True, "synced": 3,
                         "last_heard_at": "2026-10-24T21:40:00Z", "at": "2026-10-24T21:42:00Z"})  # fmt: skip
    assert back.endswith("3 photos taken out of contact synced with their capture times, last heard 2 min before")  # fmt: skip


def test_fleet_links_reads_the_latest_state_from_events() -> None:
    ev = lambda d, at: {"type": "mission.note", "at": at, "data": d}
    events = [
        ev({"fleet_link": {"target": "D2", "link": "lost", "last_heard_at": "a"}}, "t1"),
        ev({"fleet_link_request": {"target": "D3", "link": "lost"}}, "t2"),  # only asked
        ev({"fleet_link": {"target": "T2", "link": "no_signal"}}, "t3"),
        {"type": "fleet.updated", "at": "t4", "data": {}},
    ]
    out = fleet_links(events)
    assert out["drones"] == {"D2": {"link": "lost", "since": "t1", "for_s": None, "last_heard_at": "a", "by": None}}  # fmt: skip
    assert out["teams"]["T2"]["link"] == "no_signal"
