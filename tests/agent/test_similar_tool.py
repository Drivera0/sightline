"""``find_similar`` (sightline/agent/similar_tool.py): after a confirmed sighting, proposals to review
the flight's most similar crops; traced tool_call → proposal; proposals, never promotions. No
network: the embedder is a fake keyed on crop bytes."""

from __future__ import annotations

import re

import numpy as np
import pytest

from sightline.agent import similar_tool
from sightline.contract import LatLon
from sightline.mission import effects
from sightline.ml import similar
from tests.agent.fake_store import FakeMissionStore
from tests.ml.test_similar import TagEmbedder, _det, _frame, _jpeg

RED, NEAR_RED, ROCK = [1.0, 0.0, 0.0], [0.95, 0.3, 0.0], [0.0, 1.0, 0.0]
CLEAR = re.compile(r"\bclear(s|ed|ing)?\b|\brule out\b", re.IGNORECASE)
WHY = "a reviewer confirmed detection f0001-d01 as a person"


def _add_det(store, mid, did: str, conf: float, tag: bytes) -> None:
    """A review crop (``crop``) at 0.29 and over, else D's near-miss crop (contract §7)."""
    queued = conf >= 0.29
    rel = f"crops/{did}.jpg" if queued else f"crops/nearmiss/{did}.jpg"
    store.append_detections(mid, did[:5], [_det(did, conf, rel if queued else None)], {rel: tag})


@pytest.fixture
def flight():
    """f0001-d01 is the confirmed person. Like it: f0002-d02 (near-miss), f0002-d01 (already in
    the queue), f0003-d02 (near-miss a reviewer answered). Not like it: f0003-d01, a rock."""
    store = FakeMissionStore()
    mid = store.create("m", "a", LatLon(lat=49.37, lon=-122.94), "live").mission_id
    crops = {
        "f0001-d01": (0.7, b"red"),
        "f0002-d01": (0.5, b"red"),
        "f0002-d02": (0.2, b"near-red"),
        "f0003-d01": (0.22, b"rock"),
        "f0003-d02": (0.19, b"red"),
    }
    for fid in ("f0001", "f0002", "f0003"):
        store.append_frame(mid, _frame(fid), _jpeg((0, 90, 0), (1000, 750)))
        for d, (c, b) in crops.items():
            if d.startswith(fid):
                _add_det(store, mid, d, c, b)
    store.emit(mid, "mission.note", "review f0003-d02: not_person", ref="f0003-d02",
               data={"answer": "not_person"})  # fmt: skip
    emb = TagEmbedder({b"red": RED, b"near-red": NEAR_RED, b"rock": ROCK})
    return store, mid, emb


def test_a_confirmed_sighting_proposes_review_of_the_near_misses_like_it(flight) -> None:
    store, mid, emb = flight
    (p,) = similar_tool.find_similar(store, mid, "f0001-d01", emb, why=WHY)
    assert p.kind == "promote_detection" and p.status == "pending" and p.created_by == "agent"
    assert p.target == {"detection": "f0002-d02", "like": "f0001-d01"}
    assert p.summary.startswith("Review f0002-d02: looks like confirmed f0001-d01 (similarity 0.95")
    assert "below the review threshold 0.29" in p.reason and p.reason.startswith("A reviewer")
    assert [e.ref for e in p.evidence] == ["crops/nearmiss/f0002-d02.jpg", "crops/f0001-d01.jpg"]

    trace = store.trace_entries(mid)
    call, prop = trace[-2], trace[-1]
    assert (call.actor, call.kind, prop.kind) == ("agent", "tool_call", "proposal")
    assert call.summary == (
        f"find_similar: review 1 photo like f0001-d01 (similarity ≥ {similar_tool.THRESHOLD:.2f})"
        "; 1 more already in the review queue"
    )
    actions = {m["detection"]: m["action"] for m in call.output["matches"]}
    assert actions == {"f0002-d02": "propose", "f0002-d01": "in the review queue"}
    assert "f0003-d02" in call.input["excluded"]["reviewed"]  # a reviewer already answered it
    assert call.output["indexed"] == 5 and call.output["embedded_now"] == 5
    assert "similar-f0001-d01" in call.refs and "similar-f0001-d01" in prop.refs

    note = next(e for e in store.events(mid) if "like confirmed" in e.summary)
    assert note.type == "mission.note" and "f0002-d01 (1.00)" in note.summary
    texts = [p.summary, p.reason, call.summary, note.summary]
    assert not any(CLEAR.search(t) for t in texts)


def test_proposals_are_capped_and_never_promote_anything(flight) -> None:
    store, mid, emb = flight
    for i, conf in enumerate((0.18, 0.17, 0.165), 3):  # three more red near-misses
        _add_det(store, mid, f"f0003-d{i:02d}", conf, b"red")
    out = similar_tool.find_similar(store, mid, "f0001-d01", emb, why=WHY)
    assert len(out) == similar_tool.MAX_PROPOSALS == 3
    assert all(p.status == "pending" for p in store.state(mid)["proposals"])
    assert not [
        e for e in store.events(mid) if e.type == "detection.new" and "promoted" in e.summary
    ]
    call = next(e for e in store.trace_entries(mid) if e.kind == "tool_call")
    # 5 matches (k): f0002-d01 in the queue, 4 near-misses of which 3 are proposed
    assert [m["action"] for m in call.output["matches"]].count("over the proposal cap") == 1


def test_approval_takes_the_normal_path_to_the_review_queue(flight) -> None:
    store, mid, emb = flight
    (p,) = similar_tool.find_similar(store, mid, "f0001-d01", emb, why=WHY)
    decided = store.decide_proposal(mid, p.id, "approve", by="Search manager")
    effects.on_decision(store, mid, decided)
    ev = store.events(mid)[-1]
    assert ev.type == "detection.new" and ev.ref == "f0002-d02"
    assert ev.data["promoted_by"] == p.id


def test_once_per_detection_and_nothing_without_an_embedder(flight) -> None:
    store, mid, emb = flight
    assert similar_tool.find_similar(store, mid, "f0001-d01", None, why=WHY) == []
    assert store.trace_entries(mid) == []
    assert len(similar_tool.find_similar(store, mid, "f0001-d01", emb, why=WHY)) == 1
    n = len(store.trace_entries(mid))
    assert similar_tool.find_similar(store, mid, "f0001-d01", emb, why=WHY) == []
    assert len(store.trace_entries(mid)) == n


def test_a_failing_endpoint_is_a_trace_note_and_no_proposal(flight) -> None:
    store, mid, _ = flight

    class Down:
        model = "fake/down"

        def embed_images(self, images):
            raise similar.EmbedError("fake/down: HTTP 0: ReadTimeout")

        def embed_text(self, text):
            raise AssertionError

    assert similar_tool.find_similar(store, mid, "f0001-d01", Down(), why=WHY) == []
    (note,) = store.trace_entries(mid)
    assert note.kind == "note" and "ReadTimeout" in note.summary
    assert store.state(mid)["proposals"] == []


def test_nothing_above_the_threshold_proposes_nothing(flight) -> None:
    store, mid, emb = flight
    assert np.isclose(similar.unit(np.array(ROCK)) @ similar.unit(np.array(RED)), 0.0)
    assert similar_tool.find_similar(store, mid, "f0003-d01", emb, why=WHY) == []  # the rock
    call = store.trace_entries(mid)[-1]
    assert call.kind == "tool_call" and call.output["matches"] == []
    assert call.summary.startswith("find_similar: review 0 photos like f0003-d01")
