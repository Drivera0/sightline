"""The bulletin tool (sightline/agent/subject_tool.py, sightline/geo/subject.py): the model decides
to search, Tavily search → extract on trusted domains, each field kept only with a verbatim quote,
names never stored, one proposal, and its approval sets the category and the prior and re-plans.
No network: the synthetic bulletin fixture and scripted models."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sightline.agent import loop, subject_tool
from sightline.agent.llm import ChatResult, FakeChatClient
from sightline.api.app import create_app
from sightline.api.missions import MissionContext
from sightline.geo import subject as geo
from sightline.mission import MissionStore
from sightline.mission.queue import LocalQueue
from tests.fixtures.drone_photos import LKP

NAMES = ("Jordan", "Example")
AT = "2026-10-24T20:05:00Z"
DRONE = {"id": "D1", "name": "Drone 1", "simulated": True, "position": {"lat": 49.3762, "lon": -122.9389},
         "altitude_m": 50.0, "speed_ms": 8.0, "battery_pct": 90.0, "max_wind_kmh": 43.2, "status": "idle",
         "leg_id": None}  # fmt: skip


class CountingTavily(geo.FakeBulletinTavily):
    def __init__(self) -> None:
        super().__init__()
        self.calls: list[tuple[str, dict]] = []

    def search(self, query, **kw):
        self.calls.append(("search", {"query": query, **kw}))
        return super().search(query, **kw)

    def extract(self, urls, **kw):
        self.calls.append(("extract", {"urls": urls, **kw}))
        return super().extract(urls, **kw)


class SyncHooks:
    """The re-plan after an approval, run at once on this thread; other hooks do nothing."""

    def on_subject_set(self, store, mission_id: str, pid: str) -> None:
        loop.handle("subject_set", store, mission_id, pid, client=None)

    def __getattr__(self, name: str):
        return lambda *a: None


@pytest.fixture
def api(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr("sightline.api.missions._first_conditions", lambda ctx, mid: None)
    monkeypatch.setenv("SIGHTLINE_FAKE_TAVILY", "1")
    monkeypatch.setattr(subject_tool, "default_client", subject_tool.demo_client)
    store = MissionStore(tmp_path / "missions")
    ctx = MissionContext(store, queue=LocalQueue(), hooks=SyncHooks())
    app = create_app(cache_root=tmp_path / "cache", data_root=tmp_path / "up", missions=ctx)
    with TestClient(app) as client:
        yield client, store


def _mission(client: TestClient, subject: str | None = None) -> str:
    body = {"name": "Seymour", "area_name": "Mount Seymour", "lkp": LKP, "subject": subject}
    return client.post("/missions", json=body).json()["mission_id"]


def _no_names(text: str) -> None:
    for n in NAMES:
        assert n.lower() not in text.lower(), f"{n!r} stored"


# --- geo: privacy and quotes ---------------------------------------------------------------------


def test_names_are_found_the_way_bulletins_write_them_and_redacted() -> None:
    text = (
        "Police seek Sam Q. Public, 71, who has dementia. A 34-year-old woman Ana Lima was found. "
        "Anyone who sees Mr. Public should call. Ana Lima (52) is safe."
    )
    names = geo.find_names(text)
    assert {"Ana Lima", "Public", "Lima"} <= names
    out = geo.redact(text, names | {"Sam Q. Public"})
    assert "Lima" not in out and "Public" not in out and "Police" in out
    assert geo.redact("https://x.ca/news/missing-ana-lima-found", {"Ana Lima"}).endswith(
        "missing-[name]-found"
    )


def test_a_field_is_kept_only_with_a_verbatim_quote_that_says_it() -> None:
    docs = [{"url": "https://rcmp.ca/a", "title": "t", "text": geo.FakeBulletinTavily().text}]
    fields = {
        **subject_tool.DEMO_FIELDS,
        "age": {"value": 43, "quote": "Jordan Example, 34, a hiker", "doc": 0},  # number not there
        "category": {"value": "dementia", "quote": "a hiker who did", "doc": 0},  # wrong kind
        "clothing": {"value": "blue coat", "quote": "wearing a blue coat", "doc": 0},  # not in page
    }
    client = FakeChatClient(default=json.dumps({"fields": fields, "names": []}))
    values, quotes, urls, _, _ = geo.extract_profile(docs, client)
    assert values["age"] is None and values["category"] is None and values["clothing"] is None
    assert values["last_seen_time"] == "3:30 p.m."
    assert quotes["last_seen_place"] == "at the Mount Seymour trailhead parking lot"
    assert urls["last_seen_time"] == "https://rcmp.ca/a"
    assert "never put a person's name" in client.calls[0]["messages"][0]["content"].lower()


def test_lookup_searches_trusted_domains_then_extracts_and_caches_the_hour(tmp_path: Path) -> None:
    tav, traced = CountingTavily(), []
    kw = {"cache_dir": tmp_path, "now": AT, "tavily": tav, "client": subject_tool.demo_client()}
    out = geo.lookup_subject(
        "missing hiker Mount Seymour", trace=lambda **e: traced.append(e), **kw
    )
    (kind, search), (kind2, extract) = tav.calls
    assert kind == "search" and search["include_domains"] == list(geo.SOURCE_DOMAINS)
    assert "rcmp.ca" in search["include_domains"] and search["search_depth"] == "advanced"
    assert kind2 == "extract" and extract["urls"] == [geo.SYNTHETIC_URL]
    assert out["values"]["category"] == "hiker/temperate_mountainous" and out["values"]["age"] == 34
    assert out["quotes"]["age"] == "[name], 34, a hiker" and out["redacted"]
    assert [e["kind"] for e in traced] == ["tool_call", "tool_call", "model_call"]
    _no_names(json.dumps(out) + json.dumps([{**e, "result": None} for e in traced]))
    _no_names("".join(p.read_text() for p in tmp_path.glob("*.json")))
    again = geo.lookup_subject("another query", trace=lambda **e: traced.append(e), **kw)
    assert again["cached"] and len(tav.calls) == 2 and again["values"] == out["values"]


def test_tavily_down_gives_no_profile_and_says_why(tmp_path: Path) -> None:
    class Down:
        def search(self, *a, **k):
            raise ConnectionError("offline")

    out = geo.lookup_subject("q", cache_dir=tmp_path, tavily=Down(), client=FakeChatClient())
    assert out["error"] == "Tavily failed (ConnectionError)" and out["values"]["age"] is None
    assert not list(tmp_path.glob("*.json"))  # a failure is not cached


# --- the agent: the model decides, one proposal, approval ----------------------------------------


def test_the_model_decides_searches_and_proposes_the_profile(api) -> None:
    client, store = api
    mid = _mission(client)
    r = client.post(f"/missions/{mid}/subject/search")
    assert r.status_code == 200
    body = r.json()
    p = body["proposal"]
    assert body["searched"] and p["kind"] == "alert" and p["status"] == "pending"
    assert p["summary"].startswith("Set subject profile: hiker, 34, red jacket")
    assert "last seen 3:30 p.m. at the Mount Seymour trailhead parking lot" in p["summary"]
    assert p["target"]["category"] == "hiker/temperate_mountainous" and p["briefing"] is None
    assert '"last seen at about 3:30 p.m.", synthetic demo bulletin' in p["reason"]
    assert p["evidence"][0]["ref"] == geo.SYNTHETIC_URL
    kinds = [(e.kind, e.actor) for e in store.trace_entries(mid) if e.actor == "agent"]
    assert kinds == [("model_call", "agent"), ("tool_call", "agent"), ("tool_call", "agent"),
                     ("model_call", "agent"), ("proposal", "agent")]  # fmt: skip
    decided = store.trace_entries(mid)[-5]
    assert decided.summary.startswith("subject: the model chose to search: missing hiker")
    # a second request while it waits: no new search
    again = client.post(f"/missions/{mid}/subject/search").json()
    assert again["proposal"] is None and "waiting for a decision" in again["why"]


def test_approval_sets_the_category_and_prior_and_replans(api) -> None:
    client, store = api
    mid = _mission(client)
    assert store.live(mid).base.params.prior_source == "placeholder"
    tele = {"drones": [DRONE], "leg_status": {}, "at": AT}
    assert client.put(f"/missions/{mid}/fleet", json=tele).status_code == 200
    pid = client.post(f"/missions/{mid}/subject/search").json()["proposal"]["id"]
    r = client.post(
        f"/missions/{mid}/proposals/{pid}/decide", json={"decision": "approve", "by": "SM"}
    )
    assert r.status_code == 200
    m = store.get(mid)
    assert m.subject.startswith("hiker, 34, red jacket")
    assert store.live(mid).base.params.prior_source.startswith("Koester lost-person rings, hiker/")
    legs = [p for p in store.state(mid)["proposals"] if p.kind == "drone_leg"]
    assert legs and legs[0].reason.startswith(f"Subject profile {pid} approved")
    trace = store.trace_entries(mid)
    order = [e.kind for e in trace if pid in e.refs or e.kind in ("model_call", "tool_call")]
    assert order[:6] == [
        "model_call",
        "tool_call",
        "tool_call",
        "model_call",
        "proposal",
        "decision",
    ]
    # never a name, anywhere the mission is stored
    root = store.root / mid
    _no_names("".join(f.read_text(errors="ignore") for f in root.rglob("*") if f.is_file()))
    # the category is set now: no further search
    again = client.post(f"/missions/{mid}/subject/search").json()
    assert not again["searched"] and "already names a category" in again["why"]


def test_a_rejection_is_traced_and_changes_nothing(api) -> None:
    client, store = api
    mid = _mission(client)
    pid = client.post(f"/missions/{mid}/subject/search").json()["proposal"]["id"]
    body = {"decision": "reject", "by": "SM", "reason": "different case"}
    assert client.post(f"/missions/{mid}/proposals/{pid}/decide", json=body).status_code == 200
    assert store.get(mid).subject is None
    assert store.trace_entries(mid)[-1].summary == f"{pid} rejected by SM: different case"
    # the same profile is not proposed again (the hour's lookup is reused)
    again = client.post(f"/missions/{mid}/subject/search").json()
    assert again["proposal"] is None and "rejected" in again["why"]


def test_the_model_may_decline_and_nothing_is_searched(tmp_path: Path) -> None:
    store = MissionStore(tmp_path / "m")
    from sightline.contract import LatLon

    m = store.create("HERIDAL replay", "HERIDAL site", LatLon(**LKP), "replay")
    no = ChatResult(text="A replay has no missing person.", tool_calls=[], model="x", ms=1,
                    tokens_in=1, tokens_out=1)  # fmt: skip
    tav = CountingTavily()
    out = subject_tool.search_subject(
        store, m.mission_id, client=FakeChatClient(default=no), tavily=tav, cache_dir=tmp_path
    )
    assert not out["searched"] and "chose not to search: A replay" in out["why"] and not tav.calls


def test_a_subject_with_a_category_needs_no_search(api) -> None:
    client, store = api
    mid = _mission(client, subject="adult, red jacket, day hiker")
    fake = FakeChatClient()
    out = subject_tool.search_subject(store, mid, client=fake)
    assert not out["searched"] and not fake.calls


def test_the_endpoint_takes_the_write_token(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr("sightline.api.missions._first_conditions", lambda ctx, mid: None)
    ctx = MissionContext(MissionStore(tmp_path / "m"), queue=LocalQueue(), hooks=None)
    app = create_app(cache_root=tmp_path / "c", data_root=tmp_path / "u", missions=ctx,
                     api_token="secret-token")  # fmt: skip
    with TestClient(app) as client:
        assert client.post("/missions/abcd1234/subject/search").status_code == 401
