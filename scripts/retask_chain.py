"""The OpenCV report's second Agentic Vision chain (§5.2): an OpenCV 5 / Nemotron VL result leads,
through the planner, to re-tasking a drone that is already flying. Recorded on a live mission.

    uv run python scripts/retask_chain.py

On the real server (mission API, cv2.dnn, live map, planner, Nemotron on Token Factory, ``.env``):

1. Drone 1 (simulated fleet, labelled) is flying a leg over sector A1, approved by a scripted
   search manager.
2. HERIDAL **validation** photos come in; the detector finds candidates and the agent's second look
   (OpenCV 5 re-look tools → Nemotron VL) gives verdicts.
3. A scripted reviewer confirms the candidate the VL called a person; the scripted search manager logs
   the sighting as a clue (high reliability) at the detection's position.
4. The clue reweights the live map; the agent re-plans; the planner re-tasks the flying drone.
5. The scripted search manager approves; Drone 1's old leg is cancelled and the new one approved.

Every scripted step is a ``human`` entry in the trace saying so. Prints the trace excerpt (detection
→ re-look → VL → verdict → review → clue → re-task → decision) and saves it with the mission under
``runs/retask_chain/<timestamp>/``. Val photos only; a few cents of tokens.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import time

from agent_live import APPROVER, LKP, PHOTOS, ROOT, VAL, call, settle, upload

REVIEWER = "Reviewer (scripted for this run)"
MANAGER = "Search manager (scripted for this run)"
START_SECTOR = "A1"


def main() -> int:
    from dotenv import dotenv_values

    from sightline.agent.trace import now_iso, trace_call
    from sightline.contract import Drone, FleetState, Proposal
    from sightline.mission import MissionStore, validate_mission
    from sightline.search.planner import PlannerConfig, candidate_legs
    from sightline.search.sectors import lattice_sectors

    out = ROOT / "runs/retask_chain" / time.strftime("%Y%m%d-%H%M%S")
    out.mkdir(parents=True)
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    env = {**os.environ, **{k: v for k, v in dotenv_values(ROOT / ".env").items() if v}}
    env.pop("SIGHTLINE_FAKE_LLM", None)
    if not env.get("NEBIUS_API_KEY"):
        print("NEBIUS_API_KEY is not set (.env)")
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
                "name": "Re-task chain (val photos)",
                "area_name": "HERIDAL site BRK",
                "lkp": LKP,
                "subject": "adult, hiker",
            },
        )
        mid = m["mission_id"]
        print(f"mission {mid} in {out}")

        # 1. Drone 1 flying a leg over A1 (simulated fleet; the leg approved by the scripted manager)
        drone = Drone(
            id="D1",
            name="Drone 1",
            simulated=True,
            position=None,
            altitude_m=50,
            speed_ms=8,
            battery_pct=95,
            max_wind_kmh=38,
            status="idle",
            leg_id=None,
        )
        store.put_fleet(
            mid, FleetState(simulated=True, drones=[drone], legs=[], updated_at=now_iso())
        )
        live = store.live(mid)
        layout = lattice_sectors(live.base.grid)
        leg = next(
            x
            for x in candidate_legs(drone, layout, live.base.grid, PlannerConfig(), live.base.lkp)
            if x.sector_id == START_SECTOR
        )
        leg = leg.model_copy(
            update={
                "id": store.next_id(mid, "L"),
                "reason": "the search's opening leg (scripted for this run)",
            }
        )
        p0 = store.add_proposal(
            mid,
            Proposal(
                id="",
                kind="drone_leg",
                summary=f"Send Drone 1 to sector {START_SECTOR}",
                reason="Opening leg, scripted for this run.",
                briefing=None,
                target={"drone": "D1", "leg": leg.id},
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
        call(
            base,
            "POST",
            f"/missions/{mid}/proposals/{p0.id}/decide",
            {"decision": "approve", "by": APPROVER},
        )
        flying = store.state(mid)["fleet"].drones[0].model_copy(update={"status": "flying"})
        call(
            base,
            "PUT",
            f"/missions/{mid}/fleet",
            {
                "drones": [flying.model_dump(mode="json")],
                "leg_status": {leg.id: "flying"},
                "at": now_iso(),
            },
        )
        print(f"  Drone 1 flying {leg.id} over {START_SECTOR} (simulated)")

        # 2. photos: detection → OpenCV re-look → VL verdicts
        upload(base, mid, [VAL / p for p in PHOTOS])
        settle(store, mid)
        verdicts = {v.detection_id: v for v in store.state(mid)["verdicts"]}
        dets = sorted(
            (d for ds in store.detections(mid).frames.values() for d in ds if d.crop),
            key=lambda d: -d.conf,
        )
        det = next(d for d in dets if getattr(verdicts.get(d.id), "person", None) == "yes")
        v = verdicts[det.id]
        print(
            f"  {det.id} ({det.conf:.2f}): VL says {v.person}, {v.posture}, {v.clothing} (tools {v.tools})"
        )

        # 3. the reviewer confirms; the manager logs the sighting as a clue
        call(base, "POST", f"/missions/{mid}/reviews", {"detection_id": det.id, "answer": "person"})
        trace_call(
            store,
            mid,
            actor="human",
            kind="decision",
            summary=f"{REVIEWER}: {det.id} is a person",
            output={"answer": "person"},
            refs=[det.id],
        )
        settle(store, mid)
        clue = call(
            base,
            "POST",
            f"/missions/{mid}/clues",
            {
                "kind": "sighting",
                "text": f"person in photo {det.id[:5]}, confirmed by the reviewer",
                "lat": det.lat,
                "lon": det.lon,
                "reliability": "high",
                "reported_by": "command",
                "source": "form",
            },
        )
        trace_call(
            store,
            mid,
            actor="human",
            kind="note",
            summary=f"{MANAGER}: logged the sighting as clue {clue['id']} ({clue['radius_m']:.0f} m, the default for a sighting)",
            output={"clue": clue["id"]},
            refs=[det.id, clue["id"]],
        )
        print(f"  sighting logged as {clue['id']}")

        # 4. the agent re-plans → re-task
        settle(store, mid)
        retask = next((p for p in store.state(mid)["proposals"] if p.kind == "retask_drone"), None)
        if retask is None:
            print(
                "  no re-task proposed:",
                [(p.kind, p.summary) for p in store.state(mid)["proposals"]],
            )
            return 1
        print(f"  {retask.id}: {retask.summary}\n    {retask.reason}")

        # 5. approval: the old leg is cancelled, the new one approved
        call(
            base,
            "POST",
            f"/missions/{mid}/proposals/{retask.id}/decide",
            {"decision": "approve", "by": APPROVER},
        )
        trace_call(
            store,
            mid,
            actor="human",
            kind="decision",
            summary=f"{retask.id} approved by {APPROVER}",
            output={"proposal": retask.id},
            refs=[retask.id, *retask.target.values()],
        )
        legs = {x.id: x.status for x in store.state(mid)["fleet"].legs}
        print(f"  approved: legs {legs}")
    finally:
        server.terminate()
        try:
            server.wait(15)
        except subprocess.TimeoutExpired:
            server.kill()
        log.close()

    problems = validate_mission(out / "missions", mid)
    print("validate_mission:", problems or "ok")
    excerpt = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/trace_excerpt.py"),
            "--dir",
            str(out / "missions" / mid),
            "--proposal",
            retask.id,
            "--markdown",
        ],
        check=False,
        capture_output=True,
        text=True,
        cwd=ROOT,
    )
    (out / "excerpt.md").write_text(excerpt.stdout)
    print(excerpt.stdout or excerpt.stderr)
    return 0 if not problems else 1


if __name__ == "__main__":
    raise SystemExit(main())
