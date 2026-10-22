"""Conditions from the web, live, and what they change (Tavily write-up evidence, LANE_B W6 / MP §8.2).

    uv run python scripts/conditions_live.py [--area "Mount Seymour"]     # real Tavily + Nemotron, .env keys

One real ``fetch_conditions`` on a fresh mission (3 Tavily searches, 1 extract, 1 Nemotron call; a few
cents), then each of the four places the values act, computed on that same mission:

1. **flying:** the planner's legs for one simulated drone (none when not flyable, with the reason);
2. **what a photo can see:** the POD a photo gives a cell, with this visibility factor and with 1.0;
3. **where people shelter:** the live map's shelter update for this exposure band (or why none);
4. **what teams hear:** the briefing facts built from the conditions.

Writes ``docs/evidence/conditions-live-<date>/`` (the conditions, the four effects, and the mission's
``actor="conditions"`` trace entries: every Tavily call with its result URLs and every extracted value
with its quote). Keys come from ``.env``; none is written anywhere.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
LKP = {"lat": 49.375, "lon": -122.9375}  # Mount Seymour, as the demo


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--area", default="Mount Seymour")
    args = ap.parse_args(argv)

    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env")
    os.environ.pop("SIGHTLINE_FAKE_TAVILY", None)
    if not (os.environ.get("TAVILY_API_KEY") and os.environ.get("NEBIUS_API_KEY")):
        print("TAVILY_API_KEY and NEBIUS_API_KEY are needed (.env)")
        return 1

    from fastapi.testclient import TestClient

    from sightline.agent.loop import conditions_facts
    from sightline.api.app import create_app
    from sightline.api.missions import MissionContext
    from sightline.contract import Drone, FleetState
    from sightline.mission import MissionStore
    from sightline.mission.queue import LocalQueue
    from sightline.mission.store import now_iso
    from sightline.search.planner import PlannerConfig, propose_legs
    from sightline.search.sectors import lattice_sectors

    work = Path(tempfile.mkdtemp(prefix="conditions-live-"))
    store = MissionStore(work / "missions")
    ctx = MissionContext(store, queue=LocalQueue(), hooks=None, detector_factory=lambda: None)
    ctx.start()
    app = create_app(cache_root=work / "c", data_root=work / "u", missions=ctx)
    with TestClient(app) as http:
        mid = http.post(
            "/missions", json={"name": "Conditions live", "area_name": args.area, "lkp": LKP}
        ).json()["mission_id"]
        for _ in range(120):  # the first fetch runs in the background on creation
            if store.state(mid)["conditions"] is not None:
                break
            time.sleep(1)
    ctx.queue.stop()
    c = store.state(mid)["conditions"]
    if c is None:
        print("no conditions after 2 min; see the trace in", work)
        return 1

    # 1. flying
    drone = Drone(id="D1", name="Drone 1 (simulated)", simulated=True, position=None, altitude_m=50, speed_ms=8,
                  battery_pct=100, max_wind_kmh=38, status="idle", leg_id=None)  # fmt: skip
    live = store.live(mid)
    layout = lattice_sectors(live.base.grid)
    legs = propose_legs(
        live,
        layout,
        FleetState(simulated=True, drones=[drone], legs=[], updated_at=now_iso()),
        c,
        now_iso(),
        k=1,
    )
    flying = {"flyable": c.flyable, "reason": c.flyability_reason,
              "planner_legs": [{"sector": leg.sector_id, "reason": leg.reason} for leg in legs]}  # fmt: skip
    # 2. what a photo can see: POD for a cell with no canopy, recall × visibility, capped
    cfg = PlannerConfig()
    pod = lambda v: round(min(cfg.pod_cap, cfg.recall * v), 3)
    seeing = {
        "visibility_factor": c.visibility_factor,
        "pod_open_ground": pod(c.visibility_factor),
        "pod_if_clear_air": pod(1.0),
    }
    # 3. where people shelter
    update = live.conditions_update(c)
    shelter = {"exposure_band": c.exposure_band, "exposure_note": c.exposure_note,
               "shelter_update_cells": None if update is None else len(update.cells),
               "why_none": None if update else "exposure below high: no shift (or canopy unknown)"}  # fmt: skip
    # 4. what teams hear
    facts = conditions_facts(c, now_iso())

    trace = [e.model_dump(mode="json") for e in store.trace_entries(mid) if e.actor == "conditions"]
    out = ROOT / "docs/evidence" / f"conditions-live-{time.strftime('%Y%m%d')}"
    out.mkdir(parents=True, exist_ok=True)
    (out / "conditions.json").write_text(json.dumps(c.model_dump(mode="json"), indent=1) + "\n")
    (out / "effects.json").write_text(
        json.dumps(
            {"flying": flying, "seeing": seeing, "shelter": shelter, "briefing_facts": facts},
            indent=1,
        )
        + "\n"
    )
    with open(out / "trace.jsonl", "w") as f:
        f.writelines(json.dumps(e, ensure_ascii=False) + "\n" for e in trace)
    print(f"{args.area} at {c.fetched_at}: wind {c.wind_kmh} gusting {c.gust_kmh} km/h, rain {c.precip_mm_h} mm/h, "
          f"{len(c.alerts)} alerts, flyable {c.flyable} ({c.flyability_reason})")  # fmt: skip
    print("1 flying:", flying["planner_legs"] or f"no legs: {c.flyability_reason}")
    print("2 seeing:", seeing)
    print("3 shelter:", shelter["shelter_update_cells"], shelter["why_none"] or "")
    print("4 briefing facts:", facts)
    print(f"{len(trace)} conditions trace entries; wrote {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
