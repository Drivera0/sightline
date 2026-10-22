"""The recall moment end to end (the Tavily moment of the Nebius video): gusts → no-fly → recall.

    uv run --extra conditions python scripts/recall_demo.py --serve-local     # a local API, faked
    uv run --extra conditions python scripts/recall_demo.py --api http://127.0.0.1:8000 [--mission ID]

1. A mission at Mount Seymour gets its conditions (Tavily, or ``FakeTavily`` with ``--serve-local``);
   if they say the drones can't fly (a night run), a calm demo override is put in first, labelled.
2. The creek scenario's three simulated drones join (``sightline.search.fleet``, labelled simulated);
   a scripted search manager approves the agent's opening legs and the drones take off.
3. **fetch**: the conditions are looked up again (``POST /conditions/refresh``), then the gusts come:
   ``POST /conditions/override`` with ``gust_kmh=50``, a synthetic record labelled ``override (demo)``
   everywhere (sources, reason, trace, feed), handled exactly like a refresh.
4. **proposal**: the agent proposes recalling each flying drone, the reason quoting the fact, its
   source and the DJI Mavic 3E's 43 km/h limit.
5. **approval**: the scripted manager approves each recall (``decided_by`` says it was scripted).
6. **turning home**: the store cancels each drone's leg (the re-task path) and the sim flies home.

Prints the timeline (wall seconds from the start) and the conditions and agent trace entries, and
saves both under ``runs/recall/<timestamp>/``. ``--serve-local`` starts ``python -m sightline.pipeline
serve`` with the agent and Tavily faked (``SIGHTLINE_FAKE_LLM=1``, ``SIGHTLINE_FAKE_TAVILY=1``) and stops
it by its PID at the end. Validation photos only. ``SIGHTLINE_API_TOKEN`` is sent on writes when set.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
MANAGER = "Search manager (scripted for this run)"
GUST_KMH = 50.0
CALM_KMH = 15.0


def local_file(rel: str) -> Path:
    """``rel`` in this checkout, else in the main checkout (a git worktree has no data/)."""
    here = ROOT / rel
    if here.exists():
        return here
    try:
        common = subprocess.run(["git", "rev-parse", "--git-common-dir"], cwd=ROOT, capture_output=True,
                                text=True, check=True).stdout.strip()  # fmt: skip
        main = (ROOT / common).resolve().parent / rel
        return main if main.exists() else here
    except (OSError, subprocess.CalledProcessError):
        return here


def start_local_api(out: Path) -> tuple[subprocess.Popen, str]:
    """``serve`` on a free port, its missions under ``out/api``, the model and Tavily faked."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    root = out / "api"
    root.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, SIGHTLINE_FAKE_LLM="1", SIGHTLINE_FAKE_TAVILY="1")
    onnx = local_file("web/public/models/sightline-detector-v2.onnx")
    if onnx.exists() and "SIGHTLINE_ONNX" not in env:
        env["SIGHTLINE_ONNX"] = str(onnx)
    cmd = [sys.executable, "-m", "sightline.pipeline", "serve", "--port", str(port),
           "--mission-root", str(root / "missions"), "--cache-root", str(root / "cache"),
           "--data-root", str(root / "up")]  # fmt: skip
    log = open(root / "server.log", "w")  # noqa: SIM115 - the process holds it until stopped
    proc = subprocess.Popen(cmd, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT,
                            start_new_session=True)  # fmt: skip
    print(f"api: serve on :{port} (pid {proc.pid})", flush=True)
    return proc, f"http://127.0.0.1:{port}"


def stop(proc: subprocess.Popen | None, name: str) -> None:
    """Stops a process this script started, by its PID (its own process group)."""
    if proc is None or proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, signal.SIGTERM)
        proc.wait(15)
    except ProcessLookupError:
        return
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.wait(5)
    print(f"stopped {name} (pid {proc.pid})", flush=True)


class Recall:
    """One run of the moment against an API: ``setup`` (mission, flyable, fleet flying), then
    ``gusts`` (fetch, override), ``proposals``, ``approve`` and ``home``. ``mark`` gets each step;
    the video recorder uses the same steps and clicks the console itself instead of ``gusts`` and
    ``approve``."""

    def __init__(self, base: str, mark: Callable[[str], None], time_scale: float = 20.0) -> None:
        import httpx

        from sightline.client import auth_headers

        self.base, self.mark, self.time_scale = base, mark, time_scale
        self.http = httpx.Client(base_url=base, timeout=60, headers=auth_headers())
        self.mid: str | None = None
        self.calm = False  # a calm override was put in at the start (the real ones said no flying)
        self.sim: Any = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def call(self, method: str, path: str, body: dict | None = None) -> Any:
        r = self.http.request(method, path, json=body)
        if r.status_code >= 400:
            raise RuntimeError(f"{method} {path}: {r.status_code} {r.text[:300]}")
        return r.json()

    def state(self) -> dict:
        return self.call("GET", f"/missions/{self.mid}/state")

    def wait(self, what: Callable[[dict], Any], timeout_s: float, every_s: float = 0.3) -> Any:
        end = time.monotonic() + timeout_s
        while time.monotonic() < end:
            got = what(self.state())
            if got:
                return got
            time.sleep(every_s)
        return None

    def decide(self, pid: str) -> None:
        self.call(
            "POST",
            f"/missions/{self.mid}/proposals/{pid}/decide",
            {"decision": "approve", "by": MANAGER},
        )

    # --- 1-2: a mission with drones in the air -----------------------------------------------------

    def setup(self, mission: str | None = None) -> str:
        from sightline.search.fleet import FleetSim, FramePool, Scenario

        for _ in range(180):
            try:
                self.call("GET", "/health")
                break
            except Exception:  # noqa: BLE001 - not up yet
                time.sleep(0.5)
        scn = Scenario.load("creek")
        if mission is None:
            body = {"name": "Recall (simulated fleet)", "area_name": "Mount Seymour",
                    "lkp": scn.lkp.model_dump(), "subject": "adult, red jacket"}  # fmt: skip
            mission = self.call("POST", "/missions", body)["mission_id"]
        self.mid = mission
        self.mark(f"mission {mission} created")
        c = self.wait(lambda s: s["conditions"], 60)
        self.calm = c is not None and c["flyable"] is False
        if self.calm:
            self.call("POST", f"/missions/{mission}/conditions/override",
                      {"gust_kmh": CALM_KMH, "by": "recall_demo (calm start)"})  # fmt: skip
            self.mark(
                f"conditions said no flying ({c['flyability_reason']}): calm override (demo), gusts {CALM_KMH:g} km/h"
            )
        pool = FramePool(scn, val=local_file("data/heridal/yolo_full/val"))
        # no scheduled link losses (the scenario cuts D2's): a drone that hears nothing can't hear
        # its recall; the console's Fleet controls can still degrade a link by hand
        self.sim = FleetSim(self.http, mission, scn, time_scale=self.time_scale, pool=pool,
                            links=(), out=lambda s: self.mark(f"fleet: {s}"))  # fmt: skip
        self.sim.register()
        n = len(scn.drones)

        def openers(s: dict) -> list[dict]:
            got = [
                p for p in s["proposals"] if p["status"] == "pending" and p["kind"] == "drone_leg"
            ]
            return got if len(got) >= n else []

        legs = self.wait(openers, 20) or [
            p for p in self.state()["proposals"] if p["status"] == "pending"
        ]
        for p in legs:
            self.decide(p["id"])
        self.mark(
            f"opening legs approved (scripted): {', '.join(p['leg']['sector_id'] for p in legs)}"
        )
        self._thread = threading.Thread(target=self._fly, daemon=True)
        self._thread.start()
        self.wait(lambda s: all(d["status"] == "flying" for d in s["fleet"]["drones"]), 60)
        time.sleep(8.0)  # well into their legs
        return mission

    def _fly(self) -> None:
        while not self._stop.is_set():
            try:
                self.sim.tick(0.5)
            except Exception as e:  # noqa: BLE001 - keep flying; the timeline says it
                self.mark(f"fleet error: {e}")
            self._stop.wait(0.5)

    # --- 3-6: the moment ---------------------------------------------------------------------------

    def fetch(self) -> dict | None:
        """The real lookup again (cached per hour). Skipped after a calm start: the real conditions
        said no flying, so they would recall the drones for that reason instead of the gusts."""
        if self.calm:
            self.mark(
                "fetch: skipped (the real conditions say no flying now; the calm override stands)"
            )
            return None
        c = self.call("POST", f"/missions/{self.mid}/conditions/refresh")
        gust = "not on the pages read" if c["gust_kmh"] is None else f"{c['gust_kmh']:g} km/h"
        self.mark(
            f"fetch: Tavily lookup ({len(c['sources'])} pages), gusts {gust}, flyable {c['flyable']}"
        )
        return c

    def gusts(self, gust_kmh: float = GUST_KMH) -> dict:
        c = self.call("POST", f"/missions/{self.mid}/conditions/override",
                      {"gust_kmh": gust_kmh, "by": "recall_demo"})  # fmt: skip
        self.mark(
            f"override (demo): gusts {gust_kmh:g} km/h → flyable {c['flyable']}: {c['flyability_reason']}"
        )
        return c

    def proposals(self, timeout_s: float = 20.0) -> list[dict]:
        flying = sum(d["status"] == "flying" for d in self.state()["fleet"]["drones"])

        def recalls(s: dict) -> list[dict]:
            got = [p for p in s["proposals"] if p["status"] == "pending" and "home" in p["target"]]
            return got if len(got) >= flying else []

        got = self.wait(recalls, timeout_s) or []
        for p in got:
            self.mark(f"proposal {p['id']} {p['summary']}: {p['reason']}")
        return got

    def approve(self, recalls: list[dict]) -> None:
        for p in recalls:
            self.decide(p["id"])
            self.mark(f"approved {p['id']} (scripted)")

    def home(self, timeout_s: float = 60.0) -> None:
        """Each drone turning home (the sim's own lines go to the timeline too), then landing."""
        seen: set[str] = set()

        def turning(s: dict) -> bool:
            for d in s["fleet"]["drones"]:
                if d["status"] == "returning" and d["id"] not in seen:
                    seen.add(d["id"])
                    p = d["position"]
                    self.mark(
                        f"{d['name']} turning home: battery {d['battery_pct']:.0f} %, at {p['lat']:.5f}, {p['lon']:.5f}"
                    )
            return all(d["status"] != "flying" for d in s["fleet"]["drones"])

        self.wait(turning, timeout_s)
        landed = self.wait(
            lambda s: all(d["status"] == "idle" for d in s["fleet"]["drones"]), timeout_s
        )
        self.mark("all drones home" if landed else "gave up waiting for the drones to land")

    def close(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(5)
        self.http.close()


def excerpt(trace: list[dict]) -> list[str]:
    """The conditions lookups, the override and the agent's recall chain, one line each."""
    keep = []
    for e in trace:
        if e["actor"] == "conditions" or (
            e["actor"] == "agent" and ("Recall" in e["summary"] or "No drone legs" in e["summary"])
        ):
            keep.append(f"{e['at'][11:19]}  {e['actor']:10} {e['kind']:10} {e['summary']}")
    return keep


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--api", help="mission API base URL")
    ap.add_argument(
        "--serve-local",
        action="store_true",
        help="start (and stop) a local API, model and Tavily faked",
    )
    ap.add_argument("--mission", help="use this mission instead of a new one")
    ap.add_argument("--gust", type=float, default=GUST_KMH, help="km/h for the demo override")
    ap.add_argument("--time-scale", type=float, default=20.0)
    args = ap.parse_args(argv)
    if not (args.api or args.serve_local):
        ap.error("give --api URL or --serve-local")

    out = ROOT / "runs/recall" / time.strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True)
    t0 = time.monotonic()
    timeline: list[tuple[float, str]] = []

    def mark(what: str) -> None:
        timeline.append((round(time.monotonic() - t0, 1), what))
        print(f"  {timeline[-1][0]:6.1f} s  {what}", flush=True)

    server = None
    run = None
    try:
        if args.serve_local:
            server, base = start_local_api(out)
        else:
            base = args.api.rstrip("/")
        run = Recall(base, mark, args.time_scale)
        mid = run.setup(args.mission)
        run.fetch()
        run.gusts(args.gust)
        recalls = run.proposals()
        if not recalls:
            mark("no recall proposed")
        run.approve(recalls)
        run.home()
        trace = run.call("GET", f"/missions/{mid}/trace")
        ok = bool(recalls)
    finally:
        if run is not None:
            run.close()
        stop(server, "api")
    lines = excerpt(trace)
    print("\ntrace excerpt:\n" + "\n".join(lines))
    (out / "recall_demo.json").write_text(json.dumps(
        {"mission": mid, "api": "local (fake model and Tavily)" if args.serve_local else base,
         "timeline": timeline, "trace_excerpt": lines, "complete": ok}, indent=1))  # fmt: skip
    print(f"\n{'complete' if ok else 'INCOMPLETE'}: {out / 'recall_demo.json'}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
