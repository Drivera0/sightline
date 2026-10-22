"""API hardening (``sightline/api/limits.py``): photo size per file and per batch, JPEG/PNG only (415),
safe file names, JSON body size (413), and the per-IP write rate limit (429)."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sightline.api import limits, missions
from sightline.api.app import create_app
from sightline.api.limits import RateLimit, parse_rate, photo_type_problem, safe_filename
from sightline.api.missions import MissionContext
from sightline.mission import MissionStore
from sightline.mission.queue import LocalQueue
from tests.fixtures.drone_photos import LKP, drone_photo

BODY = {"name": "Seymour", "area_name": "Mount Seymour", "lkp": LKP}


@pytest.fixture
def make_client(tmp_path: Path):
    clients: list[TestClient] = []

    def make(**kw) -> TestClient:
        ctx = MissionContext(MissionStore(tmp_path / f"m{len(clients)}"), queue=LocalQueue())
        app = create_app(
            cache_root=tmp_path / "cache", data_root=tmp_path / "up", missions=ctx, **kw
        )
        client = TestClient(app)
        clients.append(client)
        return client  # the queue isn't started: accepted photos just wait

    return make


def _mission(client: TestClient) -> str:
    r = client.post("/missions", json=BODY)
    assert r.status_code == 201, r.text
    return r.json()["mission_id"]


def _upload(client: TestClient, mid: str, *files: tuple[str, bytes, str]):
    return client.post(f"/missions/{mid}/photos", files=[("files", f) for f in files])


def test_limits_are_documented_multiples_of_heridal_photos() -> None:
    largest_heridal = 6_902_670  # bytes, the largest of the 1,647 full photos
    assert limits.MAX_PHOTO_BYTES >= 4 * largest_heridal
    assert limits.MAX_BATCH_BYTES >= missions.MAX_FILES * largest_heridal


def test_photo_over_the_per_file_limit_is_rejected(
    make_client, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = make_client()
    mid = _mission(client)
    photo = drone_photo()
    monkeypatch.setattr(missions, "MAX_PHOTO_BYTES", len(photo) - 1)
    r = _upload(client, mid, ("big.jpg", photo, "image/jpeg"), ("ok.jpg", photo[:0], "image/jpeg"))
    assert r.status_code == 202
    assert r.json()["rejected"][0]["name"] == "big.jpg"
    assert r.json()["rejected"][0]["reason"].startswith("larger than")


def test_batch_over_the_limit_is_413_before_it_is_read(
    make_client, monkeypatch: pytest.MonkeyPatch
) -> None:
    client = make_client()
    mid = _mission(client)
    monkeypatch.setattr(limits, "MAX_BATCH_BYTES", 20_000)
    photo = drone_photo()
    r = _upload(client, mid, *[(f"p{i}.jpg", photo, "image/jpeg") for i in range(4)])
    assert len(photo) * 4 > 20_000 > len(photo)
    assert r.status_code == 413 and r.json() == {"detail": "request body over 0.02 MB"}
    assert _upload(client, mid, ("p.jpg", photo, "image/jpeg")).status_code == 202


def test_only_jpeg_or_png_uploads(make_client) -> None:
    client = make_client()
    mid = _mission(client)
    photo = drone_photo()
    r = _upload(client, mid, ("a.jpg", photo, "image/jpeg"), ("notes.txt", b"hi", "text/plain"))
    assert r.status_code == 415
    assert r.json() == {"detail": "notes.txt: only JPEG or PNG photos (.jpg, .jpeg, .png)"}
    r = _upload(client, mid, ("a.jpg", b"<html>", "text/html"))
    assert (
        r.status_code == 415
        and r.json()["detail"] == "a.jpg: only JPEG or PNG photos, not text/html"
    )
    # A PNG passes the type check, then needs to decode as a drone JPEG with a pose like any photo.
    r = _upload(client, mid, ("a.png", b"\x89PNG\r\n\x1a\n", "image/png"))
    assert r.status_code == 202 and r.json()["rejected"][0]["name"] == "a.png"
    assert photo_type_problem("DJI_0001.JPG", None) is None
    assert photo_type_problem("x.jpeg", "application/octet-stream") is None


def test_unsafe_file_names_are_refused_not_trimmed(make_client) -> None:
    client = make_client()
    mid = _mission(client)
    photo = drone_photo()
    r = _upload(
        client,
        mid,
        ("../../etc/evil.jpg", photo, "image/jpeg"),
        ("/abs/evil.jpg", photo, "image/jpeg"),
        ("DJI_0001.JPG", photo, "image/jpeg"),
    )
    assert r.status_code == 202, r.text
    assert [x["reason"] for x in r.json()["rejected"]] == ["unsafe file name"] * 2
    assert r.json()["accepted"] == ["f0001"]
    assert safe_filename("DJI_0001.JPG") and safe_filename("a b (1).jpeg")
    for bad in ("", "..", "a/../b.jpg", "..\\b.jpg", "/etc/passwd", "C:evil.jpg", "a\x00.jpg"):
        assert not safe_filename(bad), bad


def test_json_writes_over_1_mb_are_413(make_client) -> None:
    client = make_client()
    big = {**BODY, "subject": "x" * 1_100_000}
    r = client.post("/missions", json=big)
    assert r.status_code == 413 and r.json() == {"detail": "request body over 1 MB"}

    def chunks():  # no Content-Length: counted as it arrives
        yield b'{"name": "'
        for _ in range(12):
            yield b"x" * 100_000
        yield b'"}'

    r = client.post("/missions", content=chunks(), headers={"Content-Type": "application/json"})
    assert r.status_code == 413 and r.json() == {"detail": "request body over 1 MB"}
    assert client.post("/missions", json=BODY).status_code == 201


def test_rate_limit_on_writes_per_client(make_client) -> None:
    client = make_client(rate_limit=(3, 60))
    for _ in range(3):
        assert client.post("/missions", json=BODY).status_code == 201
    r = client.post("/missions", json=BODY)
    assert r.status_code == 429 and 1 <= int(r.headers["retry-after"]) <= 60
    assert r.json()["detail"].startswith("too many writes: at most 3 per 60 s")
    assert client.get("/health").status_code == 200  # reads are never limited
    assert client.get("/missions").status_code == 200


def test_rate_limit_from_the_environment(make_client, monkeypatch: pytest.MonkeyPatch) -> None:
    client = make_client()  # off in tests by default (conftest)
    assert all(client.post("/missions", json=BODY).status_code == 201 for _ in range(5))
    monkeypatch.setenv("SIGHTLINE_RATE_LIMIT", "1/60")
    client = make_client()
    assert client.post("/missions", json=BODY).status_code == 201
    assert client.post("/missions", json=BODY).status_code == 429
    assert parse_rate("off") is None and parse_rate("300/60") == (300, 60.0)
    with pytest.raises(ValueError):
        parse_rate("lots")


def test_rate_limit_window_slides_and_trusts_the_proxy_only_when_told() -> None:
    asyncio.run(_window_and_proxy())


async def _window_and_proxy() -> None:
    now = [0.0]
    seen: list[str] = []

    async def app(scope, receive, send):
        seen.append(scope["method"])
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    sent: list[int] = []

    async def send(message):
        if message["type"] == "http.response.start":
            sent.append(message["status"])

    async def receive():
        return {"type": "http.request", "body": b""}

    def scope(ip: str, xff: str | None = None):
        headers = [(b"x-forwarded-for", xff.encode())] if xff else []
        return {
            "type": "http",
            "method": "POST",
            "path": "/x",
            "client": (ip, 1),
            "headers": headers,
        }

    limiter = RateLimit(app, requests=2, seconds=10, clock=lambda: now[0])
    for _ in range(3):
        await limiter(scope("1.1.1.1"), receive, send)
    await limiter(scope("2.2.2.2"), receive, send)  # another client has its own window
    now[0] = 10.5
    await limiter(scope("1.1.1.1"), receive, send)  # the window moved on
    assert sent == [204, 204, 429, 204, 204]

    proxied = RateLimit(app, requests=1, seconds=10, trust_proxy=True, clock=lambda: now[0])
    await proxied(scope("10.0.0.2", "spoofed, 3.3.3.3"), receive, send)
    await proxied(scope("10.0.0.2", "4.4.4.4"), receive, send)  # same proxy, another client
    assert sent[-2:] == [204, 204]
    assert RateLimit(app, 1, 10).client(scope("10.0.0.2", "4.4.4.4")) == "10.0.0.2"
