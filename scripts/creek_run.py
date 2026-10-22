"""The creek scenario end to end (LANE_C §5.6, C-F2), the Nebius video's story, on a real server:

    uv run python scripts/creek_run.py              # offline rehearsal: fake model, fake Tavily
    uv run python scripts/creek_run.py --live       # Nemotron + Tavily with the keys in .env

1. Three simulated drones (``sightline.search.fleet``, labelled) fly opening legs over the northern
   sectors, approved by a scripted search manager.
2. Team Two reports a blue backpack by the creek (scripted ``POST /clues``; live by radio in the video).
3. The clue reweights the map; the agent re-plans and proposes re-tasking a drone; the scripted
   manager approves; the sim drops the old leg and flies the new one.
4. A photo over the hidden person gives a candidate (truth only chose the image); a scripted reviewer
   confirms it; the agent proposes an alert; the scripted manager approves it.

Every scripted step is a ``human`` entry in the trace saying so. When the real conditions say the
drones can't fly (a night rehearsal), the fair-weather fixture is put in instead, and the trace says
so. Prints a timeline with wall-clock seconds and saves it with the mission under
``runs/creek/<timestamp>/``. Validation photos only.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import threading
import time
from datetime import UTC, datetime, timedelta

from agent_live import ROOT, call

MANAGER = "Search manager (scripted for this run)"
REVIEWER = "Reviewer (scripted for this run)"
OPENING = ("A2", "A3", "B2")  # away from the creek: the clue has to move a drone
CANDIDATE_MIN = 0.5


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--live", action="store_true", help="real Nemotron and Tavily (.env keys)")
    ap.add_argument("--time-scale", type=float, default=15.0)
    ap.add_argument("--limit-s", type=float, default=900.0, help="give up after this long")
    args = ap.parse_args(argv)

    import httpx
    from dotenv import dotenv_values

    from sightline.agent.trace import now_iso, trace_call
    from sightline.contract import Conditions, Proposal
    from sightline.mission import MissionStore, validate_mission
    from sightline.search.fleet import FleetSim, Scenario
    from sightline.search.planner import PlannerConfig, candidate_legs
    from sightline.search.sectors import lattice_sectors

    out = ROOT / "runs/creek" / time.strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = dict(os.environ)
    if args.live:
        env.update({k: v for k, v in dotenv_values(ROOT / ".env").items() if v})
        env.pop("SIGHTLINE_FAKE_LLM", None)
        env.pop("SIGHTLINE_FAKE_TAVILY", None)
    else:
        env.update(SIGHTLINE_FAKE_LLM="1", SIGHTLINE_FAKE_TAVILY="1")
    log = open(out / "server.log", "w")  # noqa: SIM115 - closed below
    server = subprocess.Popen(
        [sys.executable, "-m", "sightline.pipeline", "serve", "--port", str(port),
         "--mission-root", str(out / "missions"), "--cache-root", str(out / "cache"),
         "--data-root", str(out / "up")],
        cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT,
    )  # fmt: skip
    base = f"http://127.0.0.1:{port}"
    store = MissionStore(out / "missions")
    t0 = time.monotonic()
    timeline: list[tuple[float, str]] = []

    def mark(what: str) -> None:
        timeline.append((round(time.monotonic() - t0, 1), what))
        print(f"  {timeline[-1][0]:6.1f} s  {what}", flush=True)

    def human(mid: str, who: str, summary: str, refs: list[str], kind: str = "decision") -> None:
        trace_call(store, mid, actor="human", kind=kind, summary=f"{who}: {summary}", refs=refs)

    scn = Scenario.load("creek")
    stop = threading.Event()
    try:
        for _ in range(120):
            try:
                call(base, "GET", "/health")
                break
            except (OSError, RuntimeError):
                time.sleep(0.5)
        mid = call(base, "POST", "/missions", {"name": "Creek (simulated fleet)", "area_name": "Mount Seymour",
                   "lkp": scn.lkp.model_dump(), "subject": "adult, red jacket"})["mission_id"]  # fmt: skip
        print(f"mission {mid} in {out}")
        mark("mission created")

        # conditions: the first fetch runs in the background; at night the drones may not fly
        for _ in range(60):
            if store.state(mid)["conditions"] is not None:
                break
            time.sleep(0.5)
        c = store.state(mid)["conditions"]
        if c is None or not c.flyable:
            fx = json.loads((ROOT / "tests/geo/fixtures/conditions_clear.json").read_text())[
                "conditions"
            ]
            now = datetime.now(UTC)
            iso = lambda d: d.strftime("%Y-%m-%dT%H:%M:%SZ")
            fx |= {"fetched_at": iso(now), "flyable_until": iso(now + timedelta(hours=3)),
                   "sunset": iso(now + timedelta(hours=2, minutes=30)),
                   "civil_twilight_end": iso(now + timedelta(hours=3)), "sources": ["fixture (rehearsal)"]}  # fmt: skip
            store.put_conditions(mid, Conditions.model_validate(fx))
            human(
                mid,
                "Rehearsal",
                f"conditions replaced by the fair-weather fixture ({c.flyability_reason if c else 'none yet'})",
                [],
                kind="note",
            )
            mark("conditions: fair-weather fixture (real ones say no flying)")

        # 1. the fleet joins; the scripted manager approves the opening legs
        with httpx.Client(base_url=base, timeout=60) as http:
            sim = FleetSim(
                http,
                mid,
                scn,
                time_scale=args.time_scale,
                scripted_clue=False,
                out=lambda s: mark(f"fleet: {s}"),
            )
            sim.register()
            live = store.live(mid)
            layout = lattice_sectors(live.base.grid)
            for drone, sector in zip(store.state(mid)["fleet"].drones, OPENING, strict=True):
                leg = next(
                    x
                    for x in candidate_legs(
                        drone, layout, live.base.grid, PlannerConfig(), live.base.lkp
                    )
                    if x.sector_id == sector
                )
                leg = leg.model_copy(
                    update={
                        "id": store.next_id(mid, "L"),
                        "reason": "opening leg (scripted for this run)",
                    }
                )
                p = store.add_proposal(mid, Proposal(
                    id="", kind="drone_leg", summary=f"Send {drone.name} to sector {sector}", reason="Opening leg, scripted for this run.",
                    briefing=None, target={"drone": drone.id, "leg": leg.id}, leg=leg, evidence=[], status="pending",
                    created_by="command", created_at=now_iso(), decided_at=None, decided_by=None, decision_reason=None, edits=None))  # fmt: skip
                call(
                    base,
                    "POST",
                    f"/missions/{mid}/proposals/{p.id}/decide",
                    {"decision": "approve", "by": MANAGER},
                )
            mark(f"opening legs approved: {', '.join(OPENING)}")

            def fly() -> None:
                while not stop.is_set():
                    try:
                        sim.tick(0.5)
                    except Exception as e:  # noqa: BLE001 - keep flying; the run reports it
                        mark(f"fleet error: {e}")
                    stop.wait(0.5)

            flying = threading.Thread(target=fly, daemon=True)
            flying.start()

            # 2. Team Two's clue, once the drones are well into their legs
            time.sleep(3)
            draft = {k: v for k, v in (scn.clue or {}).items() if k != "after_s"}
            clue = call(base, "POST", f"/missions/{mid}/clues", draft)
            human(
                mid,
                "Team Two (scripted for this run)",
                f"reported {draft['text']} as {clue['id']}",
                [clue["id"]],
                kind="note",
            )
            mark(f"clue {clue['id']}: {draft['text']}")

            # 3–4. approve the re-task; review the candidate; approve the alert
            done: set[str] = set()
            reviewed = None
            end = time.monotonic() + args.limit_s
            while time.monotonic() < end:
                st = store.state(mid)
                for p in st["proposals"]:
                    if p.status != "pending" or p.id in done:
                        continue
                    if p.kind == "retask_drone" or (p.kind == "alert" and reviewed):
                        call(
                            base,
                            "POST",
                            f"/missions/{mid}/proposals/{p.id}/decide",
                            {"decision": "approve", "by": MANAGER},
                        )
                        done.add(p.id)
                        mark(f"{p.id} {p.kind} approved: {p.summary}")
                if reviewed is None:
                    dets = [
                        d
                        for ds in store.detections(mid).frames.values()
                        for d in ds
                        if d.crop and d.conf >= CANDIDATE_MIN
                    ]
                    if dets:
                        det = max(dets, key=lambda d: d.conf)
                        mark(f"candidate {det.id} ({det.conf:.2f})")
                        call(
                            base,
                            "POST",
                            f"/missions/{mid}/reviews",
                            {"detection_id": det.id, "answer": "person"},
                        )
                        human(mid, REVIEWER, f"{det.id} is a person", [det.id])
                        reviewed = det.id
                        mark(f"review: {det.id} is a person")
                if reviewed and any(
                    p.kind == "alert" and p.status == "approved" for p in st["proposals"]
                ):
                    break
                time.sleep(1)
            else:
                mark("gave up: limit reached")
            stop.set()
            flying.join(5)
    finally:
        stop.set()
        server.terminate()
        try:
            server.wait(15)
        except subprocess.TimeoutExpired:
            server.kill()
        log.close()

    problems = validate_mission(out / "missions", mid)
    st = store.state(mid)
    ok = bool(reviewed) and any(p.kind == "retask_drone" and p.status == "approved" for p in st["proposals"]) \
        and any(p.kind == "alert" and p.status == "approved" for p in st["proposals"])  # fmt: skip
    summary = {"mission": mid, "live_models": args.live, "time_scale": args.time_scale, "photos": sim.photos,
               "wall_s": timeline[-1][0], "complete": ok, "validate_mission": problems, "timeline": timeline}  # fmt: skip
    (out / "creek_run.json").write_text(json.dumps(summary, indent=1))
    print(
        f"\n{'complete' if ok else 'INCOMPLETE'} in {summary['wall_s']} s, {sim.photos} photos; validate_mission: {problems or 'ok'}"
    )
    return 0 if ok and not problems else 1


if __name__ == "__main__":
    sys.exit(main())
