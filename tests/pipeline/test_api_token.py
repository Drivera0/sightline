"""The optional write token (``sightline/api/auth.py``): writes need ``Authorization: Bearer`` only
when ``SIGHTLINE_API_TOKEN`` is set; reads, /health, preflights and streams stay open."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.applications import Starlette
from starlette.responses import StreamingResponse
from starlette.routing import Route

from sightline.api.app import create_app
from sightline.api.auth import MISSING, WRONG, WriteToken
from sightline.api.missions import MissionContext
from sightline.client import create_mission
from sightline.mission import MissionStore
from sightline.mission.queue import LocalQueue
from tests.fixtures.drone_photos import LKP

TOKEN = "test-token-not-a-secret"
BODY = {"name": "Seymour", "area_name": "Mount Seymour", "lkp": LKP}


@pytest.fixture
def make_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("SIGHTLINE_API_TOKEN", raising=False)
    contexts: list[MissionContext] = []
    clients: list[TestClient] = []

    def make(api_token: str | None = None) -> TestClient:
        ctx = MissionContext(
            MissionStore(tmp_path / f"missions{len(contexts)}"), queue=LocalQueue()
        )
        ctx.start()
        contexts.append(ctx)
        app = create_app(
            cache_root=tmp_path / "cache",
            data_root=tmp_path / "up",
            missions=ctx,
            api_token=api_token,
        )
        client = TestClient(app)
        client.__enter__()
        clients.append(client)
        return client

    yield make
    for client in clients:
        client.__exit__(None, None, None)
    for ctx in contexts:
        ctx.queue.stop()


def test_unset_leaves_every_method_open(make_client) -> None:
    client = make_client()
    r = client.post("/missions", json=BODY)
    assert r.status_code == 201, r.text
    assert client.get(f"/missions/{r.json()['mission_id']}/state").status_code == 200


def test_writes_need_the_token_reads_do_not(make_client) -> None:
    client = make_client(TOKEN)
    assert client.get("/health").json()["status"] == "ok"

    r = client.post("/missions", json=BODY)
    assert r.status_code == 401
    assert r.json() == {"detail": MISSING} and r.headers["www-authenticate"] == "Bearer"
    r = client.post("/missions", json=BODY, headers={"Authorization": "Bearer nope"})
    assert r.status_code == 401 and r.json() == {"detail": WRONG}
    r = client.post("/missions", json=BODY, headers={"Authorization": TOKEN})  # no scheme
    assert r.status_code == 401 and r.json() == {"detail": MISSING}

    r = client.post("/missions", json=BODY, headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 201, r.text
    mid = r.json()["mission_id"]
    assert client.get(f"/missions/{mid}/state").status_code == 200  # reads stay open
    assert client.get(f"/missions/{mid}/survey").status_code == 200

    for method in ("PUT", "PATCH", "DELETE"):  # refused before routing, whatever the path
        assert client.request(method, f"/missions/{mid}/teams/T1").status_code == 401
    assert client.post("/survey").status_code == 401  # the sprint-1 upload is a write too


def test_401_keeps_cors_and_preflight_stays_open(make_client) -> None:
    client = make_client(TOKEN)
    origin = {"Origin": "http://localhost:5173"}
    r = client.post("/missions", json=BODY, headers=origin)
    assert r.status_code == 401
    # CORS headers on the 401, so the page can read why
    assert r.headers["access-control-allow-origin"] == "http://localhost:5173"
    r = client.options(
        "/missions",
        headers={
            **origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type",
        },
    )
    assert r.status_code == 200 and "authorization" in r.headers["access-control-allow-headers"]


def test_token_comes_from_the_environment(make_client, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SIGHTLINE_API_TOKEN", f"  {TOKEN}\n")
    client = make_client()
    assert client.post("/missions", json=BODY).status_code == 401
    ok = {"Authorization": f"Bearer {TOKEN}"}
    assert client.post("/missions", json=BODY, headers=ok).status_code == 201
    monkeypatch.setenv("SIGHTLINE_API_TOKEN", "   ")  # blank counts as unset
    assert make_client().post("/missions", json=BODY).status_code == 201


def test_python_client_sends_the_token(make_client, monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client(TOKEN)
    with pytest.raises(Exception) as refused:  # TestClient's httpx raises its own HTTPStatusError
        create_mission(client, "Seymour", (LKP["lat"], LKP["lon"]), area_name="Mount Seymour")
    assert refused.value.response.status_code == 401
    monkeypatch.setenv("SIGHTLINE_API_TOKEN", TOKEN)
    mid = create_mission(client, "Seymour", (LKP["lat"], LKP["lon"]), area_name="Mount Seymour")
    assert client.get(f"/missions/{mid}/state").json()["mission"]["name"] == "Seymour"


def test_streams_pass_through_untouched() -> None:
    def events(request):
        return StreamingResponse(
            (f"id: {i}\ndata: {i}\n\n" for i in range(3)), media_type="text/event-stream"
        )

    app = WriteToken(Starlette(routes=[Route("/events", events, methods=["GET", "POST"])]), TOKEN)
    client = TestClient(app)
    r = client.get("/events")
    assert r.status_code == 200 and r.text.count("data:") == 3
    assert client.post("/events").status_code == 401
    with pytest.raises(ValueError):
        WriteToken(app, "")
