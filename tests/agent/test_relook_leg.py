"""The uncertainty-driven re-look leg (``sightline/agent/relook_leg.py``) and the "did the
observation help" ledger (``sightline/agent/ledger.py``), against the fake store. No network."""

from __future__ import annotations

import json

import cv2
import numpy as np
import pytest

from sightline.agent import ledger, loop, relook_leg
from sightline.agent.llm import FakeChatClient
from sightline.contract import Detection, Frame, LatLon, MapUpdate, Pose, Source
from tests.agent.test_loop import (  # noqa: F401 - mission is a fixture
    YES,
    _client,
    _conditions,
    _handle,
    mission,
)


@pytest.fixture
def world(request):
    """test_loop's ``mission``: B3 holds the probability, D1 idle, D2 flying, frame f0001."""
    return request.getfixturevalue("mission")


UNCLEAR = json.dumps(
    {
        "person": "unclear",
        "posture": "unknown",
        "group_size": None,
        "clothing": None,
        "reason": "A small dark shape; no head or limbs can be made out.",
    }
)


def _small(store, mid, b3, det_id: str = "f0001-d03", conf: float = 0.2) -> str:
    """A 21 px near-miss in the frame (no original: frame pixels are the photo's)."""
    d = Detection(id=det_id, box_px=(200, 200, 212, 221), conf=conf, crop=None, lat=b3.lat,
                  lon=b3.lon, radius_m=10)  # fmt: skip
    store.append_detections(mid, "f0001", [d], {})
    return det_id


def _relook_photo(store, mid, at: LatLon, n: int = 2, alt: float = 25.0, conf: float = 0.22) -> str:
    """Photo ``f000n`` taken at ``alt`` over ``at`` with one detection (42 px) there."""
    fid = f"f{n:04d}"
    corners = ((at.lon - 1e-4, at.lat + 1e-4), (at.lon + 1e-4, at.lat + 1e-4),
               (at.lon + 1e-4, at.lat - 1e-4), (at.lon - 1e-4, at.lat - 1e-4))  # fmt: skip
    frame = Frame(id=fid, file=f"frames/{fid}.jpg", width_px=1000, height_px=750,
                  flight_index=n - 1, source=Source(image=f"SIM_D1_{n:04d}.jpg", x0=0, y0=0),
                  pose=Pose(lat=at.lat, lon=at.lon, alt_agl_m=alt, heading_deg=0, gsd_m=0.01),
                  footprint=corners, score=0.5, rank=n, n_candidates=1)  # fmt: skip
    img = np.random.default_rng(n).integers(0, 255, (750, 1000, 3), dtype=np.uint8)
    store.append_frame(mid, frame, cv2.imencode(".jpg", img)[1].tobytes())
    det = Detection(id=f"{fid}-d01", box_px=(480, 340, 500, 382), conf=conf, crop=None,
                    lat=at.lat, lon=at.lon, radius_m=5)  # fmt: skip
    store.append_detections(mid, fid, [det], {})
    return det.id


def _notes(store, mid, type_: str) -> list[dict]:
    return [e.output for e in store.trace_entries(mid) if (e.output or {}).get("type") == type_]


def test_an_unclear_small_near_miss_proposes_a_low_pass(world) -> None:
    store, mid, b3 = world
    det = _small(store, mid, b3)
    (p,) = _handle(store, mid, "detection", det, _client(verdict=UNCLEAR))
    assert p.kind == "drone_leg" and p.status == "pending"  # an approval like any other
    assert p.target == {"drone": "D1", "leg": p.leg.id, "relook": det}  # D1 is idle
    assert p.leg.altitude_m == relook_leg.RELOOK_ALT_M == 25.0
    assert p.leg.sector_id == "B3" and p.leg.waypoints[0] == pytest.approx((b3.lon, b3.lat))
    assert "box 21 px, too small to verify" in p.reason
    assert "a pass at 25 m gives about 4× the pixels (50 m → 25 m)" in p.reason
    assert {e.kind for e in p.evidence} >= {"crop", "trace", "leg"}
    chain = relook_leg.chain_id_for(det)
    steps = relook_leg.chains(store, mid)[chain]
    assert [s["step"] for s in steps] == ["unclear", "leg"]
    assert steps[1]["pixel_factor"] == 4.0 and steps[1]["proposal"] == p.id
    (look,) = _notes(store, mid, "ledger")
    assert look["kind"] == "second_look" and look["chain_id"] == chain
    assert look["expected"]["gain"] == pytest.approx(37 / 75, abs=1e-4)
    assert look["realised"]["gain"] == 0.0 and look["delta"] == pytest.approx(-37 / 75, abs=1e-4)
    assert look["expected"]["cell_p"] == look["realised"]["cell_p"]  # a verdict moves no mass
    assert look["expected"]["sector"]["id"] == "B3"
    assert "expected_clearance" in look["expected"]["sector"]
    proposal = next(e for e in store.trace_entries(mid) if e.kind == "proposal")
    assert chain in proposal.refs and proposal.output["ledger_expected"]["region"]["radius_m"] == 10


def test_no_low_pass_for_a_failed_model_a_big_box_a_yes_or_a_queue_item(world) -> None:
    store, mid, b3 = world
    det = _small(store, mid, b3)
    broken = FakeChatClient({"Is there a person": "not json"})
    assert (
        _handle(store, mid, "detection", det, broken) == []
    )  # "No second look": flying won't help
    assert _handle(store, mid, "detection", "f0001-d02", _client(verdict=UNCLEAR)) == []  # 60 px
    det2 = _small(store, mid, b3, "f0001-d04")
    assert [p.kind for p in _handle(store, mid, "detection", det2, _client())] == [
        "promote_detection"
    ]
    det3 = _small(store, mid, b3, "f0001-d05", conf=0.5)  # in the queue: the reviewer looks
    assert _handle(store, mid, "detection", det3, _client(verdict=UNCLEAR)) == []
    assert len(_notes(store, mid, "ledger")) == 4  # every second look has its record


def test_a_reviewers_unsure_on_a_small_box_also_gets_the_low_pass(world) -> None:
    store, mid, b3 = world
    det = _small(store, mid, b3, conf=0.5)
    (p,) = _handle(store, mid, "review", det, _client(verdict=UNCLEAR), answer="unsure")
    assert p.target["relook"] == det


def test_no_low_pass_when_not_flyable_and_the_trace_says_why(world) -> None:
    store, mid, b3 = world
    store.put_conditions(mid, _conditions(flyable=False))
    det = _small(store, mid, b3)
    assert _handle(store, mid, "detection", det, _client(verdict=UNCLEAR)) == []
    steps = relook_leg.chains(store, mid)[relook_leg.chain_id_for(det)]
    assert [s["step"] for s in steps] == ["unclear", "skipped"]
    assert "not flyable" in steps[1]["why"]


def test_the_relook_photo_closes_the_chain_with_a_verdict_and_a_promotion(world) -> None:
    store, mid, b3 = world
    det = _small(store, mid, b3)
    client = FakeChatClient({"Is there a person": [UNCLEAR, YES]})
    (p,) = _handle(store, mid, "detection", det, client)
    store.decide_proposal(mid, p.id, "approve", by="Search manager")
    new = _relook_photo(store, mid, b3)
    out = _handle(store, mid, "detection", new, client)
    assert [x.kind for x in out] == ["promote_detection"] and out[0].target == {"detection": new}
    chain = relook_leg.chain_id_for(det)
    steps = relook_leg.chains(store, mid)[chain]
    assert [s["step"] for s in steps] == ["unclear", "leg", "photo", "verdict", "outcome"]
    assert steps[2]["frame"] == "f0002" and steps[2]["altitude_m"] == 25.0
    assert steps[2]["box_long_px"] == 42
    assert steps[4]["outcome"] == "resolved" and steps[4]["proposals"] == [out[0].id]
    looks = [r for r in _notes(store, mid, "ledger") if r["kind"] == "second_look"]
    assert [r["chain_id"] for r in looks] == [chain, chain]
    assert [r["realised"]["gain"] for r in looks] == [0.0, 1.0]
    # a re-look photo is never re-looked again, even when still unclear
    again = _relook_photo(store, mid, b3, n=3)
    assert _handle(store, mid, "detection", again, _client(verdict=UNCLEAR)) == []
    assert relook_leg.chains(store, mid)[chain][-1]["outcome"] == "unclear"


def test_a_relook_leg_with_no_detection_says_so_and_has_a_ledger_record(world) -> None:
    store, mid, b3 = world
    det = _small(store, mid, b3)
    (p,) = _handle(store, mid, "detection", det, _client(verdict=UNCLEAR))
    store.decide_proposal(mid, p.id, "approve", by="Search manager")
    fid = _relook_photo(store, mid, b3).split("-")[0]
    store._get(mid).detections[fid] = []  # nothing seen this time
    live = store.live(mid)
    cells = [(int(i), 0.8) for i in ledger._region_cells(live.base.grid, None, p.leg,
                                                         {"lat": b3.lat, "lon": b3.lon,
                                                          "radius_m": 10})]  # fmt: skip
    u = MapUpdate(seq=1, kind="step", source="frame", ref=fid, cells=cells, at="t")
    store.append_map_update(mid, u)
    live.apply(u)
    leg = store.state(mid)["fleet"].legs[-1].model_copy(update={"status": "done"})
    relook_leg.on_leg_done(store, mid, leg)
    chain = relook_leg.chain_id_for(det)
    steps = relook_leg.chains(store, mid)[chain]
    assert [s["step"] for s in steps][-2:] == ["photo", "outcome"]
    assert steps[-1]["outcome"] == "not_redetected" and steps[-1]["photos"] == 1
    (rec,) = [r for r in _notes(store, mid, "ledger") if r["kind"] == "leg"]
    assert rec["chain_id"] == chain and rec["realised"]["photos"] == 1
    # every cell of the region had POD 0.8; the expected side used the planner's POD
    p0 = rec["expected"]["gain"] / 0.432  # recall 0.864 x (1 - unknown canopy 0.5)
    assert rec["realised"]["gain"] == pytest.approx(0.8 * p0, rel=1e-3)
    assert rec["delta"] == pytest.approx(rec["realised"]["gain"] - rec["expected"]["gain"])


def test_replans_leave_a_drone_with_a_pending_relook_alone(world) -> None:
    store, mid, b3 = world
    det = _small(store, mid, b3)
    (p,) = _handle(store, mid, "detection", det, _client(verdict=UNCLEAR))
    out = loop._replan(store, mid, "test", idle_only=False)
    assert all(x.leg.drone_id != "D1" for x in out)
    assert store.state(mid)["proposals"][0].id == p.id
    assert store.state(mid)["proposals"][0].status == "pending"
    assert loop._replan(store, mid, "test", drone_id="D1") == []


def test_every_planner_leg_proposal_keeps_its_expected_side(world) -> None:
    store, mid, _ = world
    out = loop._replan(store, mid, "test", idle_only=True)
    assert out
    e = next(e for e in store.trace_entries(mid) if e.kind == "proposal")
    exp = e.output["ledger_expected"]
    assert (
        exp["gain"] == out[0].leg.expected_clearance and exp["sector"]["id"] == out[0].leg.sector_id
    )
    assert exp["region"] is None and "map_seq" in exp


def test_summarise_gives_means_and_a_correlation() -> None:
    recs = [
        {"kind": "leg", "expected": {"gain": e}, "realised": {"gain": g}}
        for e, g in ((0.1, 0.2), (0.2, 0.35), (0.3, 0.5))
    ]
    s = ledger.summarise(recs)["leg"]
    assert s["n"] == 3 and s["mean_expected"] == pytest.approx(0.2)
    assert s["mean_realised"] == pytest.approx(0.35) and s["corr"] == pytest.approx(1.0)
    assert ledger.summarise([])["second_look"]["corr"] is None
