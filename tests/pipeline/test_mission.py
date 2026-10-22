"""MissionStore and validate_mission (contract §12–§14, LANE_D §6 tests 2–3, D-M0)."""

from __future__ import annotations

import asyncio
import json
import threading
from pathlib import Path

import numpy as np
import pytest

from sightline.contract import (
    Clue,
    Detection,
    Distribution,
    Drone,
    EvidenceRef,
    FleetState,
    FleetTelemetry,
    Frame,
    Grid,
    LatLon,
    Leg,
    MapBase,
    MapUpdate,
    Params,
    Pose,
    Proposal,
    SectorTask,
    Source,
    Team,
    TraceEntry,
)
from sightline.mission import MissionStore, validate_mission

AT = "2026-10-24T21:40:00Z"
ROWS = COLS = 4


def _base() -> MapBase:
    n = ROWS * COLS
    return MapBase(
        contract_version="1.2",
        grid=Grid(origin_nw=LatLon(lat=49.38, lon=-122.95), cell_m=5.0, rows=ROWS, cols=COLS),
        lkp=LatLon(lat=49.379, lon=-122.949),
        params=Params(recall=0.864, recall_source="test", pod_cap=0.95, review_pod=0.9),
        prior=Distribution(p=[0.9 / n] * n, outside=0.1),
        canopy=[None] * n,
    )


def _step(cells: list[tuple[int, float]], ref: str = "f0001") -> MapUpdate:
    return MapUpdate(seq=1, kind="step", source="frame", ref=ref, cells=cells, at=AT)


def _frame(i: int) -> Frame:
    return Frame(
        id=f"f{i + 1:04d}",
        file=f"frames/f{i + 1:04d}.jpg",
        width_px=1000,
        height_px=750,
        flight_index=i,
        source=Source(image=f"DJI_{i}.JPG", x0=0, y0=0),
        pose=Pose(lat=49.379, lon=-122.949, alt_agl_m=50, heading_deg=0, gsd_m=0.02),
        footprint=((-122.95, 49.38), (-122.94, 49.38), (-122.94, 49.37), (-122.95, 49.37)),
        score=0.5,
        rank=i + 1,
        n_candidates=0,
    )


def _proposal(**over) -> Proposal:
    fields = {
        "id": "",
        "kind": "assign_sector",
        "summary": "Assign sector B3 to Team Two",
        "reason": "highest probability",
        "briefing": "New assignment, sector Bravo Three.",
        "target": {"team": "T2", "sector": "B3"},
        "evidence": [],
        "status": "pending",
        "created_by": "agent",
        "created_at": AT,
        "decided_at": None,
        "decided_by": None,
        "decision_reason": None,
        "edits": None,
    }
    return Proposal(**{**fields, **over})


def _leg(lid: str = "L001", status: str = "proposed") -> Leg:
    return Leg(
        id=lid,
        drone_id="D1",
        sector_id="B3",
        waypoints=[(-122.95, 49.38)],
        altitude_m=50,
        est_minutes=8,
        expected_clearance=0.1,
        score_per_min=0.01,
        reason="test",
        status=status,
    )


def _fleet() -> FleetState:
    drone = Drone(
        id="D1",
        name="Drone 1",
        simulated=True,
        position=None,
        altitude_m=50,
        speed_ms=8,
        battery_pct=90,
        max_wind_kmh=38,
        status="idle",
        leg_id=None,
    )
    return FleetState(simulated=True, drones=[drone], legs=[], updated_at=AT)


@pytest.fixture
def store(tmp_path: Path) -> MissionStore:
    return MissionStore(tmp_path / "missions")


@pytest.fixture
def mid(store: MissionStore) -> str:
    """A small, valid mission with something in every file."""
    m = store.create(
        "Seymour — missing hiker", "Mount Seymour", LatLon(lat=49.379, lon=-122.949), "live"
    )
    store.put_map_base(m.mission_id, _base())
    store.append_map_update(m.mission_id, _step([(0, 0.5), (1, 0.4)]))
    store.append_frame(m.mission_id, _frame(0), b"jpeg")
    det = Detection(
        id="f0001-d01",
        box_px=(1, 1, 9, 9),
        conf=0.8,
        crop="crops/f0001-d01.jpg",
        lat=49.379,
        lon=-122.949,
        radius_m=10,
    )
    store.append_detections(m.mission_id, "f0001", [det], {"crops/f0001-d01.jpg": b"crop"})
    store.upsert_team(
        m.mission_id,
        Team(
            id="T2",
            callsign="Team Two",
            members=3,
            status="standby",
            position=None,
            position_at=None,
            note=None,
        ),
    )
    store.upsert_task(
        m.mission_id,
        SectorTask(
            sector_id="B3", state="proposed", team_id=None, poa=0.2, note=None, updated_at=AT
        ),
    )
    store.put_fleet(m.mission_id, _fleet())
    p = store.add_proposal(m.mission_id, _proposal())
    store.decide_proposal(m.mission_id, p.id, "approve", by="Search manager")
    turn = TraceEntry(
        id="",
        at=AT,
        actor="radio",
        kind="radio_turn",
        summary="affirmative",
        input=None,
        output={"id": "r0003", "direction": "in", "state": "committed", "actions": ["post_clue"]},
        model=None,
        ms=None,
        tokens_in=None,
        tokens_out=None,
        refs=[],
    )
    store.trace(m.mission_id, turn)
    store.add_clue(
        m.mission_id,
        Clue(
            id="",
            kind="object",
            text="blue backpack",
            lat=49.379,
            lon=-122.949,
            radius_m=25,
            reported_by="T2",
            source="radio",
            confirmed_by_turn="r0003",
            at=AT,
            confirmed=False,
        ),
    )
    return m.mission_id


# --- the store ------------------------------------------------------------------------------


def test_a_full_mission_is_valid_and_reads_back(store: MissionStore, mid: str) -> None:
    assert validate_mission(store.root, mid) == []
    s = store.state(mid)
    assert s["mission"].name == "Seymour — missing hiker"
    assert [p.id for p in s["proposals"]] == ["p001"] and s["proposals"][0].status == "approved"
    assert s["clues"][0].id == "c001" and s["clues"][0].confirmed
    assert store.survey(mid).frames[0].id == "f0001"
    assert store.read_file(mid, "frames/f0001.jpg") == b"jpeg"
    det, frame = store.get_detection(mid, "f0001-d01")
    assert det.conf == 0.8 and frame.id == "f0001"
    types = [e.type for e in store.events(mid)]
    assert types[:2] == ["map.updated", "detection.new"] and "clue.added" in types
    ids = [e.id for e in store.events(mid)]
    assert ids == [f"e{i:05d}" for i in range(1, len(ids) + 1)]


def test_files_are_written_atomically_as_json(store: MissionStore, mid: str) -> None:
    d = store.root / mid
    for name in ("mission.json", "proposals.json", "tasks.json", "fleet.json"):
        json.loads((d / name).read_text())
    assert not list(d.glob(".*.tmp")) and not list(d.glob("*.tmp"))


def test_ids_are_kind_prefixed_and_zero_padded(store: MissionStore, mid: str) -> None:
    assert [store.next_id(mid, k) for k in ("p", "v", "L", "t")] == [
        "p002",
        "v0001",
        "L001",
        "t000002",
    ]


def test_radio_clue_needs_a_readback(store: MissionStore, mid: str) -> None:
    with pytest.raises(ValueError, match="confirmed_by_turn"):
        store.add_clue(
            mid,
            Clue(
                id="",
                kind="object",
                text="x",
                lat=49.379,
                lon=-122.949,
                radius_m=25,
                reported_by="T2",
                source="radio",
                at=AT,
                confirmed=False,
            ),
        )


def test_edits_are_applied_before_the_decision(store: MissionStore, mid: str) -> None:
    p = store.add_proposal(mid, _proposal())
    out = store.decide_proposal(
        mid, p.id, "approve", by="SM", edits={"briefing": "Edited.", "team": "T3"}
    )
    assert out.briefing == "Edited." and out.target["team"] == "T3"
    with pytest.raises(ValueError, match="not pending"):
        store.decide_proposal(mid, p.id, "reject", by="SM")


def test_an_approved_leg_enters_the_fleet_and_a_retask_cancels_the_old_one(
    store: MissionStore, mid: str
) -> None:
    p1 = store.add_proposal(
        mid,
        _proposal(
            kind="drone_leg",
            target={"drone": "D1", "leg": "L001"},
            leg=_leg("L001"),
            evidence=[EvidenceRef(kind="leg", ref="L001", caption="")],
        ),
    )
    store.decide_proposal(mid, p1.id, "approve", by="SM")
    fleet = store.state(mid)["fleet"]
    assert [(x.id, x.status) for x in fleet.legs] == [("L001", "approved")]
    assert fleet.drones[0].leg_id == "L001"
    p2 = store.add_proposal(
        mid, _proposal(kind="retask_drone", target={"drone": "D1", "leg": "L002"}, leg=_leg("L002"))
    )
    store.decide_proposal(mid, p2.id, "approve", by="SM")
    fleet = store.state(mid)["fleet"]
    assert [(x.id, x.status) for x in fleet.legs] == [("L001", "cancelled"), ("L002", "approved")]
    assert validate_mission(store.root, mid) == []


def test_telemetry_moves_legs_forward_only(store: MissionStore, mid: str) -> None:
    p = store.add_proposal(
        mid, _proposal(kind="drone_leg", target={"drone": "D1", "leg": "L001"}, leg=_leg())
    )
    store.decide_proposal(mid, p.id, "approve", by="SM")
    drones = store.state(mid)["fleet"].drones
    _, done = store.merge_telemetry(
        mid, FleetTelemetry(drones=drones, leg_status={"L001": "done"}, at=AT)
    )
    assert done == ["L001"]
    fleet, done = store.merge_telemetry(
        mid, FleetTelemetry(drones=drones, leg_status={"L001": "flying"}, at=AT)
    )
    assert done == [] and fleet.legs[0].status == "done" and fleet.drones[0].leg_id == "L001"


@pytest.mark.parametrize("bad", ["/etc/passwd", "../other/x.jpg", "proposals.json", ".lock", ""])
def test_files_stay_inside_the_mission(store: MissionStore, mid: str, bad: str) -> None:
    with pytest.raises(ValueError):
        store.put_file(mid, bad, b"x")


def test_unknown_mission(store: MissionStore) -> None:
    with pytest.raises(KeyError):
        store.get("deadbeef")
    with pytest.raises(KeyError):
        store.get("../../etc")


def test_subscribe_replays_after_an_id_then_streams_new_events(
    store: MissionStore, mid: str
) -> None:
    first = store.events(mid)[1].id

    async def run() -> list[str]:
        got: list[str] = []
        agen = store.subscribe(mid, after_event_id=first)
        total = len(store.events(mid)) - 2  # the replayed ones
        async for ev in agen:
            got.append(ev.id)
            if len(got) == total:
                # a new event from another thread arrives through the queue
                threading.Thread(target=store.emit, args=(mid, "mission.note", "hello")).start()
            if ev.type == "mission.note":
                break
        await agen.aclose()
        return got

    got = asyncio.run(asyncio.wait_for(run(), 5))
    ids = [e.id for e in store.events(mid)]
    assert got == ids[2:]


# --- test 3: concurrency and restart ----------------------------------------------------------


def test_concurrent_appends_keep_seq_contiguous(store: MissionStore, mid: str) -> None:
    def work(k: int) -> None:
        for j in range(10):
            store.append_map_update(mid, _step([(4 + k, 0.1)], ref=f"w{k}-{j}"))
            store.trace(
                mid,
                TraceEntry(
                    id="",
                    at=AT,
                    actor="pipeline",
                    kind="note",
                    summary=f"{k}-{j}",
                    input=None,
                    output=None,
                    model=None,
                    ms=None,
                    tokens_in=None,
                    tokens_out=None,
                    refs=[],
                ),
            )

    threads = [threading.Thread(target=work, args=(k,)) for k in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert [u.seq for u in store.map_updates(mid)] == list(range(1, 42))
    trace_ids = [e.id for e in store.trace_entries(mid)]
    assert trace_ids == [f"t{i:06d}" for i in range(1, 42)]
    events = [e.id for e in store.events(mid)]
    assert events == [f"e{i:05d}" for i in range(1, len(events) + 1)]
    assert validate_mission(store.root, mid) == []


def test_a_restart_rebuilds_the_same_live_map(store: MissionStore, mid: str) -> None:
    live = store.live(mid)
    store.append_map_update(mid, _step([(5, 0.7), (6, 0.2)]))
    store.append_map_update(
        mid, MapUpdate(seq=1, kind="reweight", source="clue", ref="c001", cells=[(7, 3.0)], at=AT)
    )
    p, outside = live.p()
    assert abs(float(p.sum()) + outside - 1) < 1e-12
    again = MissionStore(store.root).live(mid)  # a new process: rebuilt from the files
    p2, outside2 = again.p()
    np.testing.assert_array_equal(p, p2)
    assert outside == outside2


# --- test 2: validate_mission catches each §12.3 violation -----------------------------------


def _edit_json(store: MissionStore, mid: str, name: str, fn) -> None:
    path = store.root / mid / name
    path.write_text(json.dumps(fn(json.loads(path.read_text()))))


def _edit_jsonl(store: MissionStore, mid: str, name: str, fn) -> None:
    path = store.root / mid / name
    rows = [json.loads(x) for x in path.read_text().splitlines()]
    path.write_text("".join(json.dumps(r) + "\n" for r in fn(rows)))


def _set(rows: list[dict], **kv) -> list[dict]:
    rows[0].update(kv)
    return rows


BREAKS = {
    "seq gap": ("map_updates.jsonl", lambda r: _set(r, seq=2), "no gaps"),
    "pod over the cap": ("map_updates.jsonl", lambda r: _set(r, cells=[[0, 0.99]]), "pod_cap"),
    "factor over 20": (
        "map_updates.jsonl",
        lambda r: _set(r, kind="reweight", cells=[[0, 25]]),
        "factor",
    ),
    "ground POD 0.95": ("tasks.json", lambda r: _set(r, state="searched", pod=0.95), "pod"),
    "searched without POD": ("tasks.json", lambda r: _set(r, state="searched"), "pod must be set"),
    "cleared in a reason": (
        "proposals.json",
        lambda r: _set(r, reason="Sector B3 is cleared"),
        "clear",
    ),
    "clears in a reason": (
        "proposals.json",
        lambda r: _set(r, reason="Team Two clears sector B3"),
        "clear",
    ),
    "clearing in a reason": (
        "proposals.json",
        lambda r: _set(r, reason="Clearing sector B3 next"),
        "clear",
    ),
    "decided without decided_at": (
        "proposals.json",
        lambda r: _set(r, decided_at=None),
        "decided_at",
    ),
    "pending with decided_at": (
        "proposals.json",
        lambda r: _set(r, status="pending"),
        "pending but",
    ),
    "unconfirmed radio clue": (
        "clues.json",
        lambda r: _set(r, confirmed_by_turn="r9999"),
        "readback",
    ),
    "truth key": ("detections.json", lambda d: {**d, "ground_truth": []}, "ground truth"),
    "a leg approved without a decision": (
        "fleet.json",
        lambda f: {**f, "legs": [_leg("L009", "approved").model_dump(mode="json")]},
        "without an approved proposal",
    ),
}


@pytest.mark.parametrize("case", list(BREAKS))
def test_validate_catches(store: MissionStore, mid: str, case: str) -> None:
    name, fn, words = BREAKS[case]
    (_edit_jsonl if name.endswith(".jsonl") else _edit_json)(store, mid, name, fn)
    problems = validate_mission(store.root, mid)
    assert any(words in p for p in problems), problems


def test_validate_catches_an_unapproved_transmission(store: MissionStore, mid: str) -> None:
    p = store.add_proposal(mid, _proposal())
    store.trace(
        mid,
        TraceEntry(
            id="",
            at=AT,
            actor="radio",
            kind="radio_turn",
            summary="transmit",
            input=None,
            output={
                "id": "r0004",
                "direction": "out",
                "state": "transmitted",
                "actions": [f"transmit {p.id}"],
            },
            model=None,
            ms=None,
            tokens_in=None,
            tokens_out=None,
            refs=[],
        ),
    )
    assert any("not approved" in x for x in validate_mission(store.root, mid))


def test_the_store_refuses_a_task_breaking_the_pod_rule(store: MissionStore, mid: str) -> None:
    """Found by the smoke test: a searched sector reassigned kept its POD."""
    bad = SectorTask(
        sector_id="B3", state="assigned", team_id="T2", poa=0.2, pod=0.5, note=None, updated_at=AT
    )
    with pytest.raises(ValueError, match="pod"):
        store.upsert_task(mid, bad)


def test_subscribe_sees_events_written_by_another_process(store: MissionStore, mid: str) -> None:
    """On AWS the worker is another container: its events reach the API's SSE through the file."""
    other = MissionStore(store.root)  # a second store on the same folder, like the worker's
    last = store.events(mid)[-1].id

    async def run() -> str:
        agen = store.subscribe(mid, after_event_id=last, poll_s=0.05)
        threading.Timer(0.2, lambda: other.emit(mid, "photo.processed", "from the worker")).start()
        async for ev in agen:
            await agen.aclose()
            return ev.summary
        return ""

    assert asyncio.run(asyncio.wait_for(run(), 5)) == "from the worker"
