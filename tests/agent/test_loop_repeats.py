"""A repeated event reuses the agent's pending proposal instead of making a duplicate
(docs/report/AGENT_EVAL.md, finding 2): a detection delivered twice is verified once and promoted
once; a person confirmed twice is alerted once. The repeat is a note in the trace."""

from __future__ import annotations

from tests.agent.test_loop import _client, _handle, mission  # noqa: F401 - the fixture


def _of(store, mid, kind: str):
    return [p for p in store.state(mid)["proposals"] if p.kind == kind]


def test_a_repeated_detection_is_verified_and_promoted_once(mission) -> None:  # noqa: F811
    store, mid, _ = mission
    (first,) = _handle(store, mid, "detection", "f0001-d02", _client())
    again = _handle(store, mid, "detection", "f0001-d02", _client())
    assert [p.id for p in again] == [first.id]
    assert len(_of(store, mid, "promote_detection")) == 1
    assert len(store.state(mid)["verdicts"]) == 1  # no second model call either
    assert any(
        e.kind == "note" and "repeat" in e.summary and first.id in e.refs
        for e in store.trace_entries(mid)
    )


def test_a_repeated_confirmation_alerts_once(mission) -> None:  # noqa: F811
    store, mid, _ = mission
    out = _handle(store, mid, "review", "f0001-d01", _client(), answer="person")
    alert = next(p for p in out if p.kind == "alert")
    again = _handle(store, mid, "review", "f0001-d01", _client(), answer="person")
    assert [p.id for p in again] == [alert.id]  # the team's assign_sector is pending: none new
    assert len(_of(store, mid, "alert")) == 1
    assert len(_of(store, mid, "assign_sector")) == 1
    assert any("repeat" in e.summary and alert.id in e.refs for e in store.trace_entries(mid))


def test_after_a_rejection_a_new_confirmation_proposes_again(mission) -> None:  # noqa: F811
    store, mid, _ = mission
    out = _handle(store, mid, "review", "f0001-d01", _client(), answer="person")
    alert = next(p for p in out if p.kind == "alert")
    store.decide_proposal(mid, alert.id, "reject", "manager", "wrong person")
    again = _handle(store, mid, "review", "f0001-d01", _client(), answer="person")
    assert [p.kind for p in again] == ["alert"] and again[0].id != alert.id
