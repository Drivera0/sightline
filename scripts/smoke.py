"""The smoke test (LANE_D §5.8, D-S1): the whole live-mission loop against a real server, in
under a minute, with no network and no model files. Run it before merging anything the pipeline
calls: ``bash scripts/smoke.sh``.

Starts ``serve`` on a free port (``SIGHTLINE_BACKEND=fake``, ``SIGHTLINE_FAKE_LLM=1``,
``SIGHTLINE_FAKE_TAVILY=1``, missions in a temp folder), then: create a mission, upload the
fixture photos (one without GPS must be rejected), wait for every ``photo.processed`` on the SSE
stream, post a review, a clue and a searched task, add a command proposal through the store (from
this process: the store's file lock is shared) and approve it over the API, fetch the debrief if
lane C's exists, and finish with ``validate_mission() == []``. Exit code 1 on any failure.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

PHOTOS = ROOT / "tests/fixtures/photos"
LKP = {"lat": 49.375, "lon": -122.9375}
TIMEOUT_S = 45


class Smoke:
    def __init__(self, base: str) -> None:
        self.base = base
        self.events: list[dict] = []
        self.failures: list[str] = []

    def call(
        self, method: str, path: str, body: dict | None = None, ok=(200, 201, 202)
    ) -> tuple[int, dict | str]:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            self.base + path,
            data=data,
            method=method,
            headers={"Content-Type": "application/json"} if data else {},
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                status, raw = r.status, r.read()
        except urllib.error.HTTPError as e:
            status, raw = e.code, e.read()
        try:
            out = json.loads(raw)
        except ValueError:
            out = raw.decode(errors="replace")
        if ok and status not in ok:
            raise AssertionError(f"{method} {path} → {status}: {out}")
        return status, out

    def upload(self, mid: str, files: list[Path]) -> dict:
        b = uuid.uuid4().hex
        parts = b"".join(
            f'--{b}\r\nContent-Disposition: form-data; name="files"; filename="{f.name}"\r\nContent-Type: image/jpeg\r\n\r\n'.encode()
            + f.read_bytes()
            + b"\r\n"
            for f in files
        )
        req = urllib.request.Request(
            f"{self.base}/missions/{mid}/photos",
            data=parts + f"--{b}--\r\n".encode(),
            headers={"Content-Type": f"multipart/form-data; boundary={b}"},
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read())

    def listen(self, mid: str) -> None:
        """Collect SSE events in a thread (``data:`` lines → dicts)."""

        def run() -> None:
            try:
                with urllib.request.urlopen(
                    f"{self.base}/missions/{mid}/events", timeout=TIMEOUT_S + 15
                ) as r:
                    for line in r:
                        if line.startswith(b"data: "):
                            self.events.append(json.loads(line[6:]))
            except (OSError, ValueError):
                pass

        threading.Thread(target=run, daemon=True).start()

    def wait_for(self, what: str, pred, timeout: float = TIMEOUT_S) -> list[dict]:
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            got = [e for e in list(self.events) if pred(e)]
            if got:
                return got
            time.sleep(0.1)
        raise AssertionError(f"timed out waiting for {what}")

    def check(self, name: str, fn) -> None:
        t0 = time.perf_counter()
        try:
            note = fn()
        except Exception as e:  # noqa: BLE001 - every failure is reported, then the next check runs
            self.failures.append(name)
            print(f"  FAIL {name}: {e}")
            return
        print(f"  ok   {name} ({time.perf_counter() - t0:.1f} s){f': {note}' if note else ''}")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main() -> int:
    from sightline.contract import Proposal
    from sightline.mission import MissionStore, validate_mission
    from tests.fixtures.mission import committed_turn

    t_start = time.perf_counter()
    tmp = Path(tempfile.mkdtemp(prefix="sightline-smoke-"))
    port = free_port()
    env = {
        **os.environ,
        "SIGHTLINE_BACKEND": "fake",
        "SIGHTLINE_FAKE_LLM": "1",
        "SIGHTLINE_FAKE_TAVILY": "1",
    }
    log = open(tmp / "server.log", "w")  # noqa: SIM115 - closed at exit
    server = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "sightline.pipeline",
            "serve",
            "--port",
            str(port),
            "--mission-root",
            str(tmp / "missions"),
            "--cache-root",
            str(tmp / "cache"),
            "--data-root",
            str(tmp / "up"),
        ],
        cwd=ROOT,
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    s = Smoke(f"http://127.0.0.1:{port}")
    state: dict = {}
    try:
        print(f"smoke: server on :{port}, missions in {tmp / 'missions'}")

        def health():
            end = time.monotonic() + 30
            while True:
                try:
                    _, h = s.call("GET", "/health")
                    break
                except (OSError, AssertionError):
                    if time.monotonic() > end or server.poll() is not None:
                        raise AssertionError(
                            f"server didn't start (see {tmp / 'server.log'})"
                        ) from None
                    time.sleep(0.3)
            assert h["contract_version"] == "1.2" and h["backend"] == "fake", h
            return f"contract {h['contract_version']}, backend {h['backend']}"

        def create():
            _, m = s.call(
                "POST", "/missions", {"name": "Smoke", "area_name": "Mount Seymour", "lkp": LKP}
            )
            state["mid"] = m["mission_id"]
            s.listen(state["mid"])
            return state["mid"]

        def photos():
            files = sorted(PHOTOS.glob("DJI_*.JPG")) + [PHOTOS / "no_gps.jpg"]
            r = s.upload(state["mid"], files)
            assert r["accepted"] == ["f0001", "f0002", "f0003"], r
            assert [x["name"] for x in r["rejected"]] == ["no_gps.jpg"] and "GPS" in r["rejected"][
                0
            ]["reason"], r
            return "3 accepted, the photo without GPS rejected"

        def processed():
            end = time.monotonic() + TIMEOUT_S
            while len(done := [e for e in s.events if e["type"] == "photo.processed"]) < 3:
                if time.monotonic() > end:
                    raise AssertionError(f"{len(done)}/3 photo.processed")
                time.sleep(0.1)
            maps = [e for e in s.events if e["type"] == "map.updated"]
            map_note = done[0]["data"]["map"]
            assert maps or map_note.startswith("skipped"), map_note
            ms = sorted(e["data"]["total_ms"] for e in done)
            return f"median {ms[1]} ms per photo; map: {'updated' if maps else map_note}"

        def review():
            _, r = s.call(
                "POST",
                f"/missions/{state['mid']}/reviews",
                {"detection_id": "f0001-d01", "answer": "not_person"},
            )
            return "map update" if r and "seq" in r else (r or {}).get("note", "no map change")

        def clue():
            mid = state["mid"]
            s.call(
                "PATCH",
                f"/missions/{mid}/teams/T2",
                {"position": {"lat": 49.3755, "lon": -122.938}},
            )
            status, _ = s.call(
                "POST",
                f"/missions/{mid}/clues",
                {
                    "kind": "object",
                    "text": "blue backpack",
                    "lat": None,
                    "lon": None,
                    "at_team_position": True,
                    "reported_by": "T2",
                    "source": "radio",
                },
                ok=None,
            )
            assert status == 422, f"an unconfirmed radio clue must be refused, got {status}"
            # The team's "affirmative" to the readback, recorded as the radio desk records it.
            MissionStore(tmp / "missions").trace(mid, committed_turn("r0001"))
            _, c = s.call(
                "POST",
                f"/missions/{mid}/clues",
                {
                    "kind": "object",
                    "text": "blue backpack",
                    "lat": None,
                    "lon": None,
                    "at_team_position": True,
                    "reported_by": "T2",
                    "source": "radio",
                    "confirmed_by_turn": "r0001",
                },
            )
            assert c["id"] == "c001" and c["confirmed"], c
            return "radio clue refused without readback; confirmed one added"

        def task():
            _, t = s.call(
                "POST", f"/missions/{state['mid']}/tasks/B3", {"state": "searched", "pod": 0.6}
            )
            assert t["task"]["pod"] == 0.6, t

        def decision():
            mid = state["mid"]
            store = MissionStore(tmp / "missions")  # this process: the file lock is shared
            p = store.add_proposal(
                mid,
                Proposal(
                    id="",
                    kind="assign_sector",
                    summary="Assign sector B3 to Team Two",
                    reason="smoke test",
                    briefing="New assignment, sector Bravo Three.",
                    target={"team": "T2", "sector": "B3"},
                    evidence=[],
                    status="pending",
                    created_by="command",
                    created_at="2026-10-24T21:40:00Z",
                    decided_at=None,
                    decided_by=None,
                    decision_reason=None,
                    edits=None,
                ),
            )
            _, d = s.call(
                "POST",
                f"/missions/{mid}/proposals/{p.id}/decide",
                {"decision": "approve", "by": "Smoke test"},
            )
            assert d["status"] == "approved", d
            _, st = s.call("GET", f"/missions/{mid}/state")
            assert {t["id"]: t["status"] for t in st["teams"]}["T2"] == "assigned"
            s.wait_for(
                "proposal.decided",
                lambda e: e["type"] == "proposal.decided" and e["ref"] == p.id,
                10,
            )

        def debrief():
            status, _ = s.call("GET", f"/missions/{state['mid']}/debrief.md", ok=None)
            assert status in (200, 503), status
            return "skipped: waits for lane C" if status == 503 else "ok"

        def valid():
            time.sleep(0.5)  # let the agent's background work land
            problems = validate_mission(tmp / "missions", state["mid"])
            assert problems == [], problems

        for name, fn in [
            ("health", health),
            ("create a mission", create),
            ("upload photos", photos),
            ("3 × photo.processed over SSE", processed),
            ("review", review),
            ("clue", clue),
            ("task searched", task),
            ("decide a proposal", decision),
            ("debrief", debrief),
            ("validate_mission", valid),
        ]:
            s.check(name, fn)
            if s.failures and name in ("health", "create a mission"):
                break
    finally:
        server.terminate()
        try:
            server.wait(10)
        except subprocess.TimeoutExpired:
            server.kill()
        log.close()
    took = time.perf_counter() - t_start
    if s.failures:
        print(
            f"smoke: FAILED ({', '.join(s.failures)}) in {took:.0f} s; server log: {tmp / 'server.log'}"
        )
        return 1
    print(f"smoke: passed in {took:.0f} s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
