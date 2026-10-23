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

``feeds``: one entry per leg for the console's "Drone feed" tile (``clip`` and ``poster`` under
``web/public/``, ``start_s`` in its 10 s loop, ``label`` "drone feed (public-domain footage, not this
flight)", ``credit``): public-domain U.S. Forest Service clips (``web/public/feed/CREDITS.md``), not
this flight.
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
WIND_AT = datetime.fromisoformat("2026-10-24T21:57:00+00:00")  # gusts rise past the drones' limit
STORY_T0 = datetime.fromisoformat(
    "2026-10-24T20:30:00+00:00"
)  # the story's call; a scenario shifts
SCENARIOS = ROOT / "web/src/command/__fixtures__/scenarios"
GUST_KMH = 52.0
# The scripted conditions update (demo only, labelled so): a forecast-page quote in the shape a Tavily
# lookup keeps, with the source named as the demo's script, never a real page.
GUST_QUOTE = "Wind gusting to 52 km/h over the upper slopes this afternoon"
GUST_SOURCE = "scripted for the demo scenario (not a real forecast)"


def iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--scenarios", action="store_true", help="also fly the four preset scenarios")
    ap.add_argument("--only-scenarios", action="store_true", help="skip the story")
    args = ap.parse_args(argv)
    paths = [] if args.only_scenarios else [FIXTURE]
    if args.scenarios or args.only_scenarios:
        paths += sorted(SCENARIOS.glob("*.json"))
    for path in paths:
        rc = fly(path)
        if rc:
            return rc
    return 0


def fly(path: Path) -> int:
    """One fixture's fleet: the story's (``demo_mission.json``) or a scenario's, on its own clock."""
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

    if not MAP.is_file() or not path.is_file():
        print(
            f"need {MAP} (bash web/scripts/fetch-caches.sh) and {path} (make_command_fixtures.py)"
        )
        return 1
    fx = json.loads(path.read_text())
    story = path == FIXTURE
    slug = "demo" if story else path.stem
    # a scenario's afternoon is the story's, shifted to its own call (its t0)
    shift = datetime.fromisoformat(fx["t0"]) - STORY_T0 if fx.get("t0") else timedelta(0)
    start, retask_at, t2_at, d2_at, d3_at, end, wind_at = (t + shift for t in (
        START, RETASK_AT, T2_NO_SIGNAL_AT, D2_LOST_AT, D3_DEGRADED_AT, END, WIND_AT))  # fmt: skip
    m = MapFile.model_validate_json(MAP.read_text())
    if fx.get("prior"):  # a scenario's own prior around its own LKP
        m = m.model_copy(update={"lkp": LatLon.model_validate(fx["prior"]["lkp"])})
    base = MapBase(contract_version=CONTRACT_VERSION, grid=m.grid, lkp=m.lkp, params=m.params,
                   prior=Distribution(p=m.prior.p, outside=m.prior.outside), canopy=m.canopy)  # fmt: skip
    layout = lattice_sectors(m.grid)
    poly = {s.id: Polygon(layout.polygon(s.id, m.grid)) for s in layout.sectors}
    teams = [Team.model_validate(t) for t in fx["teams"]]
    t2 = next(t for t in teams if t.id == "T2")
    t2_sector = next(
        sid for sid, p in poly.items() if p.contains(Point(t2.position.lon, t2.position.lat))
    )
    # D1 is re-tasked to the sector of the story's water bottle, or a scenario's last team clue
    radio_clues = [c for c in fx["clues"] if c["source"] == "radio"] or fx["clues"]
    bottle = next((c for c in fx["clues"] if "water bottle" in c["text"]), radio_clues[-1])
    who = {t.id: t.callsign for t in teams}.get(bottle["reported_by"], "The public")
    retask_sector = next(
        sid for sid, p in poly.items() if p.contains(Point(bottle["lon"], bottle["lat"]))
    )
    retask_why = (f"Team Two's water bottle is in sector {retask_sector} (scripted for the demo fixture)."
                  if story else f"{who}'s {bottle['kind']} clue ({bottle['text']}) is in sector "
                  f"{retask_sector} (scripted for the demo scenario).")  # fmt: skip
    # D2 and D3 open in the two sectors nearest Team Two's (not the clue's, where D1 is re-tasked)
    c2 = poly[t2_sector].centroid
    first = "B2" if retask_sector != "B2" else "B3"
    near = sorted((sid for sid in poly if sid not in (t2_sector, retask_sector, first)),
                  key=lambda sid: poly[sid].centroid.distance(c2))  # fmt: skip
    opening = {"D1": first, "D2": near[0], "D3": near[1]}

    clock = {"t": start}
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
            recalls: list = []
            gusty = None
            while clock["t"] < end:
                clock["t"] += timedelta(seconds=DT_S)
                if clock["t"] >= retask_at and "retask" not in done:
                    d1 = next(x for x in store.state(mid)["fleet"].drones if x.id == "D1")
                    approve(d1, retask_sector, "retask_drone", retask_why)
                    done.add("retask")
                    stamp_new()
                if clock["t"] >= t2_at and "t2" not in done:
                    sim.set_link("T2", "no_signal", by="scenario")
                    done.add("t2")
                if clock["t"] >= d2_at and "d2" not in done:
                    sim.set_link("D2", "lost", by="scenario")
                    done.add("d2")
                # the scenarios: gusts rise past the limit (the story keeps its fair afternoon)
                if not story and clock["t"] >= wind_at and "wind" not in done:
                    gusty, recalls = gusts_rise(store, mid, now())
                    done.add("wind")
                    stamp_new()
                if clock["t"] >= d3_at and "d3" not in done:
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
    if gusty is not None:
        wind(fx, gusty, recalls, iso(wind_at))
    fx["fleet"] = json.loads(fleet.model_dump_json())
    fx["feeds"] = feeds(fx["fleet"]["legs"])
    leg_photos(fx, events, frames, steps, stamps)  # first: the report counts the legs' map steps
    if "report" in fx:  # the after-action report's drone legs: minutes and photos per leg
        from sightline.mission.report import leg_rows

        shifted = [e.model_copy(update={"at": stamps.get(e.id, e.at)}) for e in events]
        fx["report"]["legs"] = leg_rows(fleet, shifted, frames)
        # every sector's final POD with the legs' photos too: the cache's frame steps, then the log
        from types import SimpleNamespace

        from sightline.mission.report import sector_pods

        prior = fx.get("prior") or json.loads((FIXTURE.parent / "demo_prior.json").read_text())
        looks = [SimpleNamespace(kind="step", cells=s.cells) for s in m.steps]
        looks += [SimpleNamespace(kind=u["kind"], cells=u["cells"]) for u in fx["map_updates"]]
        pods = sector_pods(SimpleNamespace(prior=SimpleNamespace(p=prior["p"])), looks, layout)
        for row in fx["report"]["sectors"]:
            row["pod"] = pods[row["sector"]]
        fx["report"]["drones"] |= {
            "legs_flown": sum(x.status == "done" for x in fleet.legs),
            "legs_cancelled": sum(x.status == "cancelled" for x in fleet.legs),
            "simulated": fleet.simulated,
            "flight_minutes": round(sum(x["minutes"] for x in fx["report"]["legs"]
                                        if x["minutes_from"] == "reported"), 1),
            "flight_minutes_from": "the legs' start and end reports (a re-tasked leg until the next starts)",
        }  # fmt: skip
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
    from sightline.radio.voices import attach_audio

    attach_audio(fx["timeline"], slug, ROOT / "web/public")  # the voices, when they still fit
    fx["teams"] = [
        json.loads(team_now.model_dump_json()) if t["id"] == "T2" else t for t in fx["teams"]
    ]
    if "make_fleet_fixture.py" not in fx["note"]:
        fx["note"] += (
            " The fleet (simulated drones, links, relays) is from scripts/make_fleet_fixture.py, a real run of sightline.search.fleet."
        )
    path.write_text(json.dumps(fx, indent=1, ensure_ascii=False) + "\n")
    legs = {x.id: (x.drone_id, x.sector_id, x.status) for x in fleet.legs}
    print("\n".join(log[-12:]))
    print(f"\nlegs: {legs}")
    print(f"drones: {[(d.id, d.status, round(d.battery_pct)) for d in fleet.drones]}")
    print(
        f"{len(fleet_events)} fleet events, {len(recalls)} recall proposals; wrote {path.relative_to(ROOT)}"
    )
    return 0


def gusts_rise(store, mid: str, at: str):
    """The scripted conditions update: gusts past the drones' limit, kept in the trace the way a
    conditions lookup keeps a value (the quote, the source), then the agent on it: its recall
    proposals (``loop._recall``). Returns ``(conditions, proposals)``."""
    from sightline.agent import loop
    from sightline.agent.trace import trace_call
    from sightline.contract import Conditions

    c = Conditions(
        fetched_at=at, stale=False, area="Mount Seymour", sources=[GUST_SOURCE],
        wind_kmh=28.0, gust_kmh=GUST_KMH, wind_dir_deg=290.0, precip_mm_h=None, precip_prob=None,
        temp_c=9.0, visibility_km=None, sunset=None, civil_twilight_end=None, alerts=[],
        flyable=False, flyable_until=None,
        flyability_reason=f"gusts {GUST_KMH:.0f} km/h at or above the drones' limit of 43 km/h",
        visibility_factor=1.0, exposure_band=None, exposure_note="",
    )  # fmt: skip
    trace_call(store, mid, actor="conditions", kind="tool_call",
               summary=f"conditions update: gusts {GUST_KMH:.0f} km/h ({GUST_SOURCE})",
               output={"source": GUST_SOURCE, "fields": {"gust_kmh": {
                   "value": GUST_KMH, "quote": GUST_QUOTE, "url": None, "source": GUST_SOURCE}}})  # fmt: skip
    store.put_conditions(mid, c)
    loop._recalled.pop(mid, None)
    out = loop.handle("conditions", store, mid, mid, client=None)
    return c, [p.model_copy(update={"created_at": at}) for p in out if p.kind == "retask_drone"]


def wind(fx: dict, c, recalls: list, at: str) -> None:
    """The gusts and the agent's recall proposals into the fixture: the conditions (now), a
    ``conditions.updated`` event, each recall as a pending proposal (ids after the fixture's own)
    with its ``proposal.new`` event; events renumbered in time order."""
    n = max((int(p["id"][1:]) for p in fx["proposals"]), default=0)
    fx["conditions"] = c.model_dump(mode="json")
    new = [{"id": "", "type": "conditions.updated", "at": at, "ref": None, "data": None,
            "summary": f"conditions: gusts {GUST_KMH:.0f} km/h ({GUST_SOURCE}): not flyable"}]  # fmt: skip
    ids = {}
    for k, p in enumerate(recalls, 1):
        d = p.model_dump(mode="json")
        ids[d["id"]] = d["id"] = f"p{n + k:03d}"
        fx["proposals"] = [x for x in fx["proposals"] if x["id"] != d["id"]] + [d]
        new.append({"id": "", "type": "proposal.new", "at": at, "ref": d["id"], "data": d,
                    "summary": f"agent proposes: {d['summary']}"})  # fmt: skip
    fx["events"] = sorted(
        [e for e in fx["events"] if e["type"] != "conditions.updated" or e["at"] != at] + new,
        key=lambda e: e["at"],
    )
    for k, e in enumerate(fx["events"], 1):
        e["id"] = f"e{k:05d}"


# The "Drone feed" tile's clips (web/public/feed/, CREDITS.md there): public-domain U.S. Forest
# Service footage, not this flight, and labelled so wherever it plays.
FEED_CLIPS = ("feed/forest-1.mp4", "feed/forest-2.mp4")
FEED_LABEL = "drone feed (public-domain footage, not this flight)"
FEED_CREDIT = "U.S. Forest Service video (Shasta-Trinity National Forest), via DVIDS; public domain"
FEED_LOOP_S = 10.0


def feeds(legs: list[dict]) -> list[dict]:
    """One feed entry per leg: which clip the tile plays while the leg flies and where in the 10 s
    loop it starts (drones take turns between the clips; the start steps by 3 s per leg)."""
    order = sorted({x["drone_id"] for x in legs})
    out = []
    for k, leg in enumerate(legs):
        clip = FEED_CLIPS[order.index(leg["drone_id"]) % len(FEED_CLIPS)]
        out.append({"leg": leg["id"], "drone": leg["drone_id"], "sector": leg.get("sector_id"),
                    "clip": clip, "poster": clip.replace(".mp4", ".jpg"),
                    "start_s": round((3.0 * k) % FEED_LOOP_S, 1), "loop_s": FEED_LOOP_S,
                    "label": FEED_LABEL, "credit": FEED_CREDIT})  # fmt: skip
    return out


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
    first = 500 + len(
        fx.get("distractors") or []
    )  # the cache's f0001..f0500, a scenario's distractors
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
