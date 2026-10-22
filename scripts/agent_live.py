"""The agent end to end on a real live mission (LANE_A: "run the agent end to end once B, C, D land").

    uv run python scripts/agent_live.py [--photos 6]

Starts the real server (``serve``: mission API, OpenCV 5 cv2.dnn detector, the agent with Nemotron
on Token Factory from ``.env``), then drives it like a search would: create a mission at the photos'
site, give it a **simulated** fleet (lane C's fleet sim isn't in yet; labelled), upload real HERIDAL
**validation** photos, answer the first candidate "person", report a clue, and approve one proposal
as a **scripted** search manager (labelled). Waits for the agent to finish each step, then prints
and saves what it did: proposals, verdicts, the trace by kind, model calls, map updates, and
``validate_mission``. Output: ``runs/agent_live/<timestamp>/`` (mission files + ``summary.json``).
Val photos only; costs a few cents of tokens. Against a server with a write token, set
``SIGHTLINE_API_TOKEN``: ``call`` and ``upload`` send it (``scripts/creek_run.py`` uses them too).
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
VAL = ROOT / "data/heridal/yolo_full/val/images"
PHOTOS = [
    "train_BRK_2048.jpg",
    "train_BRK_2054.jpg",
    "train_BRK_2078.jpg",
    "train_BRK_2094.jpg",
    "train_BRK_2120.jpg",
    "train_BRK_2135.jpg",
]
LKP = {"lat": 43.3353, "lon": 17.7929}  # site BRK, where those photos were taken
APPROVER = "Search manager (scripted approval for this run)"


def call(base: str, method: str, path: str, body: dict | None = None) -> dict:
    from sightline.client import auth_headers

    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        base + path,
        data=data,
        method=method,
        headers={**auth_headers(), **({"Content-Type": "application/json"} if data else {})},
    )
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {path}: {e.code} {e.read()[:300]!r}") from None


def upload(base: str, mid: str, files: list[Path]) -> dict:
    from sightline.client import auth_headers

    b = uuid.uuid4().hex
    body = (
        b"".join(
            f'--{b}\r\nContent-Disposition: form-data; name="files"; filename="{f.name}"\r\nContent-Type: image/jpeg\r\n\r\n'.encode()
            + f.read_bytes()
            + b"\r\n"
            for f in files
        )
        + f"--{b}--\r\n".encode()
    )
    r = urllib.request.Request(
        f"{base}/missions/{mid}/photos",
        data=body,
        headers={**auth_headers(), "Content-Type": f"multipart/form-data; boundary={b}"},
    )
    with urllib.request.urlopen(r, timeout=300) as resp:
        return json.loads(resp.read())


def settle(store, mid: str, quiet_s: float = 25.0, limit_s: float = 600.0) -> None:
    """Wait until the agent has written nothing new (trace and proposals) for ``quiet_s``."""
    end, last, still_since = time.monotonic() + limit_s, None, time.monotonic()
    while time.monotonic() < end:
        now = (
            len(store.trace_entries(mid)),
            len(store.state(mid)["proposals"]),
            len(store.events(mid)),
        )
        if now != last:
            last, still_since = now, time.monotonic()
        elif time.monotonic() - still_since >= quiet_s:
            return
        time.sleep(1)
    print("  (stopped waiting: the agent was still busy)")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--photos", type=int, default=len(PHOTOS))
    args = ap.parse_args(argv)

    from dotenv import dotenv_values

    from sightline.contract import Drone, FleetState
    from sightline.mission import MissionStore, validate_mission

    out = ROOT / "runs/agent_live" / time.strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = {**os.environ, **{k: v for k, v in dotenv_values(ROOT / ".env").items() if v}}
    env.pop("SIGHTLINE_FAKE_LLM", None)
    if not env.get("NEBIUS_API_KEY"):
        print("NEBIUS_API_KEY is not set (.env): the agent would run without its model")
        return 1
    log = open(out / "server.log", "w")  # noqa: SIM115 - closed below
    server = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "sightline.pipeline",
            "serve",
            "--port",
            str(port),
            "--mission-root",
            str(out / "missions"),
            "--cache-root",
            str(out / "cache"),
            "--data-root",
            str(out / "up"),
        ],
        cwd=ROOT,
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    base = f"http://127.0.0.1:{port}"
    store = MissionStore(out / "missions")
    steps: list[dict] = []
    try:
        for _ in range(120):
            try:
                call(base, "GET", "/health")
                break
            except (OSError, RuntimeError):
                time.sleep(0.5)
        m = call(
            base,
            "POST",
            "/missions",
            {
                "name": "Agent end to end (val photos)",
                "area_name": "HERIDAL site BRK",
                "lkp": LKP,
                "subject": "adult, hiker",
            },
        )
        mid = m["mission_id"]
        print(f"mission {mid} in {out}")
        drones = [
            Drone(
                id=f"D{k}",
                name=f"Drone {k}",
                simulated=True,
                position=None,
                altitude_m=50,
                speed_ms=8,
                battery_pct=95,
                max_wind_kmh=38,
                status="idle",
                leg_id=None,
            )
            for k in (1, 2)
        ]
        store.put_fleet(
            mid, FleetState(simulated=True, drones=drones, legs=[], updated_at=m["created_at"])
        )
        print("  simulated fleet: Drone 1, Drone 2 (labelled simulated)")

        def step(name: str) -> None:
            t0 = time.monotonic()
            settle(store, mid)
            s = store.state(mid)
            steps.append(
                {
                    "step": name,
                    "proposals": len(s["proposals"]),
                    "verdicts": len(s["verdicts"]),
                    "trace": len(store.trace_entries(mid)),
                }
            )
            print(
                f"  {name}: agent done after {time.monotonic() - t0:.0f} s · {len(s['proposals'])} proposals, {len(s['verdicts'])} verdicts so far"
            )

        r = upload(base, mid, [VAL / p for p in PHOTOS[: args.photos]])
        print(f"  uploaded {len(r['accepted'])} val photos, rejected {r['rejected']}")
        step("photos")

        cands = sorted(
            (d for ds in store.detections(mid).frames.values() for d in ds if d.crop),
            key=lambda d: -d.conf,
        )
        if cands:
            call(
                base,
                "POST",
                f"/missions/{mid}/reviews",
                {"detection_id": cands[0].id, "answer": "person"},
            )
            print(f"  reviewer: {cands[0].id} ({cands[0].conf:.2f}) is a person")
            step("review: person")
        d = cands[-1] if cands else None
        clue = {
            "kind": "object",
            "text": "blue backpack by the trail",
            "lat": d.lat if d else LKP["lat"],
            "lon": d.lon if d else LKP["lon"],
            "reported_by": "command",
            "source": "form",
            "reliability": "medium",
        }
        c = call(base, "POST", f"/missions/{mid}/clues", clue)
        print(f"  clue {c['id']}: {clue['text']}")
        step("clue")

        pending = [
            p
            for p in store.state(mid)["proposals"]
            if p.status == "pending" and p.kind == "assign_sector"
        ]
        if pending:
            p = call(
                base,
                "POST",
                f"/missions/{mid}/proposals/{pending[0].id}/decide",
                {"decision": "approve", "by": APPROVER},
            )
            print(f"  approved {p['id']} ({APPROVER})")
            step("approval")
    finally:
        server.terminate()
        try:
            server.wait(15)
        except subprocess.TimeoutExpired:
            server.kill()
        log.close()

    s = store.state(mid)
    trace = store.trace_entries(mid)
    summary = {
        "mission": mid,
        "photos": len(store.survey(mid).frames),
        "candidates": sum(1 for ds in store.detections(mid).frames.values() for d in ds if d.crop),
        "map_updates": Counter(u.source for u in store.map_updates(mid)),
        "verdicts": [
            {"detection": v.detection_id, "person": v.person, "tools": v.tools, "ms": v.ms}
            for v in s["verdicts"]
        ],
        "proposals": [
            {
                "id": p.id,
                "kind": p.kind,
                "by": p.created_by,
                "status": p.status,
                "summary": p.summary,
                "reason": p.reason[:200],
                "briefing": p.briefing,
            }
            for p in s["proposals"]
        ],
        "trace": Counter(f"{e.actor}/{e.kind}" for e in trace),
        "model_calls": sum(e.kind == "model_call" for e in trace),
        "tokens": {
            "in": sum(e.tokens_in or 0 for e in trace),
            "out": sum(e.tokens_out or 0 for e in trace),
        },
        "steps": steps,
        "validate_mission": validate_mission(out / "missions", mid),
    }
    (out / "summary.json").write_text(json.dumps(summary, indent=2, default=dict))
    print(
        json.dumps(
            {
                k: summary[k]
                for k in (
                    "photos",
                    "candidates",
                    "map_updates",
                    "model_calls",
                    "tokens",
                    "trace",
                    "validate_mission",
                )
            },
            indent=1,
            default=dict,
        )
    )
    for p in summary["proposals"]:
        print(f"  {p['id']} {p['kind']:17s} {p['status']:9s} {p['by']:8s} {p['summary']}")
    for v in summary["verdicts"]:
        print(f"  verdict {v['detection']}: {v['person']} via {v['tools']} ({v['ms']} ms)")
    return 0 if not summary["validate_mission"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
