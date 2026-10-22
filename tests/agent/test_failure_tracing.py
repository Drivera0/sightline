"""Failures that used to leave no trace (docs/report/AGENT_EVAL.md, finding 3) are now trace notes:
Token Factory retries (on the model call's entry, and in the failure note when every attempt failed),
Tavily being down (the conditions fall back), and a photo refused at upload."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import httpx
import openai
import pytest
from fastapi.testclient import TestClient

from sightline.agent import loop
from sightline.agent.llm import TokenFactoryClient, failure_text
from sightline.agent.trace import trace_call
from sightline.api.app import create_app
from sightline.api.missions import MissionContext
from sightline.contract import Area, LatLon
from sightline.mission import MissionStore
from sightline.mission.queue import LocalQueue
from tests.agent.fake_store import FakeMissionStore
from tests.fixtures.drone_photos import LKP, drone_photo

REQ = httpx.Request("POST", "https://token-factory.invalid/v1")


def _503() -> Exception:
    return openai.InternalServerError("503", response=httpx.Response(503, request=REQ), body=None)


class _Transport:
    """The ``openai`` SDK object: raises the scripted errors, then answers ``text``."""

    def __init__(self, errors: list[Exception], text: str = "Team One, search sector B3.") -> None:
        self.errors, self.text = list(errors), text
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self.create))

    def create(self, **kw):
        if self.errors:
            raise self.errors.pop(0)
        msg = SimpleNamespace(content=self.text, tool_calls=None)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=msg, finish_reason="stop")],
            usage=SimpleNamespace(prompt_tokens=3, completion_tokens=2),
            model=kw["model"],
        )


def _client(errors: list[Exception], **kw) -> TokenFactoryClient:
    return TokenFactoryClient("k", client=_Transport(errors, **kw), sleep=lambda s: None)


def _mission() -> tuple[FakeMissionStore, str]:
    store = FakeMissionStore()
    return store, store.create("t", "t", LatLon(**LKP), "live").mission_id


def test_retries_are_on_the_model_calls_trace_entry() -> None:
    r = _client([_503(), openai.APITimeoutError(request=REQ)]).chat(
        [{"role": "user", "content": "hi"}], model="m"
    )
    assert r.retries == ("HTTP 503", "timeout")
    store, mid = _mission()
    e = trace_call(store, mid, actor="agent", kind="model_call", summary="briefing", result=r)
    assert "after 2 retries (HTTP 503, timeout)" in e.summary
    assert e.output["retries"] == ["HTTP 503", "timeout"]


def test_a_call_that_never_succeeds_says_how_often_it_was_tried() -> None:
    with pytest.raises(openai.InternalServerError) as info:
        _client([_503()] * 4).chat([{"role": "user", "content": "hi"}], model="m")
    assert failure_text(info.value) == "InternalServerError after 4 attempts (HTTP 503 ×4)"
    store, mid = _mission()
    text = loop.write_briefing({"team": "Team One"}, _client([_503()] * 4), store, mid)
    assert text == loop.template_briefing({"team": "Team One"})
    (note,) = [e for e in store.trace_entries(mid) if e.kind == "note"]
    assert "InternalServerError after 4 attempts" in note.summary


def test_tavily_down_is_a_conditions_note(tmp_path: Path) -> None:
    from sightline.geo.conditions import fetch_conditions

    class Down:
        def search(self, q, **kw):
            raise ConnectionError("unreachable")

        def extract(self, urls, **kw):
            raise ConnectionError("unreachable")

    store, mid = _mission()
    c = fetch_conditions(
        Area(name="Mount Seymour", lkp=LatLon(**LKP)),
        fleet_max_wind_kmh=38,
        last_seen_at=None,
        cache_dir=tmp_path,
        tavily=Down(),
        store=store,
        mission_id=mid,
    )
    assert c.stale
    (note,) = [e for e in store.trace_entries(mid) if e.kind == "note"]
    assert note.actor == "conditions" and "Tavily" in note.summary
    assert "ConnectionError" in note.summary and "stale" in note.summary


def test_a_photo_refused_at_upload_is_in_the_trace(tmp_path: Path) -> None:
    store = MissionStore(tmp_path / "missions")
    ctx = MissionContext(store, queue=LocalQueue(), detector_factory=object, hooks=None)
    app = create_app(cache_root=tmp_path / "c", data_root=tmp_path / "u", missions=ctx)
    with TestClient(app) as client:
        mid = client.post(
            "/missions", json={"name": "t", "area_name": "Mount Seymour", "lkp": LKP}
        ).json()["mission_id"]
        r = client.post(
            f"/missions/{mid}/photos",
            files=[("files", ("nogps.jpg", drone_photo(gps=False), "image/jpeg"))],
        ).json()
    assert r["accepted"] == [] and r["rejected"][0]["name"] == "nogps.jpg"
    notes = [e for e in store.trace_entries(mid) if e.summary.startswith("photo.rejected")]
    assert len(notes) == 1 and notes[0].actor == "pipeline" and "no GPS" in notes[0].summary
    assert any((e.data or {}).get("failure") == "photo.rejected" for e in store.events(mid))
