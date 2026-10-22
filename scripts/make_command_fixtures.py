"""The command view's demo mission (LANE_E §7 E-04), run through the product: the fixtures the Vercel
site (no API) shows at `#m/demo`, and the trace behind every proposal in them.

    bash web/scripts/fetch-caches.sh                 # once: the demo cache
    uv run python scripts/make_command_fixtures.py   # this: the mission, its map log and its trace
    uv run python scripts/make_fleet_fixture.py      # then: the simulated fleet on top

Nothing in the mission is written by hand except what people do. The real mission API (``create_app``,
``MissionStore``, ``effects``) runs in this process (``TestClient``), on the demo cache's map: its 500
frame steps go into the mission's map log at the flight's times; the confirmed clues are posted to
``POST /clues`` and reweight the map with ``LiveMap.clue_update``; the search manager's task updates go
to ``POST /tasks`` (ground steps). The agent's own code makes every proposal: ``loop.handle`` for each
near-miss detection in the cache (the second look: OpenCV re-look tools, then the VL model) and for the
planner's tick (``propose_assignments`` on the map as it stands, a briefing per assignment). Decisions go
through ``POST /proposals/{pid}/decide``, as a scripted search manager and image reviewer (named so).

**The models are fakes, and say so.** No model is called: the VL model's answers are scripted per
detection from a person looking at the crop (``VL_ANSWERS``), and a briefing is its facts, one sentence
each (``loop.template_briefing``, as ``scripts/agent_eval.py`` does). Both are traced under the model
name ``fake/<model>`` with a reason that says so. The clock is the demo's afternoon (UTC in the files,
13:35 to 15:00 PDT on screen): every ``now`` the product reads is patched to it.

Writes ``web/src/command/__fixtures__/demo_mission.json`` (mission, teams, tasks, clues, proposals,
events, conditions, the 16 sectors' POA and drone coverage, and ``map_updates``: the log after the
cache's frame steps), ``demo_trace.jsonl`` (the mission's whole trace) and the second look's images in
``__fixtures__/relook/``. Everything is validated against the contract; a fixture that says "clear" is
refused. Everything here is a demo, labelled so on screen.
"""

from __future__ import annotations

import json
import re
import shutil
import sys
import tempfile
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
FIX = ROOT / "web/src/command/__fixtures__"
OUT = FIX / "demo_mission.json"
TRACE = FIX / "demo_trace.jsonl"
RELOOK = FIX / "relook"
CACHE = ROOT / "web/public/cache/demo"
T0 = datetime.fromisoformat("2026-10-24T20:30:00+00:00")
FLIGHT = (T0 + timedelta(minutes=12), T0 + timedelta(minutes=48))  # missionTime.ts FLIGHT
NOW = T0 + timedelta(minutes=90)
MANAGER = "Search manager (scripted for the demo fixture)"
REVIEWER = "Image reviewer (scripted for the demo fixture)"
FAKE = "scripted for the demo fixture: no model was called"
TRAILHEAD = {"lat": 49.373, "lon": -122.949}  # missionTime.ts TRAILHEAD: the lot, the subject's car

# The fake VL model's answer per near-miss detection (0.15 to 0.29: the verifier's band), from a
# person looking at the crop in the cache's photo. f0273-d02 is a person in red beside the group in
# f0273; f0396-d01 a red shape under the trees at the photo's top edge; f0049-d01 a pale shape in rock;
# f0423-d01 the photo's edge, nothing in it.
VL_ANSWERS: dict[str, dict] = {
    "f0273-d02": {"person": "yes", "posture": "standing", "group_size": 1, "clothing": "red top",
                  "reason": "A person in a red top, beside the group in this photo"},
    "f0396-d01": {"person": "yes", "posture": "lying", "group_size": 1, "clothing": "red",
                  "reason": "A red shape the size of a person lying under the trees, at the photo's edge"},
    "f0049-d01": {"person": "unclear", "posture": "unknown", "group_size": None, "clothing": None,
                  "reason": "A pale shape among rocks; no head or limbs can be made out"},
    "f0423-d01": {"person": "no", "posture": "unknown", "group_size": None, "clothing": None,
                  "reason": "Bare ground at the photo's edge; nothing shaped like a person"},
}  # fmt: skip


def iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def at(minutes: float) -> datetime:
    return T0 + timedelta(minutes=minutes)


class Clock:
    """The demo's mission clock: every ``now`` the product reads, patched to this."""

    def __init__(self) -> None:
        self.t = T0

    def iso_ms(self) -> str:
        return self.t.strftime("%Y-%m-%dT%H:%M:%SZ")  # whole seconds: every step moves it on by one

    def patch(self) -> None:
        import sightline.agent.loop
        import sightline.agent.trace
        import sightline.agent.verify
        import sightline.api.missions
        import sightline.mission.effects
        import sightline.mission.store
        import sightline.search.live

        for mod in (sightline.agent.trace, sightline.agent.loop, sightline.agent.verify,
                    sightline.mission.store, sightline.mission.effects, sightline.api.missions):  # fmt: skip
            mod.now_iso = self.iso_ms  # type: ignore[attr-defined]
        sightline.search.live._now = self.iso_ms  # type: ignore[attr-defined]

    def tick(self, seconds: float = 1.0) -> None:
        """A step forward, so entries made one after another keep their order."""
        self.t += timedelta(seconds=seconds)


def briefing(facts: dict) -> str:
    """The fake briefing model: a few of the facts, word for word, in the radio's order (the agent's
    ``check_briefing`` still checks it; the full facts are in the proposal's reason)."""
    parts = [f"{facts['team']}, Sightline. New assignment: sector {facts['sector']}."] if "team" in facts else []
    if facts.get("subject"):
        parts.append(f"Look for: {facts['subject']}.")
    if facts.get("daylight_left"):
        parts.append(f"Daylight left: {facts['daylight_left']}.")
    return " ".join(parts)


class FakeModels:
    """The scripted VL answers and the briefings above, traced as ``fake/<model>``."""

    def __init__(self) -> None:
        self.next_vl: dict | None = None

    def chat(self, messages: list[dict], *, model: str, **kw: Any) -> Any:
        from sightline.agent.llm import ChatResult, last_user_text
        from sightline.agent.loop import template_briefing

        prompt = last_user_text(messages)
        if "Facts:" in prompt:
            text = briefing(json.loads(prompt.rsplit("Facts:\n", 1)[1])) or template_briefing({})
        elif self.next_vl is not None:
            a = dict(self.next_vl)
            a["reason"] = f"{a['reason']} ({FAKE})."
            text = json.dumps(a)
        else:
            text = "{}"
        return ChatResult(text, [], f"fake/{model}", 0, len(prompt.split()), len(text.split()))


class NoDetector:
    """The re-look's re-detection (``redetect_region``): no detector runs for the fixture."""

    def detect_array(self, img_bgr: Any, conf: float = 0.05) -> list:
        return []

    def detect_tiled(self, path: Any, conf: float = 0.05, **_: Any) -> list:
        return []


class NoHooks:
    """The API's agent hooks: off. The script calls ``loop.handle`` itself, in order, on its clock."""

    def __getattr__(self, name: str) -> Any:
        return lambda *a, **k: None


def main() -> int:
    from fastapi.testclient import TestClient

    from sightline.agent import loop
    from sightline.api.app import create_app
    from sightline.api.missions import MissionContext
    from sightline.contract import (
        CONTRACT_VERSION,
        Conditions,
        Detections,
        Distribution,
        MapBase,
        MapFile,
        MapUpdate,
        Mission,
        MissionEvent,
        Proposal,
        RadioTurn,
        SectorTask,
        Survey,
        Team,
        TraceEntry,
    )
    from sightline.geo.cards import sector_label
    from sightline.mission import MissionStore
    from sightline.mission.queue import LocalQueue
    from sightline.radio.mount import StoreMissionApi
    from sightline.search.sectors import lattice_sectors

    if not (CACHE / "map.json").is_file():
        print(f"no {CACHE}/map.json: run `bash web/scripts/fetch-caches.sh` first")
        return 1
    m = MapFile.model_validate_json((CACHE / "map.json").read_text())
    survey = Survey.model_validate_json((CACHE / "survey.json").read_text())
    dets = Detections.model_validate_json((CACHE / "detections.json").read_text())
    base = MapBase(contract_version=CONTRACT_VERSION, grid=m.grid, lkp=m.lkp, params=m.params,
                   prior=Distribution(p=m.prior.p, outside=m.prior.outside), canopy=m.canopy)  # fmt: skip
    layout = lattice_sectors(m.grid)
    clock = Clock()
    clock.patch()
    import sightline.api.missions

    # no conditions lookup (Tavily): the demo's conditions are the fair-weather fixture, put in below
    sightline.api.missions._fetch_conditions = lambda: None  # type: ignore[attr-defined]
    models = FakeModels()
    lkp = m.lkp

    tmp = Path(tempfile.mkdtemp(prefix="demo-mission-"))
    store = MissionStore(tmp / "missions")
    ctx = MissionContext(store, queue=LocalQueue(), detector_factory=lambda: NoDetector(), hooks=NoHooks())
    ctx.start()
    app = create_app(cache_root=tmp / "c", data_root=tmp / "u", missions=ctx, rate_limit=None)
    http = TestClient(app)
    radio = StoreMissionApi(store)

    def call(method: str, path: str, **kw: Any) -> Any:
        r = http.request(method, path, **kw)
        if r.status_code >= 400:
            raise RuntimeError(f"{method} {path}: {r.status_code} {r.text[:300]}")
        return r.json()

    # --- the call (20:30): the mission, its map (the demo cache's), the teams at the trailhead lot ---
    clock.t = at(0)
    mission = call("POST", "/missions", json={
        "name": "Mount Seymour (demo)", "area_name": "Mount Seymour", "lkp": lkp.model_dump(),
        "mode": "demo", "last_seen_at": iso(at(-180)), "subject": "adult, red jacket, day hiker"})  # fmt: skip
    mid = mission["mission_id"]
    store.put_map_base(mid, base)
    for k, d in enumerate(survey.frames):
        store.append_frame(mid, d.model_copy(update={"rank": k + 1}), (CACHE / d.file).read_bytes())
    store.set_frames(mid, survey.frames)
    for fid, ds in dets.frames.items():
        crops = {x.crop: (CACHE / x.crop).read_bytes() for x in ds if x.crop}
        store.append_detections(mid, fid, ds, crops)
    seeded = len(store.events(mid))  # the cache's own candidates: in the cache, not the mission's feed
    clock.tick(30)
    store.emit(mid, "mission.note", "the subject's car is in the Mount Seymour trailhead lot: the search starts there (where they set off, not a clue on the map)")  # fmt: skip
    for tid in ("T1", "T2", "T3", "T4"):
        # Teams One and Four are at the lot; Two and Three check in later (off duty until then)
        status = "off_duty" if tid in ("T2", "T3") else "standby"
        call("PATCH", f"/missions/{mid}/teams/{tid}", json={"position": TRAILHEAD, "position_at": iso(at(1)), "status": status})
    fair = json.loads((ROOT / "tests/geo/fixtures/conditions_clear.json").read_text())["conditions"]

    def conditions(minutes: float) -> Conditions:
        return Conditions.model_validate(fair | {"fetched_at": iso(at(minutes)), "sources": ["fixture (demo)"]})

    clock.t = at(5)
    store.put_conditions(mid, conditions(5))  # the first lookup; the same fair weather again at 21:30

    # --- the timeline: frames as they land, and what people and the agent do around them ---------
    schedule: list[tuple[datetime, int, Any]] = []
    n = len(m.steps)
    span = (FLIGHT[1] - FLIGHT[0]).total_seconds()
    for k, s in enumerate(m.steps):
        schedule.append((FLIGHT[0] + timedelta(seconds=round(span * k / (n - 1))), 0, ("frame", s)))

    def later(minutes: float, what: Any) -> None:
        schedule.append((at(minutes), 1, what))

    later(12, ("event", "photo.processed", "f0001 processed (the flight starts)", "f0001"))
    later(48, ("event", "photo.processed", "f0500 processed (the flight ends)", "f0500"))
    # the near-miss detections get the agent's second look a few seconds after their photo lands
    near = [x for ds in dets.frames.values() for x in ds if 0.15 <= x.conf < 0.29]
    order = {f.id: k for k, f in enumerate(survey.frames)}
    for x in near:
        k = order[x.frame_id] if hasattr(x, "frame_id") else order[x.id.split("-")[0]]
        t = FLIGHT[0] + timedelta(seconds=round(span * k / (n - 1)) + 8)
        schedule.append((t, 2, ("detection", x.id)))
    clue_lake = {"kind": "other", "text": "hiker at the lot saw a red jacket near the lake around 11:30",
                 "d": (0.0004, 0.0021), "reliability": "medium", "reported_by": "command", "source": "form"}
    clue_boots = {"kind": "track", "text": "fresh boot prints heading east off the main trail",
                  "d": (0.0010, -0.0008), "reliability": "medium", "reported_by": "T1", "source": "form"}
    clue_bottle = {"kind": "object", "text": "blue water bottle by the creek crossing", "d": (-0.0013, 0.0009),
                   "reliability": "high", "reported_by": "T2", "source": "radio", "confirmed_by_turn": "r0004"}
    clue_whistle = {"kind": "sound", "text": "possible whistle, three blasts, to the south-west", "d": (-0.0006, -0.0012),
                    "reliability": "low", "reported_by": "T1", "source": "radio", "confirmed_by_turn": "r0007"}  # fmt: skip
    later(40, ("clue", clue_lake))
    later(50, ("task", "C4", {"state": "assigned", "team_id": "T4"}, "Team Four: hasty search of the trail through C4 (search manager)"))
    later(51, ("task", "C4", {"state": "in_progress", "team_id": "T4"}, None))
    later(51.2, ("team", "T4", {"status": "searching"}))
    later(56, ("place", "T4", "C4", (0.45, 0.4)))
    later(82, ("place", "T4", "B4", (0.3, 0.55)))
    later(66, ("clue", clue_boots))
    later(67.8, ("turn", "r0004", "Team Two", "Sightline, Team Two. Blue water bottle by the creek crossing, over.", "Team Two, Sightline. Copy a blue water bottle by the creek crossing, logging it as a clue. Confirm, over."))
    later(68, ("clue", clue_bottle))
    later(69.8, ("turn", "r0007", "Team One", "Sightline, Team One. Possible whistle, three blasts, to the south-west, over.", "Team One, Sightline. Copy a possible whistle, three blasts, south-west, low reliability. Confirm, over."))
    later(70, ("clue", clue_whistle))
    later(60, ("conditions",))
    later(72, ("tick",))  # 21:42, Where next: the planner on the map with the clues (Team One on standby)
    later(73, ("decide", "T1", "approve", None))
    later(73.5, ("checkin", "T2"))  # Team Two checks in at the lot: its next sector
    later(75, ("decide", "T2", "approve", None))
    later(75.5, ("checkin", "T3"))
    later(77, ("decide", "T3", "approve", None))
    later(78, ("task_team", "T1", "in_progress"))
    later(80, ("searched", "C4", 0.4, "steep; the gully not entered"))
    later(80.5, ("task", "B4", {"state": "assigned", "team_id": "T4"}, None))
    later(81, ("task_team", "T2", "in_progress"))
    later(81.5, ("task", "B4", {"state": "in_progress", "team_id": "T4"}, None))
    later(86, ("searched", "B4", 0.6, "trail and both ditches, thick salal on the east side"))
    later(86.5, ("team", "T4", {"status": "standby"}))
    later(85, ("position", "T1"))
    later(88, ("position", "T2"))
    later(84, ("position", "T3"))
    schedule.sort(key=lambda x: (x[0], x[1]))

    def team_of(tid: str) -> Team:
        return next(t for t in store.state(mid)["teams"] if t.id == tid)

    def task_of(sid: str) -> SectorTask:
        return next(t for t in store.state(mid)["tasks"] if t.sector_id == sid)

    def assignment_of(tid: str) -> Proposal:
        return next(p for p in store.state(mid)["proposals"] if p.kind == "assign_sector" and p.target.get("team") == tid)

    def sector_point(sid: str, f: tuple[float, float]) -> dict:
        poly = layout.polygon(sid, m.grid)
        lons, lats = [p[0] for p in poly], [p[1] for p in poly]
        return {"lat": round(min(lats) + (max(lats) - min(lats)) * f[0], 6),
                "lon": round(min(lons) + (max(lons) - min(lons)) * f[1], 6)}  # fmt: skip

    reviewed: list[tuple[datetime, str]] = []
    first_map_update = None
    for t, _, what in schedule:
        clock.t = max(clock.t, t)
        kind = what[0]
        if kind == "frame":
            s = what[1]
            u = store.append_map_update(mid, MapUpdate(seq=1, kind="step", source="frame", ref=s.frame_id,
                                                       cells=s.cells, canopy=None, at=clock.iso_ms()))  # fmt: skip
            first_map_update = first_map_update or u.seq
        elif kind == "turn":
            # a radio turn typed at the desk (no speech, no model), committed after the team's
            # "affirmative" to the readback, recorded as the radio desk records it (radio/mount.py)
            rid, callsign, said, readback = what[1], what[2], what[3], what[4]
            radio.record_turn(mid, RadioTurn(
                id=rid, direction="in", callsign=callsign, transcript=f"{said} (typed for the demo fixture)",
                reply=readback, audio=None, state="committed", actions=["log clue"], asr_ms=None, llm_ms=None,
                tts_ms=None, at=clock.iso_ms()))  # fmt: skip
        elif kind == "event":
            store.emit(mid, what[1], what[2], ref=what[3])
        elif kind == "detection":
            models.next_vl = VL_ANSWERS.get(what[1])
            out = loop.handle("detection", store, mid, what[1], client=models, detector=NoDetector())
            for p in out:
                if p.kind == "promote_detection":
                    reviewed.append((clock.t, p.id))
        elif kind == "clue":
            d = what[1]
            body = {k: v for k, v in d.items() if k != "d"} | {"lat": lkp.lat + d["d"][0], "lon": lkp.lon + d["d"][1]}
            clue = call("POST", f"/missions/{mid}/clues", json=body)
            loop.handle("clue", store, mid, clue["id"], client=models)
        elif kind == "task":
            sid, body, note = what[1], what[2], what[3]
            call("POST", f"/missions/{mid}/tasks/{sid}", json=body)
            if note:
                clock.tick()
                store.emit(mid, "mission.note", note, ref=sid)
        elif kind == "team":
            call("PATCH", f"/missions/{mid}/teams/{what[1]}", json=what[2])
        elif kind == "conditions":
            store.put_conditions(mid, conditions((clock.t - T0).total_seconds() / 60))
        elif kind == "checkin":
            call("PATCH", f"/missions/{mid}/teams/{what[1]}", json={"status": "standby"})
            loop.handle("team_position", store, mid, what[1], client=models)
        elif kind == "tick":
            loop.handle("tick", store, mid, mid, client=models)
        elif kind == "decide":
            p = assignment_of(what[1])
            call("POST", f"/missions/{mid}/proposals/{p.id}/decide",
                 json={"decision": what[2], "by": MANAGER, "reason": what[3]})  # fmt: skip
        elif kind == "task_team":
            sid = assignment_of(what[1]).target["sector"]
            call("POST", f"/missions/{mid}/tasks/{sid}", json={"state": what[2], "team_id": what[1]})
            call("PATCH", f"/missions/{mid}/teams/{what[1]}", json={"status": "searching"})
        elif kind == "searched":
            sid, pod, note = what[1], what[2], what[3]
            call("POST", f"/missions/{mid}/tasks/{sid}", json={"state": "searched", "team_id": "T4", "pod": pod, "note": note})
            loop.handle("task_searched", store, mid, sid, client=models)
        elif kind == "place":
            call("PATCH", f"/missions/{mid}/teams/{what[1]}", json={"position": sector_point(what[2], what[3]), "position_at": clock.iso_ms()})
        elif kind == "position":
            sid = assignment_of(what[1]).target["sector"]
            f = {"T1": (0.55, 0.35), "T2": (0.4, 0.6), "T3": (0.85, 0.5)}[what[1]]
            call("PATCH", f"/missions/{mid}/teams/{what[1]}", json={"position": sector_point(sid, f), "position_at": clock.iso_ms()})
        # the image reviewer decides each promotion three minutes after it is made; the last stays pending
        for when, pid in list(reviewed):
            if clock.t >= when + timedelta(minutes=3) and pid != reviewed[-1][1]:
                clock.tick()
                call("POST", f"/missions/{mid}/proposals/{pid}/decide", json={"decision": "approve", "by": REVIEWER, "reason": None})
                reviewed.remove((when, pid))
        clock.tick()

    clock.t = max(clock.t, NOW)
    state = store.state(mid)
    live = store.live(mid)
    poa = live.sector_poa(layout)
    stepped = {i for u in store.map_updates(mid) if u.source == "frame" for i, _ in u.cells}
    sectors = []
    for s in layout.sectors:
        cells = layout.cells_of(s.id)
        sectors.append({
            "sector_id": s.id, "label": sector_label(s.id), "poa": round(poa[s.id], 4),
            "drone_coverage": round(sum(int(i) in stepped for i in cells) / len(cells), 3),
            "polygon": [list(c) for c in layout.polygon(s.id, m.grid)],
        })  # fmt: skip
    # the map log after the cache's frame steps (the browser builds those from map.json, seq 1..n)
    rest = [u for u in store.map_updates(mid) if u.source != "frame"]
    map_updates = [u.model_copy(update={"seq": n + k + 1}) for k, u in enumerate(rest)]
    events = [e for e in store.events(mid)[seeded:] if not (e.type == "map.updated" and e.data and e.data.get("source") == "frame")]
    # the creation's own events (mission.note, the 16 proposed tasks) happened before the cache seeding
    events = [e for e in store.events(mid)[:seeded] if e.type in ("mission.note", "task.updated")] + events
    trace = store.trace_entries(mid)
    mission_out = Mission.model_validate({**state["mission"].model_dump(), "mission_id": "demo"})
    proposals = state["proposals"]

    # the second look's images, for the demo's Trace view and inbox (the store's relook/ folder)
    if RELOOK.exists():
        shutil.rmtree(RELOOK)
    RELOOK.mkdir(parents=True)
    src = tmp / "missions" / mid / "relook"
    for f in sorted(src.glob("*.jpg")) if src.is_dir() else []:
        shutil.copy(f, RELOOK / f.name)

    def dump(xs: list) -> list:
        return [x.model_dump(mode="json") for x in xs]

    doc = {
        "note": "Generated by scripts/make_command_fixtures.py: the demo mission run through the mission API and the agent's own code, on the demo cache's map, with fake models (scripted VL answers, template briefings) and a scripted search manager and image reviewer; do not edit by hand. A demo.",
        "now": iso(NOW),
        "mission": mission_out.model_dump(mode="json"),
        "teams": dump(state["teams"]),
        "tasks": dump(state["tasks"]),
        "clues": dump(state["clues"]),
        "proposals": dump(proposals),
        "conditions": state["conditions"].model_dump(mode="json"),
        "events": [],
        "sectors": sectors,
        "map_updates": dump(map_updates),
    }
    seen_ids = 0
    out_events = []
    renumbered = {u.seq: v.seq for u, v in zip(rest, map_updates, strict=True)}
    for e in sorted(events, key=lambda e: e.at):
        seen_ids += 1
        patch: dict[str, Any] = {"id": f"e{seen_ids:05d}"}
        if e.type == "map.updated" and e.data:
            # the update itself is in map_updates (renumbered after the cache's frames): one copy
            seq = renumbered[e.data["seq"]]
            patch |= {"data": None, "summary": f"map update {seq} ({e.data['source']})"}
        e = MissionEvent.model_validate({**e.model_dump(), **patch})
        out_events.append(e.model_dump(mode="json"))
    doc["events"] = out_events
    text = json.dumps(doc, indent=1, ensure_ascii=False)
    trace_text = "".join(TraceEntry.model_validate(x.model_dump()).model_dump_json() + "\n" for x in trace)
    for name, body in (("fixture", text), ("trace", trace_text)):
        assert not re.search(r"\bclear(s|ed|ing)?\b", body, re.IGNORECASE), f"the {name} says clear"
    OUT.write_text(text + "\n")
    TRACE.write_text(trace_text)
    shutil.rmtree(tmp, ignore_errors=True)

    print(f"wrote {OUT.relative_to(ROOT)}: {len(state['tasks'])} tasks, {len(state['clues'])} clues, "
          f"{len(proposals)} proposals, {len(out_events)} events, {len(map_updates)} map updates after the frames")  # fmt: skip
    print(f"wrote {TRACE.relative_to(ROOT)}: {len(trace)} entries; {len(list(RELOOK.glob('*.jpg')))} re-look images")
    for p in proposals:
        print(f"  {p.id} {p.kind} {p.status:<8} {p.summary}\n      {p.reason}")
    print("sectors by POA:", [(x["sector_id"], round(x["poa"] * 100, 1)) for x in sorted(sectors, key=lambda x: -x["poa"])])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
