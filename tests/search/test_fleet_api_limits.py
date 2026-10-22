"""The fleet against a hardened API: every write carries the token (``auth_headers()``), a 429 is
retried after ``Retry-After``, and a tick costs at most one write per drone plus the ground station's,
which is what the default rate limit is sized for (``sightline/api/limits.py``)."""

from __future__ import annotations

import queue
import threading
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from sightline.api.app import create_app
from sightline.api.limits import DEFAULT_RATE, parse_rate
from sightline.api.missions import MissionContext
from sightline.mission import MissionStore
from sightline.mission.queue import LocalQueue
from sightline.search import fleet as fleet_mod
from sightline.search.fleet import DroneConfig, FleetSim, Scenario, _send, drone_loop
from tests.fixtures.drone_photos import LKP
from tests.search.test_fleet import HIDDEN, Hooks, Pool, _Det, _leg_over_hidden, _scenario

TOKEN = "fleet-test-token"
WRITES = {"POST", "PUT", "PATCH", "DELETE"}


@pytest.fixture
def locked(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """The API with a write token; the clients get it from SIGHTLINE_API_TOKEN."""
    store = MissionStore(tmp_path / "missions")
    ctx = MissionContext(store, queue=LocalQueue(), detector_factory=lambda: _Det(), hooks=Hooks())
    ctx.start()
    app = create_app(cache_root=tmp_path / "c", data_root=tmp_path / "u", missions=ctx,
                     api_token=TOKEN, rate_limit=None)  # fmt: skip
    monkeypatch.setenv("SIGHTLINE_API_TOKEN", TOKEN)
    with TestClient(app) as http:
        mid = http.post("/missions", json={"name": "F", "area_name": "a", "lkp": LKP},
                        headers={"Authorization": f"Bearer {TOKEN}"}).json()["mission_id"]  # fmt: skip
        sent: list[tuple[str, str, str | None]] = []
        http.event_hooks = {"request": [lambda r: sent.append((r.method, r.url.path, r.headers.get("authorization")))], "response": []}  # fmt: skip
        yield http, ctx, store, mid, sent, tmp_path
    ctx.queue.stop()


def _three() -> Scenario:
    one = _scenario()
    drones = [one.drones[0].model_copy(update={"id": f"D{k}", "name": f"Drone {k}"}) for k in (1, 2, 3)]  # fmt: skip
    return Scenario(name="t", lkp=one.lkp, drones=drones, hidden=HIDDEN, positive={}, clue=None)


def test_every_fleet_write_carries_the_token_and_a_tick_is_at_most_four_writes(locked) -> None:
    http, ctx, store, mid, sent, tmp = locked
    sim = FleetSim(http, mid, _three(), time_scale=20.0, pool=Pool(tmp), out=lambda s: None, links=())  # fmt: skip
    sim.register()
    _leg_over_hidden(store, mid)  # D1 flies; at 20x it takes several photos a tick
    per_tick = []
    for _ in range(6):
        before = len(sent)
        sim.tick(1.0)
        per_tick.append(sum(m in WRITES for m, _, _ in sent[before:]))
    ctx.queue.join()
    assert sim.photos >= 4 and len(store.survey(mid).frames) == sim.photos
    writes = [(m, p, a) for m, p, a in sent if m in WRITES]
    assert writes and all(a == f"Bearer {TOKEN}" for _, _, a in writes)
    assert max(per_tick) <= 4  # 3 drones + the ground station
    rate, window = parse_rate(DEFAULT_RATE)
    assert 4 * 2 * window <= rate  # creek_run's 2 ticks a second fit the default


def test_a_drone_process_sends_the_token_too(locked) -> None:
    http, _, store, mid, sent, tmp = locked
    scn = _scenario()
    FleetSim(http, mid, scn, pool=Pool(tmp), out=lambda s: None, links=()).register()
    _leg_over_hidden(store, mid)
    reports, control, stop = queue.Queue(), queue.Queue(), threading.Event()
    cfg = DroneConfig("D1", "http://test", mid, "unused", time_scale=20.0, dt_s=0.01)
    t = threading.Thread(target=drone_loop, args=(cfg, http, scn, Pool(tmp), reports, control, stop), kwargs={"out": lambda s: None})  # fmt: skip
    t.start()
    try:
        for _ in range(300):
            if any(p.endswith("/photos") for _, p, _ in sent):
                break
            threading.Event().wait(0.01)
    finally:
        stop.set()
        t.join(10)
    photos = [a for m, p, a in sent if p.endswith("/photos")]
    assert photos and all(a == f"Bearer {TOKEN}" for a in photos)


def test_without_the_token_a_write_is_refused(locked, monkeypatch: pytest.MonkeyPatch) -> None:
    http, _, _, mid, _, tmp = locked
    monkeypatch.delenv("SIGHTLINE_API_TOKEN")
    with pytest.raises(Exception) as e:
        FleetSim(http, mid, _scenario(), pool=Pool(tmp), out=lambda s: None, links=()).register()
    assert e.value.response.status_code == 401


class _Flaky:
    """Answers 429 (Retry-After: 2) twice, then 200."""

    def __init__(self, limited: int = 2, header: str | None = "2") -> None:
        self.limited, self.header, self.calls = limited, header, 0

    def request(self, method, path, **kw):
        self.calls += 1
        req = httpx.Request(method, f"http://x{path}")
        if self.calls <= self.limited:
            h = {"Retry-After": self.header} if self.header is not None else {}
            return httpx.Response(429, headers=h, json={"detail": "too many writes"}, request=req)
        return httpx.Response(200, json={"ok": True}, request=req)


def test_send_waits_as_retry_after_says_then_succeeds() -> None:
    waits: list[float] = []
    http = _Flaky()
    assert _send(http, "PUT", "/missions/m/fleet", json={}, sleep=waits.append).json() == {
        "ok": True
    }
    assert waits == [2.0, 2.0] and http.calls == 3
    waits.clear()
    _send(_Flaky(1, header=None), "POST", "/x", sleep=waits.append)
    assert waits == [1.0]  # no header: a second


def test_send_gives_up_after_its_retries() -> None:
    waits: list[float] = []
    with pytest.raises(httpx.HTTPStatusError):
        _send(_Flaky(limited=99, header="999"), "POST", "/x", sleep=waits.append)
    assert len(waits) == fleet_mod.RETRY_TIMES and set(waits) == {fleet_mod.RETRY_MAX_S}


def test_creek_runs_client_retries_a_429(monkeypatch: pytest.MonkeyPatch) -> None:
    import importlib.util
    import io
    import sys
    import urllib.error

    path = Path(__file__).resolve().parents[2] / "scripts" / "agent_live.py"
    spec = importlib.util.spec_from_file_location("agent_live_t", path)
    al = importlib.util.module_from_spec(spec)
    sys.modules["agent_live_t"] = al
    spec.loader.exec_module(al)  # type: ignore[union-attr]
    calls: list[dict] = []

    class _Resp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(req, timeout):
        calls.append(dict(req.header_items()))
        if len(calls) == 1:
            raise urllib.error.HTTPError(req.full_url, 429, "slow down", {"Retry-After": "3"}, io.BytesIO(b"{}"))  # fmt: skip
        return _Resp(b'{"ok": true}')

    slept: list[float] = []
    monkeypatch.setattr(al.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(al.time, "sleep", slept.append)
    monkeypatch.setenv("SIGHTLINE_API_TOKEN", TOKEN)
    assert al.call("http://x", "PUT", "/missions/m/fleet", {"a": 1}) == {"ok": True}
    assert slept == [3.0] and len(calls) == 2
    assert all(c.get("Authorization") == f"Bearer {TOKEN}" for c in calls)
