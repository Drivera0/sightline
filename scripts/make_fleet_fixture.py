"""The demo mission's fleet (`#m/demo/command` on the static site): a real run of the simulated fleet.

    bash web/scripts/fetch-caches.sh          # once: the demo cache
    uv run python scripts/make_command_fixtures.py   # the rest of the demo mission
    uv run python scripts/make_fleet_fixture.py

Runs ``sightline.search.fleet`` (one loop, ``FleetSim``) against the real mission API in-process,
over the demo map's lattice sectors: three simulated drones fly planner legs (``candidate_legs``)
approved through proposals by a scripted search manager; Drone 1 is re-tasked to the sector of Team
Two's water-bottle clue; Team Two loses its signal and the drone nearest it relays its check-ins;
simulated fleet's link model) and flies on; Drone 3's link is degraded. The run's clock is set to the demo mission's evening,
so its events sit in the demo's timeline. Writes the final fleet, the fleet's events (link changes,
relays, leg approvals, legs started and done, battery marks) and Team Two's relayed position into
``web/src/command/__fixtures__/demo_mission.json``. Photos are plain stand-in crops (the demo's
real photos are the cache's): the fixture keeps no photo from this run. Everything is labelled
simulated.

v1.3: the drones launch from the mission's base camp (``Drone.home``); the sim's person (``hidden``,
which only picks a photo's crop) is where the demo mission finds them (``mission.found``). Each photo
a drone takes along a leg is in the fixture: its map step joins ``map_updates`` (``at`` = its capture
time, ``ref`` = its frame id after the cache's 500) and ``leg_photos`` lists it (frame, drone, leg,
capture time, position, footprint, map update seq), so the map can lower under the drone as it flies.
``timeline`` and ``photographed`` are rebuilt with the fleet's lines and cells.
"""

from __future__ import annotations

import json
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "web/src/command/__fixtures__/demo_mission.json"
MAP = ROOT / "web/public/cache/demo/map.json"
START = datetime.fromisoformat("2026-10-24T21:50:00+00:00")  # the fleet launches
DT_S = 10.0  # simulated seconds per tick
MANAGER = "Search manager (scripted for the demo fixture)"
RETASK_AT = datetime.fromisoformat("2026-10-24T21:54:30+00:00")  # after the water-bottle clue
T2_NO_SIGNAL_AT = datetime.fromisoformat("2026-10-24T21:55:00+00:00")
D2_LOST_AT = datetime.fromisoformat("2026-10-24T21:55:40+00:00")  # still lost at the demo's 22:00
D3_DEGRADED_AT = datetime.fromisoformat("2026-10-24T21:58:30+00:00")  # still degraded at 22:00
END = datetime.fromisoformat("2026-10-24T21:59:40+00:00")


def iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def main() -> int:
    from fastapi.testclient import TestClient
    from PIL import Image
    from shapely.geometry import Point, Polygon

    from sightline.agent.trace import now_iso
    from sightline.api.app import create_app
    from sightline.api.missions import MissionContext
    from sightline.contract import (
        CONTRACT_VERSION,
        Distribution,
        Drone,
        LatLon,
        MapBase,
        MapFile,
        Proposal,
        Team,
    )
    from sightline.mission import MissionStore
    from sightline.mission.queue import LocalQueue
    from sightline.search.fleet import Crop, FleetSim, Scenario
    from sightline.search.planner import PlannerConfig, candidate_legs
    from sightline.search.sectors import lattice_sectors

    if not MAP.is_file() or not FIXTURE.is_file():
        print(
            f"need {MAP} (bash web/scripts/fetch-caches.sh) and {FIXTURE} (make_command_fixtures.py)"
        )
        return 1
    fx = json.loads(FIXTURE.read_text())
    m = MapFile.model_validate_json(MAP.read_text())
    base = MapBase(contract_version=CONTRACT_VERSION, grid=m.grid, lkp=m.lkp, params=m.params,
                   prior=Distribution(p=m.prior.p, outside=m.prior.outside), canopy=m.canopy)  # fmt: skip
    layout = lattice_sectors(m.grid)
    poly = {s.id: Polygon(layout.polygon(s.id, m.grid)) for s in layout.sectors}
    teams = [Team.model_validate(t) for t in fx["teams"]]
    t2 = next(t for t in teams if t.id == "T2")
    t2_sector = next(
        sid for sid, p in poly.items() if p.contains(Point(t2.position.lon, t2.position.lat))
    )
    bottle = next(c for c in fx["clues"] if "water bottle" in c["text"])
    retask_sector = next(
        sid for sid, p in poly.items() if p.contains(Point(bottle["lon"], bottle["lat"]))
    )
    # D2 and D3 open in the two sectors nearest Team Two's (not the clue's, where D1 is re-tasked)
    c2 = poly[t2_sector].centroid
    near = sorted((sid for sid in poly if sid not in (t2_sector, retask_sector, "B2")),
                  key=lambda sid: poly[sid].centroid.distance(c2))  # fmt: skip
    opening = {"D1": "B2", "D2": near[0], "D3": near[1]}

    clock = {"t": START}
    now = lambda: iso(clock["t"])
    lkp = m.lkp
    camp = fx["mission"].get("base_camp") or {"lat": lkp.lat, "lon": lkp.lon}
    home = LatLon(lat=camp["lat"], lon=camp["lon"])
    found = fx["mission"].get("found") or {"lat": 0.0, "lon": 0.0}
    drones = [
        Drone(
            id=f"D{k}",
            name=f"Drone {k}",
            simulated=True,
            position=home,  # on the pad at the base camp
            home=home,
            altitude_m=50,
            speed_ms=8,
            battery_pct=100,
            max_wind_kmh=43.2,
            status="idle",
            leg_id=None,
        )
        for k in (1, 2, 3)
    ]
    team = {"id": "T2", "callsign": "Team Two", "members": t2.members,
            "position": t2.position.model_dump()}  # fmt: skip
    scn = Scenario(name="demo fleet", lkp=lkp, drones=drones, hidden=LatLon(lat=found["lat"], lon=found["lon"]),
                   positive={}, clue=None, teams=(team,), relay_radius_m=300.0)  # fmt: skip

    class _Det:
        def detect_tiled(self, path, conf: float = 0.05):
            return []

    class _Hooks:
        def __getattr__(self, name):
            return lambda *a, **k: None

    with tempfile.TemporaryDirectory() as tmp_s:
        tmp = Path(tmp_s)
        img = tmp / "standin.jpg"
        Image.new("RGB", (800, 600), (60, 80, 60)).save(img, "JPEG")

        class _Pool:
            positive = Crop(img, (0, 0, 800, 600), 0.025)
            negatives = (positive,)

        store = MissionStore(tmp / "missions")
        ctx = MissionContext(
            store, queue=LocalQueue(), detector_factory=lambda: _Det(), hooks=_Hooks()
        )
        ctx.queue.run_worker(ctx.handle)  # the photo worker only: no scheduler on the real clock
        app = create_app(cache_root=tmp / "c", data_root=tmp / "u", missions=ctx)
        log: list[str] = []
        with TestClient(app) as http:
            mid = http.post("/missions", json={"name": "Demo fleet", "area_name": "Mount Seymour",
                                               "lkp": lkp.model_dump()}).json()["mission_id"]  # fmt: skip
            store.put_map_base(mid, base)
            for t in teams:
                http.post(f"/missions/{mid}/teams", json=t.model_dump(mode="json"))
            first_event = len(store.events(mid))
            stamps: dict[str, str] = {}  # event id -> the run's clock when it happened

            def stamp_new() -> None:
                for e in store.events(mid):
                    stamps.setdefault(e.id, now())

            stamp_new()
            sim = FleetSim(http, mid, scn, time_scale=1.0, pool=_Pool(), now=now, out=log.append, links=())  # fmt: skip
            sim.register()
            stamp_new()

            def approve(drone: Drone, sector: str, kind: str, why: str) -> None:
                leg = next(x for x in candidate_legs(drone, layout, m.grid, PlannerConfig(), lkp) if x.sector_id == sector)  # fmt: skip
                leg = leg.model_copy(update={"id": store.next_id(mid, "L"), "reason": why})
                p = store.add_proposal(mid, Proposal(
                    id="", kind=kind, summary=f"{'Re-task' if kind == 'retask_drone' else 'Send'} {drone.name} to sector {sector}",
                    reason=why, briefing=None, target={"drone": drone.id, "leg": leg.id}, leg=leg, evidence=[],
                    status="pending", created_by="command", created_at=now_iso(), decided_at=None, decided_by=None,
                    decision_reason=None, edits=None))  # fmt: skip
                store.decide_proposal(mid, p.id, "approve", MANAGER)

            for d in drones:
                approve(
                    d, opening[d.id], "drone_leg", "Opening leg (scripted for the demo fixture)."
                )
            stamp_new()
            done = set()
            while clock["t"] < END:
                clock["t"] += timedelta(seconds=DT_S)
                if clock["t"] >= RETASK_AT and "retask" not in done:
                    d1 = next(x for x in store.state(mid)["fleet"].drones if x.id == "D1")
                    approve(d1, retask_sector, "retask_drone",
                            f"Team Two's water bottle is in sector {retask_sector} (scripted for the demo fixture).")  # fmt: skip
                    done.add("retask")
                    stamp_new()
                if clock["t"] >= T2_NO_SIGNAL_AT and "t2" not in done:
                    sim.set_link("T2", "no_signal", by="scenario")
                    done.add("t2")
                if clock["t"] >= D2_LOST_AT and "d2" not in done:
                    sim.set_link("D2", "lost", by="scenario")
                    done.add("d2")
                if clock["t"] >= D3_DEGRADED_AT and "d3" not in done:
                    sim.set_link("D3", "degraded", by="scenario")
                    done.add("d3")
                sim.tick(DT_S)
                stamp_new()
            ctx.queue.join()
            fleet = store.state(mid)["fleet"]
            team_now = next(t for t in store.state(mid)["teams"] if t.id == "T2")
            events = store.events(mid)[first_event:]
            frames = store.survey(mid).frames
            steps = {u.ref: u for u in store.map_updates(mid) if u.source == "frame"}
        ctx.queue.stop()

    keep = [
        e for e in events
        if (e.type == "mission.note" and e.data and ("fleet_link" in e.data or "relay" in e.data))
        or (e.type == "fleet.updated" and e.ref and "approved for" in e.summary)
        or (e.type == "mission.note" and e.data and "drone" in e.data)
    ]  # fmt: skip
    fleet_events = []
    for e in keep:
        d = e.model_dump(mode="json")
        d["at"] = stamps[e.id]
        if e.type == "fleet.updated":
            d["data"] = None  # the final fleet is in the fixture; one copy is enough
            leg = next(x for x in fleet.legs if x.id == e.ref)
            gone = [
                x.id for x in fleet.legs if x.drone_id == leg.drone_id and x.status == "cancelled"
            ]
            retask = f" (re-task: {gone[0]} cancelled)" if gone and leg.id > gone[0] else ""
            d["summary"] = f"{e.summary}{retask} (simulated fleet)"
        fleet_events.append(d)
    # replace any earlier fleet events, then renumber every event in time order
    old = [e for e in fx["events"] if not _is_fleet(e)]
    merged = sorted(old + fleet_events, key=lambda e: e["at"])
    for k, e in enumerate(merged, 1):
        e["id"] = f"e{k:05d}"
    fx["events"] = merged
    fx["fleet"] = json.loads(fleet.model_dump_json())
    leg_photos(fx, events, frames, steps, stamps)
    from sightline.contract import MissionEvent
    from sightline.mission.timeline import timeline
    from sightline.search.grid import cell_containing

    def sector_of(lat: float, lon: float) -> str | None:
        rc = cell_containing(m.grid, LatLon(lat=lat, lon=lon))
        return (
            None
            if rc is None
            else layout.sectors[int(layout.cell_sector[rc[0] * m.grid.cols + rc[1]])].id
        )

    teams_now = [Team.model_validate(t) for t in fx["teams"]]
    fx["timeline"] = [x.model_dump(mode="json") for x in
                      timeline([MissionEvent.model_validate(e) for e in fx["events"]], teams_now, sector_of)]  # fmt: skip
    fx["teams"] = [
        json.loads(team_now.model_dump_json()) if t["id"] == "T2" else t for t in fx["teams"]
    ]
    if "make_fleet_fixture.py" not in fx["note"]:
        fx["note"] += (
            " The fleet (simulated drones, links, relays) is from scripts/make_fleet_fixture.py, a real run of sightline.search.fleet."
        )
    FIXTURE.write_text(json.dumps(fx, indent=1, ensure_ascii=False) + "\n")
    legs = {x.id: (x.drone_id, x.sector_id, x.status) for x in fleet.legs}
    print("\n".join(log[-12:]))
    print(f"\nlegs: {legs}")
    print(f"drones: {[(d.id, d.status, round(d.battery_pct)) for d in fleet.drones]}")
    print(f"{len(fleet_events)} fleet events; wrote {FIXTURE.relative_to(ROOT)}")
    return 0


def _is_fleet(e: dict) -> bool:
    d = e.get("data") or {}
    return e["type"] == "fleet.updated" or "fleet_link" in d or "relay" in d or "drone" in d


def leg_photos(fx: dict, events: list, frames: list, steps: dict, stamps: dict) -> None:
    """The legs' photos into the fixture: their map steps (after the cache's frames, at their
    capture times) and ``leg_photos``; ``photographed`` gets their cells."""
    taken = {e.ref: (e.data or {}).get("taken_at") for e in events if e.type == "photo.processed"}
    starts = sorted(
        (stamps[e.id], e.data["drone"]["drone"], e.data["drone"]["leg"])
        for e in events
        if e.type == "mission.note" and (e.data or {}).get("drone", {}).get("event") == "leg_start"
    )
    prev = {p["frame_id"] for p in fx.get("leg_photos", [])}  # a re-run replaces its own
    old = [u for u in fx["map_updates"] if u.get("ref") not in prev]
    seq = max((u["seq"] for u in old), default=500)
    first = 500  # the cache's photos are f0001..f0500
    out, updates = [], []
    for k, f in enumerate(frames, 1):
        u = steps.get(f.id)
        drone = f.source.image.split("_")[1] if f.source.image.startswith("SIM_") else None
        at = taken.get(f.id) or stamps.get(f.id)
        leg = next((lg for t, d, lg in reversed(starts) if d == drone and t <= (at or "")), None)
        fid = f"f{first + k:04d}"
        seq += 1
        if u is not None:
            updates.append({**u.model_dump(mode="json"), "seq": seq, "ref": fid, "at": at})
        out.append({"frame_id": fid, "drone": drone, "leg": leg, "at": at, "lat": f.pose.lat,
                    "lon": f.pose.lon, "footprint": [list(c) for c in f.footprint],
                    "map_seq": seq if u is not None else None})  # fmt: skip
    fx["map_updates"] = old + updates
    fx["leg_photos"] = out
    # the photographed flag with the legs' cells
    import numpy as np

    from sightline.search.coverage import runs

    flags = np.repeat(
        [v for v, _ in fx["photographed"]], [n for _, n in fx["photographed"]]
    ).astype(np.int8)
    for u in updates:
        for i, _ in u["cells"]:
            flags[int(i)] = 1
        for c in u.get("canopy") or []:
            flags[int(c[0])] = 1
    fx["photographed"] = runs(flags)


if __name__ == "__main__":
    raise SystemExit(main())
