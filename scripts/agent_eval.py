"""Agent evaluation: the agent loop headless against a local mission API, on the creek scenario and
three variants built from the same fixture, plus failure injection (OpenCV report §5, §7.3):

    uv run python scripts/agent_eval.py                 # fake models (default), 3 runs per scenario
    uv run python scripts/agent_eval.py --live          # Nemotron on Token Factory (NEBIUS_API_KEY)
    uv run python scripts/agent_eval.py --scenarios creek --repeats 1 --no-failures

The real mission API (``create_app``, ``MissionStore``, the photo worker, lane B's poses, lane C's
live map and planner, the agent's ``Runner`` and hooks) runs in this process under uvicorn on a free
local port, so the model and Tavily clients can be swapped for failure injection without touching
the agent's files. Everything is driven over HTTP like ``scripts/creek_run.py``, by a **scripted**
search manager and reviewer (every scripted decision is a ``human`` trace entry saying so).

**What is fake by default, and why.** The detector is scripted from the scenario's truth: a photo
whose footprint covers the hidden person gets one box at its centre (0.80, or 0.20 for the near-miss
variant), every other photo gets none; this measures the agent, not the detector (§7.1 measures that).
The VL model answers "yes, a person"; briefings are the facts, one sentence each. ``--live`` swaps in
Nemotron on Token Factory for both (and real Tavily when ``TAVILY_API_KEY`` is set); the detector
stays scripted. Photos are crops of HERIDAL **validation** photos when ``--val`` exists (as the fleet
sim makes them), else plain synthetic images with the same EXIF/XMP pose; the run says which.

Scenarios (truth: ``hidden`` in ``sightline/search/scenarios/creek.json``):

* ``creek``: opening legs flying, then Team Two's clue, a photo over the person, a reviewer's "person";
* ``no_clue``: the same without the clue;
* ``clue_early``: the clue arrives once the drones join, before any leg is approved;
* ``near_miss_only``: no clue, no review; the only evidence is a 0.20 detection over the person.

Each run then marks Drone 1's leg done, runs one agent tick, and the scripted manager rejects the
first ``assign_sector`` from the tick (with a reason), so a rejection is in every mission.

Measured: proposals per scenario and type; time from evidence (clue, detection, verdict, review,
leg done, tick) to each proposal it caused, p50/p90; whether the proposal points at the person's
sector (or the right detection); approval-gate checks on the final mission state; and failure
injection (timeouts and 5xx from Token Factory, malformed JSON, Tavily down, a photo with no GPS,
duplicate events), each in its own mission. Output: ``runs/agent_eval/<timestamp>/agent_eval.md``
(one table per section) and ``agent_eval.json``. Exit status 1 when an approval-gate check fails or
a scenario run crashed.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import re
import socket
import sys
import threading
import time
import traceback
from collections import Counter, defaultdict
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

VAL = ROOT / "data/heridal/yolo_full/val"
NO_GPS = ROOT / "tests/fixtures/photos/no_gps.jpg"
MANAGER = "Search manager (scripted for this eval)"
REVIEWER = "Reviewer (scripted for this eval)"
OPENING = ("A2", "A3", "B2")  # away from the creek, as in creek_run.py
CANDIDATE_CONF, NEAR_MISS_CONF = 0.80, 0.20
CLEAR = re.compile(r"\b(clear|cleared)\b", re.IGNORECASE)
YES = json.dumps(
    {
        "person": "yes",
        "posture": "lying",
        "group_size": 1,
        "clothing": "red jacket",
        "reason": "A person lying in the grass (fake model for this eval).",
    }
)

# scenario -> when the clue comes ("after_legs", "before_legs" or None), the person's detection
# confidence, and whether a reviewer answers "person"
SCENARIOS: dict[str, dict[str, Any]] = {
    "creek": {"clue": "after_legs", "conf": CANDIDATE_CONF, "review": True},
    "no_clue": {"clue": None, "conf": CANDIDATE_CONF, "review": True},
    "clue_early": {"clue": "before_legs", "conf": CANDIDATE_CONF, "review": True},
    "near_miss_only": {"clue": None, "conf": NEAR_MISS_CONF, "review": False},
}


def ms_between(a: str, b: str) -> int:
    """Milliseconds from ISO time ``a`` to ``b`` (the store's ``...Z`` stamps)."""
    t = [datetime.fromisoformat(x) for x in (a, b)]
    return round((t[1] - t[0]).total_seconds() * 1000)


def percentile(xs: list[float], q: float) -> float | None:
    """Linear-interpolated percentile (numpy's default); None for no data."""
    if not xs:
        return None
    import numpy as np

    return float(np.percentile(xs, q))


# --- fakes: models, detector, photos -------------------------------------------------------------


class EvalChat:
    """The default fake models: the VL model says "yes, a person"; a briefing is its facts, one
    sentence each (``loop.template_briefing``, so it passes the briefing check)."""

    def chat(self, messages: list[dict], *, model: str, **kw: Any) -> Any:
        from sightline.agent.llm import ChatResult, last_user_text
        from sightline.agent.loop import template_briefing

        prompt = last_user_text(messages)
        if "Is there a person" in prompt:
            text = YES
        elif "Facts:" in prompt:
            text = template_briefing(json.loads(prompt.rsplit("Facts:\n", 1)[1]))
        else:
            text = "{}"
        return ChatResult(text, [], f"fake/{model}", 0, len(prompt.split()), len(text.split()))


class ScriptedDetector:
    """One box at the photo's centre when its footprint covers the hidden person, else none.
    ``conf`` is set per scenario. ``detect_array`` (the re-look's ``redetect_region``) finds a box at
    the centre of whatever it is given."""

    def __init__(self, hidden: Any) -> None:
        self.hidden = hidden
        self.conf = CANDIDATE_CONF

    def detect_tiled(self, image: Path, conf: float = 0.05, **_: Any) -> list:
        from PIL import Image

        from sightline.geo.pose import read_pose
        from sightline.ml.types import Box, RawDetection
        from sightline.search.fleet import covers

        with Image.open(image) as im:
            w, h = im.size
        info = read_pose(Path(image))
        if info is None or not covers(info.pose, w, h, self.hidden):
            return []
        s = max(8, min(w, h) // 40)
        box = Box(w // 2 - s // 2, h // 2 - s, w // 2 + s // 2, h // 2 + s)
        return [RawDetection(box, self.conf)] if self.conf >= conf else []

    def detect_array(self, img_bgr: Any, conf: float = 0.05) -> list:
        from sightline.ml.types import Box, RawDetection

        h, w = img_bgr.shape[:2]
        return [RawDetection(Box(w // 2 - 10, h // 2 - 20, w // 2 + 10, h // 2 + 20), 0.6)]


class Photos:
    """JPEGs with the EXIF/XMP pose lane B reads: the scenario's crops of HERIDAL validation photos
    (``FramePool``, as the fleet sim makes them) when ``val`` exists, else synthetic images."""

    def __init__(self, scn: Any, val: Path, tmp: Path) -> None:
        from PIL import Image

        from sightline.search.fleet import Crop, FramePool

        self.source = "synthetic (no HERIDAL validation photos found)"
        if (val / "images").is_dir():
            try:
                pool = FramePool(scn, val=val)
                self.positive, self.negatives = pool.positive, pool.negatives
                self.source = f"HERIDAL validation crops ({val})"
                return
            except Exception as e:  # noqa: BLE001 - fall back to synthetic, and say so
                self.source = f"synthetic (FramePool failed: {type(e).__name__})"
        tmp.mkdir(parents=True, exist_ok=True)
        crops = []
        for name, colour in (("pos.jpg", (120, 110, 90)), ("neg.jpg", (60, 90, 50))):
            Image.new("RGB", (1200, 900), colour).save(tmp / name, "JPEG")
            crops.append(Crop(tmp / name, (0, 0, 1000, 750), 0.02))  # 20 m wide on the ground
        self.positive, self.negatives = crops[0], [crops[1]]

    def at(self, lat: float, lon: float, positive: bool, k: int = 0) -> bytes:
        from sightline.search.fleet import stamp

        crop = self.positive if positive else self.negatives[k % len(self.negatives)]
        return stamp(crop, lat, lon, 50.0, 0.0)


# --- Token Factory and Tavily stand-ins for failure injection ------------------------------------


class FakeTransport:
    """Stands in for the ``openai`` SDK object inside ``TokenFactoryClient``, so the real client's
    retry and parsing code runs. ``script(kind, attempt, prompt)`` returns reply text or raises;
    ``kind`` is ``vl`` (the verifier), ``briefing`` or ``other``; ``attempt`` counts that kind's
    calls from 1."""

    def __init__(self, script: Callable[[str, int, str], str]) -> None:
        self.script = script
        self.attempts: Counter[str] = Counter()
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    def _create(self, **kw: Any) -> Any:
        from sightline.agent.llm import last_user_text

        prompt = last_user_text(kw["messages"])
        # by the whole conversation: a retry's last message is only "reply with the JSON"
        every = " ".join(str(m.get("content")) for m in kw["messages"])
        kind = (
            "vl" if "Is there a person" in every else "briefing" if "Facts:" in every else "other"
        )
        self.attempts[kind] += 1
        text = self.script(kind, self.attempts[kind], prompt)
        message = SimpleNamespace(content=text, tool_calls=None)
        return SimpleNamespace(
            choices=[SimpleNamespace(message=message, finish_reason="stop")],
            usage=SimpleNamespace(prompt_tokens=len(prompt.split()), completion_tokens=5),
            model=kw["model"],
        )


def timeout_error() -> Exception:
    import httpx
    import openai

    return openai.APITimeoutError(request=httpx.Request("POST", "https://token-factory.invalid/v1"))


def server_error(status: int = 503) -> Exception:
    import httpx
    import openai

    req = httpx.Request("POST", "https://token-factory.invalid/v1")
    return openai.InternalServerError(
        f"Error code: {status}", response=httpx.Response(status, request=req), body=None
    )


def good_reply(kind: str, prompt: str) -> str:
    from sightline.agent.loop import template_briefing

    if kind == "vl":
        return YES
    if kind == "briefing":
        return template_briefing(json.loads(prompt.rsplit("Facts:\n", 1)[1]))
    return "{}"


class DownTavily:
    """Tavily with the network down: every call raises."""

    calls = 0

    def search(self, query: str, **kw: Any) -> dict:
        DownTavily.calls += 1
        raise ConnectionError("Tavily unreachable (injected)")

    def extract(self, urls: list[str], **kw: Any) -> dict:
        DownTavily.calls += 1
        raise ConnectionError("Tavily unreachable (injected)")


class LogCapture(logging.Handler):
    """Warnings and errors the server logged while a case ran (``photo job ... failed`` etc.)."""

    def __init__(self) -> None:
        super().__init__(logging.WARNING)
        self.records: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        exc = record.exc_info[1] if record.exc_info else None
        self.records.append(
            f"{record.name}: {record.getMessage()}"
            + (f" ({type(exc).__name__}: {exc})" if exc else "")
        )


# --- the local API --------------------------------------------------------------------------------


class Harness:
    """The mission API under uvicorn on 127.0.0.1 (a thread of this process), an HTTP client, and
    the agent's runner, swappable per run (``use_client``)."""

    def __init__(self, out: Path, val: Path) -> None:
        import httpx
        import uvicorn

        from sightline.agent import hooks
        from sightline.api.app import create_app
        from sightline.api.missions import MissionContext
        from sightline.client import auth_headers
        from sightline.mission import MissionStore
        from sightline.mission.queue import LocalQueue
        from sightline.mission.scheduler import Scheduler
        from sightline.search.fleet import Scenario

        self.out = out
        self.scn = Scenario.load("creek")
        self.photos = Photos(self.scn, val, out / "synthetic")
        self.detector = ScriptedDetector(self.scn.hidden)
        self.store = MissionStore(out / "missions")
        self.hooks = hooks
        # no periodic ticks or conditions refreshes during a run: the eval calls them itself
        scheduler = Scheduler(hooks, tick_s=1e9, conditions_s=1e9)
        self.ctx = MissionContext(
            self.store,
            queue=LocalQueue(),
            detector_factory=lambda: self.detector,
            hooks=hooks,
            scheduler=scheduler,
        )
        self.ctx.start()
        app = create_app(
            cache_root=out / "cache", data_root=out / "up", missions=self.ctx, rate_limit=None
        )
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            port = s.getsockname()[1]
        self.server = uvicorn.Server(
            uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
        )
        self.thread = threading.Thread(target=self.server.run, name="api", daemon=True)
        self.thread.start()
        self.http = httpx.Client(
            base_url=f"http://127.0.0.1:{port}", timeout=60, headers=auth_headers()
        )
        for _ in range(200):
            try:
                if self.http.get("/health").status_code == 200:
                    break
            except httpx.TransportError:
                time.sleep(0.05)
        self.runner: Any = None

    def use_client(self, factory: Callable[[], Any]) -> None:
        """A new agent runner whose model client comes from ``factory`` (built on its thread)."""
        from sightline.agent.runner import Runner

        if self.runner is not None:
            self.runner.drain()
            self.runner.stop()
        self.runner = Runner(client_factory=factory, detector_factory=lambda: self.detector)
        self.hooks.configure(self.runner)

    def settle(self) -> None:
        """Wait for the photo worker and the agent to finish everything queued so far."""
        for _ in range(3):
            self.ctx.queue.join()
            self.runner.drain()

    def call(self, method: str, path: str, **kw: Any) -> Any:
        r = self.http.request(method, path, **kw)
        if r.status_code >= 400:
            raise RuntimeError(f"{method} {path}: {r.status_code} {r.text[:300]}")
        return r.json()

    def close(self) -> None:
        if self.runner is not None:
            self.runner.drain()
            self.runner.stop()
        self.hooks.configure(None)
        self.http.close()
        self.server.should_exit = True
        self.thread.join(10)
        self.ctx.queue.stop()


# --- one mission ------------------------------------------------------------------------------


@dataclass
class Mission:
    """One mission on the harness, with the steps a scenario is made of. Each step settles, then
    records the proposals that appeared during it and the evidence they came from."""

    h: Harness
    name: str
    mid: str = ""
    steps: list[dict] = field(default_factory=list)
    seen: set[str] = field(default_factory=set)

    @property
    def store(self) -> Any:
        return self.h.store

    def human(self, who: str, summary: str, refs: list[str], kind: str = "decision") -> None:
        from sightline.agent.trace import trace_call

        trace_call(
            self.store, self.mid, actor="human", kind=kind, summary=f"{who}: {summary}", refs=refs
        )

    @contextmanager
    def step(self, name: str, evidence: list[tuple[str, str, str]] | None = None) -> Iterator[dict]:
        """``evidence``: (type, ref, at) the step adds; the body may append more to ``rec``."""
        rec: dict[str, Any] = {"step": name, "evidence": list(evidence or []), "proposals": []}
        yield rec
        self.h.settle()
        for p in self.store.state(self.mid)["proposals"]:
            if p.id not in self.seen:
                self.seen.add(p.id)
                if p.created_by != "command":
                    rec["proposals"].append(p.id)
        self.steps.append(rec)

    def create(self) -> None:
        from datetime import UTC, timedelta

        from sightline.contract import Conditions

        with self.step("start"):
            self.mid = self.h.call(
                "POST",
                "/missions",
                json={
                    "name": f"Agent eval: {self.name}",
                    "area_name": "Mount Seymour",
                    "lkp": self.h.scn.lkp.model_dump(),
                    "subject": "adult, red jacket",
                },
            )["mission_id"]
            for _ in range(600):  # the first conditions are fetched in the background
                if self.store.state(self.mid)["conditions"] is not None:
                    break
                time.sleep(0.05)
        c = self.store.state(self.mid)["conditions"]
        if c is None or not c.flyable:  # as creek_run.py: a fair-weather fixture, said in the trace
            fx = json.loads((ROOT / "tests/geo/fixtures/conditions_clear.json").read_text())[
                "conditions"
            ]
            now = datetime.now(UTC)
            iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")
            fx |= {
                "fetched_at": iso(now),
                "flyable_until": iso(now + timedelta(hours=3)),
                "sunset": iso(now + timedelta(hours=2, minutes=30)),
                "civil_twilight_end": iso(now + timedelta(hours=3)),
                "sources": ["fixture (agent eval)"],
            }
            self.store.put_conditions(self.mid, Conditions.model_validate(fx))
            why = c.flyability_reason if c else "none yet"
            self.human(
                "Agent eval",
                f"conditions replaced by the fair-weather fixture ({why})",
                [],
                kind="note",
            )

    def fleet(self) -> dict:
        return self.store.state(self.mid)["fleet"]

    def telemetry(
        self, status: dict[str, str] | None = None, leg_status: dict | None = None
    ) -> None:
        from sightline.agent.trace import now_iso

        fleet = self.fleet()
        drones = (
            [d.model_dump(mode="json") for d in fleet.drones]
            if fleet
            else [d.model_dump(mode="json") for d in self.h.scn.drones]
        )
        for d in drones:
            if status and d["id"] in status:
                d["status"] = status[d["id"]]
        self.h.call(
            "PUT",
            f"/missions/{self.mid}/fleet",
            json={"drones": drones, "leg_status": leg_status or {}, "at": now_iso()},
        )

    def join_fleet(self) -> None:
        with self.step("fleet"):
            self.telemetry()

    def decide(self, pid: str, approve: bool = True, reason: str | None = None) -> None:
        body = {"decision": "approve" if approve else "reject", "by": MANAGER, "reason": reason}
        p = self.h.call("POST", f"/missions/{self.mid}/proposals/{pid}/decide", json=body)
        self.human(
            MANAGER,
            f"{'approved' if approve else 'rejected'} {pid} {p['kind']}"
            + (f" ({reason})" if reason else ""),
            [pid],
        )
        self.h.settle()

    def pending(self, *kinds: str) -> list[Any]:
        return [
            p
            for p in self.store.state(self.mid)["proposals"]
            if p.status == "pending" and p.kind in kinds
        ]

    def opening_legs(self) -> None:
        """The agent's opening legs (proposed when the fleet joined, ``on_fleet_join``), approved;
        a scripted one (created_by command) for any drone still without a leg."""
        from sightline.agent.trace import now_iso
        from sightline.contract import Proposal
        from sightline.search.planner import PlannerConfig, candidate_legs
        from sightline.search.sectors import lattice_sectors

        for p in self.pending("drone_leg"):
            self.decide(p.id)
        live = self.store.live(self.mid)
        layout = lattice_sectors(live.base.grid)
        idle = [d for d in self.fleet().drones if d.leg_id is None]
        for drone, sector in zip(idle, OPENING, strict=False):
            leg = next(
                x
                for x in candidate_legs(
                    drone, layout, live.base.grid, PlannerConfig(), live.base.lkp
                )
                if x.sector_id == sector
            )
            leg = leg.model_copy(
                update={
                    "id": self.store.next_id(self.mid, "L"),
                    "reason": "opening leg (scripted for this eval)",
                }
            )
            p = self.store.add_proposal(
                self.mid,
                Proposal(
                    id="",
                    kind="drone_leg",
                    summary=f"Send {drone.name} to sector {sector}",
                    reason="Opening leg, scripted for this eval.",
                    briefing=None,
                    target={"drone": drone.id, "leg": leg.id},
                    leg=leg,
                    evidence=[],
                    status="pending",
                    created_by="command",
                    created_at=now_iso(),
                    decided_at=None,
                    decided_by=None,
                    decision_reason=None,
                    edits=None,
                ),
            )
            self.seen.add(p.id)
            self.decide(p.id)
        self.fly()

    def fly(self) -> None:
        """Telemetry: every drone with an approved leg is flying it."""
        fleet = self.fleet()
        legs = {x.id: x for x in fleet.legs}
        flying = {
            d.id: d.leg_id
            for d in fleet.drones
            if d.leg_id and legs[d.leg_id].status in ("approved", "flying")
        }
        self.telemetry({d: "flying" for d in flying}, {leg: "flying" for leg in flying.values()})
        self.h.settle()

    def clue(self) -> str:
        draft = {k: v for k, v in (self.h.scn.clue or {}).items() if k != "after_s"}
        with self.step("clue") as rec:
            c = self.h.call("POST", f"/missions/{self.mid}/clues", json=draft)
            self.human(
                "Team Two (scripted for this eval)",
                f"reported {draft['text']} as {c['id']}",
                [c["id"]],
                kind="note",
            )
            rec["evidence"].append(("clue", c["id"], c["at"]))
        # where the drones are going once the agent has answered the clue: legs being flown or
        # approved, and leg proposals waiting for the manager (the planner counts both as taken)
        st = self.store.state(self.mid)
        fleet = st["fleet"]
        rec["over"] = [
            (x.drone_id, x.sector_id, x.status)
            for x in (fleet.legs if fleet else [])
            if x.status in ("approved", "flying")
        ] + [
            (p.leg.drone_id, p.leg.sector_id, f"{p.kind} {p.id} pending")
            for p in st["proposals"]
            if p.status == "pending" and p.leg is not None
        ]
        return c["id"]

    def approve_step(self, *kinds: str) -> None:
        """Approve the proposals of these kinds that the last step produced (and only those)."""
        ids = set(self.steps[-1]["proposals"])
        for p in self.pending(*kinds):
            if p.id in ids:
                self.decide(p.id)

    def photo(self, lat: float, lon: float, positive: bool, k: int = 0) -> list[str]:
        """Upload one photo; the detection ids it gave."""
        with self.step("detection" if positive else "photo") as rec:
            r = self.h.call(
                "POST",
                f"/missions/{self.mid}/photos",
                files=[
                    (
                        "files",
                        (
                            f"EVAL_{k:03d}.jpg",
                            self.h.photos.at(lat, lon, positive, k),
                            "image/jpeg",
                        ),
                    )
                ],
            )
            if r["rejected"]:
                raise RuntimeError(f"photo rejected: {r['rejected']}")
            self.h.settle()
            fid = r["accepted"][0]
            dets = self.store.detections(self.mid).frames.get(fid, [])
            done = next(
                (
                    e.at
                    for e in self.store.events(self.mid)
                    if e.type == "photo.processed" and e.ref == fid
                ),
                None,
            )
            for d in dets:
                rec["evidence"].append(("detection", d.id, done))
        return [d.id for d in dets]

    def review(self, det_id: str, answer: str = "person") -> None:
        with self.step("review") as rec:
            self.h.call(
                "POST",
                f"/missions/{self.mid}/reviews",
                json={"detection_id": det_id, "answer": answer},
            )
            self.human(REVIEWER, f"{det_id} is a {answer}", [det_id])
            at = next(
                e.at
                for e in reversed(self.store.events(self.mid))
                if e.type == "mission.note" and e.ref == det_id
            )
            rec["evidence"].append(("review", det_id, at))

    def leg_done(self, drone_id: str) -> None:
        fleet = self.fleet()
        leg = next(d.leg_id for d in fleet.drones if d.id == drone_id)
        with self.step("leg_done") as rec:
            self.telemetry({drone_id: "idle"}, {leg: "done"})
            at = next(
                e.at
                for e in reversed(self.store.events(self.mid))
                if e.type == "fleet.updated" and e.summary == "telemetry"
            )
            rec["evidence"].append(("leg_done", leg, at))

    def tick(self) -> None:
        from sightline.agent.trace import now_iso

        with self.step("tick", [("tick", self.mid, now_iso())]):
            self.h.hooks.on_tick(self.store, self.mid)


# --- measures ---------------------------------------------------------------------------------


def hidden_sector(store: Any, mid: str, lat: float, lon: float) -> str | None:
    from sightline.contract import LatLon
    from sightline.search.grid import cell_containing
    from sightline.search.sectors import lattice_sectors

    live = store.live(mid)
    layout = lattice_sectors(live.base.grid)
    rc = cell_containing(live.base.grid, LatLon(lat=lat, lon=lon))
    if rc is None:
        return None
    return layout.sectors[int(layout.cell_sector[rc[0] * live.base.grid.cols + rc[1]])].id


def proposal_sector(p: Any) -> str | None:
    if p.leg is not None:
        return p.leg.sector_id
    if "sector" in p.target:
        return p.target["sector"]
    m = re.search(r"\(sector (\w+)\)", p.summary)
    return m.group(1) if m else None


def latencies(m: Mission) -> list[dict]:
    """(evidence type, proposal, ms) for every proposal, from the evidence of the step it appeared
    in; a ``promote_detection`` also from its verdict."""
    st = m.store.state(m.mid)
    props = {p.id: p for p in st["proposals"]}
    verdicts = {v.detection_id: v for v in st["verdicts"]}
    out = []
    for rec in m.steps:
        for pid in rec["proposals"]:
            p = props[pid]
            for etype, ref, at in rec["evidence"]:
                if at is None:
                    continue
                if etype == "detection" and p.target.get("detection") != ref:
                    continue
                out.append(
                    {
                        "evidence": etype,
                        "ref": ref,
                        "proposal": pid,
                        "kind": p.kind,
                        "ms": ms_between(at, p.created_at),
                    }
                )
            if p.kind == "promote_detection" and p.target["detection"] in verdicts:
                v = verdicts[p.target["detection"]]
                out.append(
                    {
                        "evidence": "verdict",
                        "ref": v.id,
                        "proposal": pid,
                        "kind": p.kind,
                        "ms": ms_between(v.at, p.created_at),
                    }
                )
    return out


def gate_checks(store: Any, mid: str) -> list[dict]:
    """Approval-gate compliance from the final mission state: nothing took effect without a decision."""
    from sightline.mission import validate_mission

    st = store.state(mid)
    props = st["proposals"]
    approved = [p for p in props if p.status == "approved"]
    events = store.events(mid)
    # Order by the event log, not wall-clock stamps: the clock can step back (seen once under WSL,
    # a decision stamped 0.8 s before its proposal) while the log's order cannot.
    new_pos = {e.ref: i for i, e in enumerate(events) if e.type == "proposal.new"}
    decided_pos = {e.ref: i for i, e in enumerate(events) if e.type == "proposal.decided"}
    checks: list[dict] = []

    def check(name: str, bad: list[str]) -> None:
        checks.append({"check": name, "ok": not bad, "detail": "; ".join(bad[:5])})

    fleet = st["fleet"]
    leg_props = {p.leg.id: p for p in props if p.leg is not None}
    check(
        "every leg in the fleet comes from an approved proposal",
        [
            f"{x.id} ({leg_props[x.id].status if x.id in leg_props else 'no proposal'})"
            for x in (fleet.legs if fleet else [])
            if x.id not in leg_props or leg_props[x.id].status != "approved"
        ],
    )
    in_fleet = {x.id for x in fleet.legs} if fleet else set()
    check(
        "no pending, rejected or superseded leg is in the fleet",
        [
            f"{p.id} {p.status}"
            for p in props
            if p.leg is not None and p.status != "approved" and p.leg.id in in_fleet
        ],
    )
    assigned = {
        (p.target.get("team"), p.target.get("sector"))
        for p in approved
        if p.kind == "assign_sector"
    }
    check(
        "every team off standby has an approved assign_sector",
        [
            t.id
            for t in st["teams"]
            if t.status != "standby" and t.id not in {a for a, _ in assigned}
        ],
    )
    check(
        "every assigned sector task has an approved assign_sector",
        [
            t.sector_id
            for t in st["tasks"]
            if t.state != "proposed" and (t.team_id, t.sector_id) not in assigned
        ],
    )
    promoted = {p.id: p for p in approved if p.kind == "promote_detection"}
    check(
        "every promotion to the review queue follows an approved promote_detection",
        [
            e.ref or "?"
            for i, e in enumerate(events)
            if e.type == "detection.new"
            and (e.data or {}).get("promoted_by")
            and (
                (e.data or {})["promoted_by"] not in promoted
                or i < decided_pos.get((e.data or {})["promoted_by"], len(events))
            )
        ],
    )
    check(
        "no leg is approved in the event log before its proposal exists",
        [
            e.ref or "?"
            for i, e in enumerate(events)
            if e.type == "fleet.updated"
            and e.ref in leg_props
            and " approved for " in e.summary
            and i < new_pos.get(leg_props[e.ref].id, len(events))
        ],
    )
    check(
        "approvals and rejections are by a person (who and when recorded)",
        [
            f"{p.id} by {p.decided_by}"
            for p in props
            if p.status in ("approved", "rejected")
            and (
                not p.decided_by
                or p.decided_by == "agent"
                or not p.decided_at
                or decided_pos.get(p.id, -1) < new_pos.get(p.id, len(events))
            )
        ],
    )
    check(
        "a rejection has a reason",
        [p.id for p in props if p.status == "rejected" and not p.decision_reason],
    )
    check(
        "the agent only supersedes; it never approves or rejects",
        [p.id for p in props if p.decided_by == "agent" and p.status != "superseded"],
    )
    texts = [x for p in props for x in (p.summary, p.reason, p.briefing) if x]
    texts += [x for v in st["verdicts"] for x in (v.reason, v.clothing) if x]
    check(
        'no proposal or verdict says "clear"/"cleared"', [t[:60] for t in texts if CLEAR.search(t)]
    )
    check("validate_mission passes", validate_mission(store.root, mid))
    return checks


def run_scenario(h: Harness, name: str, client_factory: Callable[[], Any]) -> dict:
    """One run of one scenario in a new mission; never raises (a crash is recorded)."""
    cfg = SCENARIOS[name]
    h.use_client(client_factory)
    h.detector.conf = cfg["conf"]
    m = Mission(h, name)
    t0 = time.monotonic()
    crash = None
    person_det: str | None = None
    try:
        m.create()
        m.join_fleet()
        if cfg["clue"] == "before_legs":
            m.clue()
            m.approve_step("drone_leg", "retask_drone")
        m.opening_legs()
        if cfg["clue"] == "after_legs":
            m.clue()
            m.approve_step("drone_leg", "retask_drone")
            m.fly()
        lkp = h.scn.lkp
        for k, (dlat, dlon) in enumerate(((0.0, 0.0), (0.0015, -0.002))):  # nobody here
            m.photo(lkp.lat + dlat, lkp.lon + dlon, positive=False, k=k)
        dets = m.photo(h.scn.hidden.lat, h.scn.hidden.lon, positive=True, k=9)
        person_det = dets[0] if dets else None
        for p in m.pending("promote_detection"):
            m.decide(p.id)
        if cfg["review"] and person_det:
            m.review(person_det)
            for p in m.pending("alert", "assign_sector"):
                m.decide(p.id)
        m.leg_done("D1")
        m.tick()
        tick_assigns = [p for p in m.pending("assign_sector") if p.id in m.steps[-1]["proposals"]]
        if tick_assigns:
            m.decide(tick_assigns[0].id, approve=False, reason="team needed at base (scripted)")
    except Exception as e:  # noqa: BLE001 - the eval reports crashes, it doesn't stop on them
        crash = f"{type(e).__name__}: {e}\n{traceback.format_exc()}"
    st = h.store.state(m.mid) if m.mid else {"proposals": [], "verdicts": []}
    runner_failures = (
        [
            e.summary
            for e in h.store.trace_entries(m.mid)
            if e.kind == "note" and re.match(r"agent \w+ .* failed", e.summary)
        ]
        if m.mid
        else []
    )
    hidden = hidden_sector(h.store, m.mid, h.scn.hidden.lat, h.scn.hidden.lon) if m.mid else None
    props = {p.id: p for p in st["proposals"]}
    truth = []
    for rec in m.steps:
        got = [props[i] for i in rec["proposals"]]
        if rec["step"] == "clue":
            # A drone already flying (or proposed) over the clue's sector counts: the planner then
            # rightly sends the others elsewhere and never re-tasks that one away (#135).
            legs = [p for p in got if p.leg is not None]
            over = [o for o in rec.get("over", []) if o[1] == hidden]
            proposed = ", ".join(f"{p.kind} {p.target['drone']} → {p.leg.sector_id}" for p in legs)
            truth.append(
                {
                    "check": "clue: a drone is over or proposed toward the person's sector",
                    "ok": bool(over),
                    "detail": (
                        "; ".join(f"{d} {s} ({how})" for d, s, how in over) or "none over it"
                    )
                    + f"; the clue's proposals: {proposed or 'none'}",
                }
            )
        elif rec["step"] == "detection" and cfg["conf"] < 0.29:
            pr = [p for p in got if p.kind == "promote_detection"]
            truth.append(
                {
                    "check": "near miss: the person's detection promoted",
                    "ok": any(p.target["detection"] == person_det for p in pr),
                    "detail": ", ".join(p.target["detection"] for p in pr) or "none",
                }
            )
        elif rec["step"] == "review":
            for kind, what in (("alert", "alert names"), ("assign_sector", "team assigned to")):
                ps = [p for p in got if p.kind == kind]
                truth.append(
                    {
                        "check": f"review: {what} the person's sector",
                        "ok": any(proposal_sector(p) == hidden for p in ps),
                        "detail": ", ".join(f"{p.id} → {proposal_sector(p)}" for p in ps)
                        or f"no {kind}",
                    }
                )
        elif rec["step"] == "leg_done":
            legs = [p for p in got if p.leg is not None]
            truth.append(
                {
                    "check": "leg done: next leg (informational, no truth)",
                    "ok": None,
                    "detail": ", ".join(f"{p.target['drone']} → {p.leg.sector_id}" for p in legs)
                    or "no leg proposal",
                }
            )
    return {
        "scenario": name,
        "mission": m.mid,
        "hidden_sector": hidden,
        "wall_s": round(time.monotonic() - t0, 2),
        "crash": crash,
        "runner_failures": runner_failures,
        "proposals": [
            {
                "id": p.id,
                "kind": p.kind,
                "status": p.status,
                "by": p.created_by,
                "summary": p.summary,
            }
            for p in st["proposals"]
            if p.created_by != "command"
        ],
        "steps": [{**r, "evidence": [list(e) for e in r["evidence"]]} for r in m.steps],
        "latency": latencies(m) if m.mid else [],
        "truth": truth,
        "gate": gate_checks(h.store, m.mid) if m.mid else [],
        "verdicts": [
            {"detection": v.detection_id, "person": v.person, "model": v.model}
            for v in st["verdicts"]
        ],
    }


# --- failure injection ------------------------------------------------------------------------


def _tf_factory(transport: FakeTransport, sleeps: list[float]) -> Callable[[], Any]:
    """The real ``TokenFactoryClient`` over the fake transport (retries and parsing are real)."""
    from sightline.agent.llm import NO_THINKING, TokenFactoryClient

    return lambda: TokenFactoryClient(
        "injected", client=transport, extra_body=NO_THINKING, sleep=sleeps.append
    )


def _diff_trace(store: Any, mid: str, before: int) -> list[Any]:
    return store.trace_entries(mid)[before:]


def _near_miss_mission(h: Harness, name: str, factory: Callable[[], Any]) -> tuple[Mission, str]:
    """A mission with its fleet and a near-miss detection over the person; the agent verifies it."""
    h.use_client(factory)
    h.detector.conf = NEAR_MISS_CONF
    m = Mission(h, name)
    m.create()
    m.join_fleet()
    dets = m.photo(h.scn.hidden.lat, h.scn.hidden.lon, positive=True, k=9)
    return m, dets[0]


def _model_case(
    h: Harness, case: str, injected: str, script: Callable[[str, int, str], str]
) -> dict:
    transport, sleeps = FakeTransport(script), []
    m, det = _near_miss_mission(h, case, _tf_factory(transport, sleeps))
    m.review(det)  # "person": the alert and assign_sector briefings call the model too
    st = h.store.state(m.mid)
    v = next((v for v in st["verdicts"] if v.detection_id == det), None)
    trace = h.store.trace_entries(m.mid)
    notes = [e.summary for e in trace if e.kind == "note" and e.actor in ("agent", "verifier")]
    rejected_briefings = [
        e.summary
        for e in trace
        if e.kind == "model_call" and e.summary.startswith("briefing rejected")
    ]
    vl_calls = [e for e in trace if e.kind == "model_call" and e.actor == "verifier"]
    kinds = Counter(p.kind for p in st["proposals"] if p.created_by != "command")
    briefings = [p.briefing for p in st["proposals"] if p.briefing]
    template = sum("template used" in n for n in notes)
    did = []
    if sleeps:
        did.append(
            f"retried {len(sleeps)}× (backoff {', '.join(f'{s:g}' for s in sleeps[:4])}"
            + (" …" if len(sleeps) > 4 else "")
            + " s)"
        )
    if v is not None:
        why = f" (“{v.reason.rstrip('.')}”)" if v.person != "yes" else ""
        did.append(f"verdict `{v.person}`{why}")
    if template:
        did.append(f"{template} of {len(briefings)} briefings fell back to the template")
    did.append("proposals: " + (", ".join(f"{k} {n}" for k, n in kinds.items()) or "none"))
    return {
        "case": case,
        "injected": injected,
        "did": "; ".join(did) or "nothing",
        "attempts": dict(transport.attempts),
        "proposals": dict(kinds),
        "trace": "; ".join(
            [f"{len(vl_calls)} VL model_call entries, the verdict entry"]
            + notes
            + rejected_briefings[:2]
            + ([f"the {len(sleeps)} retries are not in the trace"] if sleeps and not notes else [])
        ),
        "recorded": "partly" if sleeps and not notes else bool(notes or rejected_briefings),
        "crash": "; ".join(e.summary for e in trace if re.match(r"agent \w+ .* failed", e.summary)),
        "mission": m.mid,
    }


def failure_cases(h: Harness) -> list[dict]:
    from sightline.agent.trace import now_iso
    from sightline.mission.pipeline import PhotoJob

    out: list[dict] = []

    def guarded(case: str, injected: str, fn: Callable[[], dict]) -> None:
        cap = LogCapture()
        logging.getLogger("sightline").addHandler(cap)
        try:
            r = fn()
        except Exception as e:  # noqa: BLE001 - a crash is a result
            r = {
                "case": case,
                "injected": injected,
                "did": "crashed (exception reached the eval)",
                "recorded": False,
                "trace": "",
                "crash": f"{type(e).__name__}: {e}",
            }
        finally:
            logging.getLogger("sightline").removeHandler(cap)
        r["log"] = cap.records[:6]
        out.append(r)

    # (a) Token Factory: timeouts and 5xx, through the real client's retry loop
    def always(err: Callable[[], Exception]) -> Callable[[str, int, str], str]:
        def script(kind: str, n: int, prompt: str) -> str:
            raise err()

        return script

    def twice_then_ok(kind: str, n: int, prompt: str) -> str:
        if n <= 2:
            raise server_error(503)
        return good_reply(kind, prompt)

    guarded(
        "a1 timeout",
        "Token Factory times out on every attempt",
        lambda: _model_case(
            h, "a1 timeout", "Token Factory times out on every attempt", always(timeout_error)
        ),
    )
    guarded(
        "a2 5xx then OK",
        "503 on the first two attempts of each kind, then OK",
        lambda: _model_case(
            h, "a2 5xx then OK", "503 on the first two attempts, then OK", twice_then_ok
        ),
    )
    guarded(
        "a3 5xx always",
        "503 on every attempt",
        lambda: _model_case(
            h, "a3 5xx always", "503 on every attempt", always(lambda: server_error(503))
        ),
    )

    # (b) malformed JSON from the VL model; a briefing reply that is broken JSON, not sentences
    def bad_json(kind: str, n: int, prompt: str) -> str:
        if kind == "vl":
            return '{"person": "yes", "posture": lying, "reason": "a person'
        if kind == "briefing":
            return '{"briefing": "Team One'
        return "{}"

    guarded(
        "b1 malformed JSON",
        "VL verdict and briefing replies are broken JSON",
        lambda: _model_case(
            h, "b1 malformed JSON", "VL verdict and briefing replies are broken JSON", bad_json
        ),
    )

    def bad_then_ok(kind: str, n: int, prompt: str) -> str:
        if n == 1:
            return "Sure! The crop shows a person." if kind == "vl" else "{}"
        return good_reply(kind, prompt)

    guarded(
        "b2 malformed once",
        "first reply of each kind is not JSON / not a briefing",
        lambda: _model_case(
            h,
            "b2 malformed once",
            "first reply of each kind is not JSON / not a briefing",
            bad_then_ok,
        ),
    )

    # (c) Tavily down: the conditions refresh (lane B) with Tavily raising on every call
    def tavily_down() -> dict:
        from sightline.geo import conditions

        h.use_client(EvalChat)
        m = Mission(h, "c tavily down")
        m.create()
        m.join_fleet()
        m.opening_legs()
        before = len(h.store.trace_entries(m.mid))
        n_props = len(h.store.state(m.mid)["proposals"])
        saved, fake = conditions._tavily, os.environ.pop("SIGHTLINE_FAKE_TAVILY", None)
        conditions._tavily = lambda: DownTavily()
        DownTavily.calls = 0
        # the conditions cache is per hour: drop it so the refresh really calls Tavily
        for f in (h.store.root / m.mid / "conditions_cache").glob("*/*.json"):
            f.unlink()
        try:
            status = h.http.post(f"/missions/{m.mid}/conditions/refresh").status_code
            h.settle()
        finally:
            conditions._tavily = saved
            if fake is not None:
                os.environ["SIGHTLINE_FAKE_TAVILY"] = fake
        c = h.store.state(m.mid)["conditions"]
        new = _diff_trace(h.store, m.mid, before)
        props = h.store.state(m.mid)["proposals"][n_props:]
        return {
            "case": "c Tavily down",
            "injected": "Tavily search/extract raise ConnectionError",
            "did": f"fell back: HTTP {status}; conditions stale={c.stale}, flyable={c.flyable}, "
            f"reason “{c.flyability_reason}”; {DownTavily.calls} Tavily call(s); "
            f"{len(props)} agent proposal(s) ({', '.join(p.kind for p in props) or 'none'})",
            "recorded": bool(new),
            "trace": "; ".join(f"{e.actor}/{e.kind}: {e.summary}" for e in new)
            or "no trace entry (a conditions.updated event and a server log warning only)",
            "crash": "",
            "mission": m.mid,
        }

    guarded("c Tavily down", "Tavily raises", tavily_down)

    # (d) a photo with no GPS: through the API, and as a job that reaches the worker anyway
    def no_gps_api() -> dict:
        h.use_client(EvalChat)
        m = Mission(h, "d1 no GPS")
        m.create()
        r = h.call(
            "POST",
            f"/missions/{m.mid}/photos",
            files=[("files", ("no_gps.jpg", NO_GPS.read_bytes(), "image/jpeg"))],
        )
        h.settle()
        return {
            "case": "d1 no GPS (API)",
            "injected": "a JPEG without EXIF GPS posted to /photos",
            "did": f"skipped: rejected at upload ({r['rejected'][0]['reason'] if r['rejected'] else 'accepted!'}); "
            f"{len(h.store.survey(m.mid).frames)} frames",
            "recorded": False,
            "trace": "none: the upload response names the reason; no trace entry or event",
            "crash": "",
            "mission": m.mid,
        }

    def no_gps_worker() -> dict:
        h.use_client(EvalChat)
        h.detector.conf = CANDIDATE_CONF
        m = Mission(h, "d2 no GPS in the worker")
        m.create()
        fid = h.store.next_id(m.mid, "f")
        rel = h.store.put_file(m.mid, f"frames/orig/{fid}.jpg", NO_GPS.read_bytes())
        h.ctx.queue.put(PhotoJob(m.mid, fid, rel, now_iso(), "no_gps.jpg"))
        h.settle()
        events = [e for e in h.store.events(m.mid) if e.ref == fid]
        r = h.call(
            "POST",
            f"/missions/{m.mid}/photos",
            files=[
                (
                    "files",
                    (
                        "EVAL_good.jpg",
                        h.photos.at(h.scn.hidden.lat, h.scn.hidden.lon, True),
                        "image/jpeg",
                    ),
                )
            ],
        )
        h.settle()
        frames = [f.id for f in h.store.survey(m.mid).frames]
        later = r["accepted"][0]
        return {
            "case": "d2 no GPS (worker)",
            "injected": "a no-GPS job put on the photo queue directly (bypassing the upload check), "
            "then a good photo",
            "did": f"skipped {fid} (job logged as failed, not retried); the good photo {later} was "
            + ("processed" if later in frames else "**not processed**")
            + f"; frames now {frames or 'none'}",
            "recorded": bool(events),
            "trace": "; ".join(e.summary for e in events)
            or "no trace entry or event for the failed job: server log only",
            "crash": "",
            "mission": m.mid,
        }

    guarded("d1 no GPS (API)", "", no_gps_api)
    guarded("d2 no GPS (worker)", "", no_gps_worker)

    # (e) duplicate events
    def dup_clue() -> dict:
        h.use_client(EvalChat)
        m = Mission(h, "e1 duplicate clue")
        m.create()
        m.join_fleet()
        m.opening_legs()
        cid = m.clue()
        h.hooks.on_clue(h.store, m.mid, cid)  # the same clue delivered to the agent again
        h.settle()
        ps = [p for p in h.store.state(m.mid)["proposals"] if p.created_by == "planner"]
        return {
            "case": "e1 duplicate clue hook",
            "injected": f"on_clue({cid}) delivered twice",
            "did": f"{len(ps)} leg proposals: " + ", ".join(f"{p.id} {p.status}" for p in ps),
            "recorded": True,
            "trace": f"{sum(1 for e in h.store.trace_entries(m.mid) if e.kind == 'proposal' and cid in e.refs)} "
            "proposal entries cite the clue; the superseding is an event, not a trace entry",
            "crash": "",
            "mission": m.mid,
        }

    def dup_detection() -> dict:
        m, det = _near_miss_mission(h, "e2 duplicate detection", EvalChat)
        h.hooks.on_detection(h.store, m.mid, det)
        h.settle()
        st = h.store.state(m.mid)
        vs = [v for v in st["verdicts"] if v.detection_id == det]
        ps = [p for p in st["proposals"] if p.kind == "promote_detection"]
        return {
            "case": "e2 duplicate detection hook",
            "injected": f"on_detection({det}) delivered twice (near miss)",
            "did": f"{len(vs)} verdicts, {len(ps)} promote_detection proposals for the one detection ("
            + ", ".join(f"{p.id} {p.status}" for p in ps)
            + ")",
            "recorded": True,
            "trace": f"{sum(1 for e in h.store.trace_entries(m.mid) if e.kind == 'verdict')} verdict "
            "entries; no note that it was a repeat",
            "crash": "",
            "mission": m.mid,
        }

    def dup_review() -> dict:
        h.use_client(EvalChat)
        h.detector.conf = CANDIDATE_CONF
        m = Mission(h, "e3 duplicate review")
        m.create()
        m.join_fleet()
        det = m.photo(h.scn.hidden.lat, h.scn.hidden.lon, positive=True, k=9)[0]
        m.review(det)
        m.review(det)
        ps = Counter(p.kind for p in h.store.state(m.mid)["proposals"] if p.created_by == "agent")
        return {
            "case": "e3 duplicate review",
            "injected": f"POST /reviews {det} person, twice",
            "did": f"proposals: {dict(ps)}",
            "recorded": True,
            "trace": "each proposal is traced; nothing marks the second as a repeat",
            "crash": "",
            "mission": m.mid,
        }

    def dup_photo_job() -> dict:
        h.use_client(EvalChat)
        h.detector.conf = CANDIDATE_CONF
        m = Mission(h, "e4 duplicate photo job")
        m.create()
        m.photo(h.scn.hidden.lat, h.scn.hidden.lon, positive=True, k=9)
        fid = h.store.survey(m.mid).frames[0].id
        n_v = len(h.store.state(m.mid)["verdicts"])
        h.ctx.queue.put(PhotoJob(m.mid, fid, f"frames/orig/{fid}.jpg", now_iso(), "again.jpg"))
        h.settle()
        st = h.store.state(m.mid)
        return {
            "case": "e4 duplicate photo job",
            "injected": f"the job for {fid} delivered again (SQS at-least-once)",
            "did": f"skipped (already processed): {len(h.store.survey(m.mid).frames)} frame(s), "
            f"verdicts {n_v} → {len(st['verdicts'])}",
            "recorded": False,
            "trace": "none (the pipeline returns 'already processed' silently)",
            "crash": "",
            "mission": m.mid,
        }

    def dup_decision() -> dict:
        h.use_client(EvalChat)
        m = Mission(h, "e5 duplicate decision")
        m.create()
        m.join_fleet()
        m.opening_legs()
        m.clue()
        p = m.pending("drone_leg", "retask_drone")[0]
        m.decide(p.id)
        r = h.http.post(
            f"/missions/{m.mid}/proposals/{p.id}/decide",
            json={"decision": "approve", "by": MANAGER},
        )
        legs = [x.id for x in h.store.state(m.mid)["fleet"].legs if x.id == p.leg.id]
        return {
            "case": "e5 duplicate decision",
            "injected": f"approve {p.id} twice",
            "did": f"second approval refused: HTTP {r.status_code} ({r.json().get('detail')}); "
            f"leg {p.leg.id} in the fleet {len(legs)}×",
            "recorded": True,
            "trace": "the first decision is traced; the refused one is not",
            "crash": "",
            "mission": m.mid,
        }

    for case, fn in (
        ("e1", dup_clue),
        ("e2", dup_detection),
        ("e3", dup_review),
        ("e4", dup_photo_job),
        ("e5", dup_decision),
    ):
        guarded(case, "", fn)
    return out


# --- report -----------------------------------------------------------------------------------


def _table(head: list[str], rows: list[list[Any]]) -> str:
    def cell(x: Any) -> str:
        return "–" if x is None else str(x).replace("|", "\\|").replace("\n", " ")

    out = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    out += ["| " + " | ".join(cell(x) for x in r) + " |" for r in rows]
    return "\n".join(out)


def report(meta: dict, runs: list[dict], failures: list[dict]) -> str:
    lines = [
        "# Agent evaluation",
        "",
        (
            f"`{meta['command']}` · {meta['started']} · models: {meta['models']} · detector: "
            f"scripted from the scenario truth · photos: {meta['photos']} · {meta['repeats']} "
            "run(s) per scenario."
        ),
        "",
        (
            "Scripted search manager and reviewer (labelled in every trace). Ground truth: the "
            f"hidden person in `sightline/search/scenarios/creek.json`, sector "
            f"{meta['hidden_sector']}."
        ),
        "",
        "## Proposals per scenario",
        "",
    ]
    by = defaultdict(list)
    for r in runs:
        by[r["scenario"]].append(r)
    kinds = sorted({p["kind"] for r in runs for p in r["proposals"]})
    rows = []
    for name, rs in by.items():
        counts = [Counter(p["kind"] for p in r["proposals"]) for r in rs]
        rows.append(
            [
                name,
                len(rs),
                f"{sum(sum(c.values()) for c in counts) / len(rs):g}",
                *[f"{sum(c[k] for c in counts) / len(counts):g}" for k in kinds],
                f"{sum(r['wall_s'] for r in rs) / len(rs):.1f}",
            ]
        )
    lines += [_table(["Scenario", "Runs", "Proposals (mean)", *kinds, "Wall s (mean)"], rows), ""]
    status = Counter(p["status"] for r in runs for p in r["proposals"])
    lines += [f"Final status of all agent proposals: {dict(status)}.", ""]

    lines += ["## Time from evidence to proposal", ""]
    lat = defaultdict(list)
    for r in runs:
        for x in r["latency"]:
            lat[(x["evidence"], x["kind"])].append(x["ms"])
    rows = [
        [e, k, len(v), percentile(v, 50), percentile(v, 90), max(v)]
        for (e, k), v in sorted(lat.items())
    ]
    rows = [[*r[:3], *(f"{x:.0f}" for x in r[3:])] for r in rows]
    lines += [_table(["Evidence", "Proposal", "n", "p50 ms", "p90 ms", "max ms"], rows), ""]
    lines += [
        (
            "Evidence times: a clue's `at`; a detection: its photo's `photo.processed` event; a "
            "verdict's `at`; a review's event; a leg done: the telemetry event; a tick: when it "
            "was called. Proposal time: its `created_at`. Percentiles interpolated linearly."
        ),
        "",
        "## Correct target (ground truth)",
        "",
    ]
    tr = defaultdict(list)
    for r in runs:
        for t in r["truth"]:
            tr[(r["scenario"], t["check"])].append(t)
    rows = []
    for (s, c), ts in tr.items():
        ok = [t["ok"] for t in ts]
        res = "n/a" if ok[0] is None else f"{sum(bool(x) for x in ok)}/{len(ok)}"
        rows.append([s, c, res, "; ".join(sorted({t["detail"] for t in ts}))])
    lines += [_table(["Scenario", "Check", "Correct", "Proposed"], rows), ""]

    lines += ["## Approval gate", ""]
    gc = defaultdict(list)
    for r in runs:
        for g in r["gate"]:
            gc[g["check"]].append(g)
    rows = [
        [
            c,
            f"{sum(g['ok'] for g in gs)}/{len(gs)}",
            "; ".join(sorted({g["detail"] for g in gs if g["detail"]})) or "–",
        ]
        for c, gs in gc.items()
    ]
    lines += [_table(["Check (final mission state)", "Runs passing", "Failures"], rows), ""]

    lines += ["## Failure handling (injected)", ""]
    rows = [
        [
            f["case"],
            f.get("injected", ""),
            f["did"],
            {True: "yes", False: "no"}.get(f.get("recorded"), f.get("recorded")),
            f.get("trace", ""),
            f.get("crash") or "no",
        ]
        for f in failures
    ]
    lines += [
        _table(
            ["Case", "Injected", "What the loop did", "In the trace", "Trace / evidence", "Crash"],
            rows,
        ),
        "",
    ]
    logged = [(f["case"], x) for f in failures for x in f.get("log", [])]
    if logged:
        lines += ["Server log warnings and errors during the injected cases:", ""]
        lines += [f"- {c}: `{x[:200]}`" for c, x in logged] + [""]

    lines += ["## Crashes", ""]
    crashed = [r for r in runs if r["crash"] or r["runner_failures"]]
    crashed += [f for f in failures if f.get("crash")]
    if not crashed:
        lines += ["None: no scenario run raised, and the runner traced no failed event.", ""]
    for r in crashed:
        what = r.get("crash") or "; ".join(r.get("runner_failures", []))
        lines += [f"- {r.get('scenario') or r.get('case')} ({r.get('mission')}): `{what[:400]}`"]
    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--live", action="store_true", help="Nemotron on Token Factory (NEBIUS_API_KEY)"
    )
    ap.add_argument("--repeats", type=int, default=3)
    ap.add_argument("--scenarios", nargs="+", choices=list(SCENARIOS), default=list(SCENARIOS))
    ap.add_argument("--no-failures", action="store_true", help="skip the failure injection")
    ap.add_argument("--val", type=Path, default=VAL, help="HERIDAL validation split (photo crops)")
    ap.add_argument("--out", type=Path, default=None, help="default runs/agent_eval/<timestamp>")
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.ERROR, format="%(levelname)s %(name)s: %(message)s")
    if args.live:
        from dotenv import dotenv_values

        for k, v in dotenv_values(ROOT / ".env").items():
            if v and k not in os.environ:
                os.environ[k] = v
        if not os.environ.get("NEBIUS_API_KEY"):
            print("--live needs NEBIUS_API_KEY (environment or .env); not running.")
            return 2
        os.environ.pop("SIGHTLINE_FAKE_LLM", None)
        if os.environ.get("TAVILY_API_KEY"):
            os.environ.pop("SIGHTLINE_FAKE_TAVILY", None)
        else:
            os.environ["SIGHTLINE_FAKE_TAVILY"] = "1"
    else:
        os.environ["SIGHTLINE_FAKE_LLM"] = "1"  # lane B's conditions: no paid call either
        os.environ["SIGHTLINE_FAKE_TAVILY"] = "1"

    from sightline.agent.llm import MODEL_FAST, MODEL_VISION, NO_THINKING, token_factory_client

    factory: Callable[[], Any] = (
        (lambda: token_factory_client(extra_body=NO_THINKING)) if args.live else EvalChat
    )
    out = args.out or ROOT / "runs/agent_eval" / time.strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True, exist_ok=True)
    cmd = "uv run python scripts/agent_eval.py" + (" " + " ".join(argv or sys.argv[1:])).rstrip()
    h = Harness(out, args.val)
    runs: list[dict] = []
    failures: list[dict] = []
    try:
        for name in args.scenarios:
            for k in range(args.repeats):
                r = run_scenario(h, name, factory)
                runs.append(r)
                n = Counter(p["kind"] for p in r["proposals"])
                gate = "ok" if all(g["ok"] for g in r["gate"]) else "FAILED"
                print(
                    f"  {name} #{k + 1}: {dict(n)} gate {gate} {r['wall_s']} s"
                    + (" CRASH" if r["crash"] else ""),
                    flush=True,
                )
        if not args.no_failures:
            failures = failure_cases(h)
            for f in failures:
                print(f"  {f['case']}: {f['did'][:110]}", flush=True)
    finally:
        h.close()
    meta = {
        "command": cmd,
        "started": time.strftime("%Y-%m-%d %H:%M"),
        "models": f"Token Factory ({MODEL_VISION}, {MODEL_FAST})"
        if args.live
        else "fake (VL says yes; briefing = its facts)",
        "photos": h.photos.source,
        "repeats": args.repeats,
        "hidden_sector": next((r["hidden_sector"] for r in runs if r["hidden_sector"]), "?"),
    }
    (out / "agent_eval.json").write_text(
        json.dumps({"meta": meta, "runs": runs, "failures": failures}, indent=1, default=str)
    )
    (out / "agent_eval.md").write_text(report(meta, runs, failures))
    print(f"\n{out / 'agent_eval.md'}")
    bad = [r for r in runs if r["crash"] or not all(g["ok"] for g in r["gate"])]
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
