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

**The models are fakes, and say so, but for one recorded answer.** No model is called: the VL model's
answers are scripted per detection from a person looking at the crop (``VL_ANSWERS``), and a briefing is
its facts, one sentence each (``loop.template_briefing``, as ``scripts/agent_eval.py`` does). Both are
traced under the model name ``fake/<model>`` with a reason that says so. The one exception is the second
look the story shows at Confirm (#192): ``scripts/make_second_look_fixture.py`` ran it on this flight's
f0273-d02 with the live VL model, and its answer (``__fixtures__/second_look/verdict.json``) is replayed
here word for word, traced as ``recorded/<model>`` with the recorded time and tokens. The clock is the demo's afternoon (UTC in the files,
13:35 to 15:00 PDT on screen): every ``now`` the product reads is patched to it.

Writes ``web/src/command/__fixtures__/demo_mission.json`` (mission, teams, tasks, clues, proposals,
events, conditions, the 16 sectors' POA and drone coverage, and ``map_updates``: the log after the
cache's frame steps), ``demo_trace.jsonl`` (the mission's whole trace) and the second look's images in
``__fixtures__/relook/``. Everything is validated against the contract; a fixture that says "clear" is
refused. Everything here is a demo, labelled so on screen.

**v1.3 (the command post).** The mission has a base camp (the trailhead lot); the search manager also
acts directly (assigns Team Four, marks C4 and B4 searched at their POD, calls Team Three); every team
carries ``last_heard_at`` and ``eta_min``; the fixture has the one ``timeline`` (radio, clue, detection,
decision, checkin, drone, found) and ``photographed`` (the cells a photo has looked at, run-length,
the veil flag); the prior is Koester's rings for the subject's category over the whole grid
(``demo_prior.json``, the web's map base instead of the cache's uniform placeholder); and the story
ends found: Team One radios that it has the subject in C2, at the sector's likeliest cell, and the
search manager marks the mission found (``POST /found``), which writes the after-action report.

    uv run python scripts/make_command_fixtures.py --scenarios     # also the four preset scenarios
    uv run python scripts/make_command_fixtures.py --scenario 77   # one more, any seed

**Scenarios** (``sightline/search/demo_scenario.py``): each writes ``__fixtures__/scenarios/<slug>.json``,
the same shape as ``demo_mission.json`` plus ``scenario`` (what the seed drew, without the person's
position), ``t0`` and ``flight`` (its own clock) and its own ``prior``: the LKP inside the survey, the
category's prior, its clues at their times, the agent's assignments approved, and the team in the
person's sector finding them (the search manager assigns one directly when the agent sent none there).
The same seed draws the same scenario and the same story (only timings measured in the run differ).
No trace and no fleet for a scenario.

**Distractors** (scenarios only): the scenario's ``distractors`` (a backpack, a fire ring, a shelter,
other hikers: real licensed aerial photos in ``web/public/cache-extras/distractors/``, ``CREDITS.md``
there) land as extra photos of the flight (``f0501`` on), a few seconds after the survey photo each is
placed next to, each with the detection ``scripts/make_distractor_fixture.py`` recorded on it. The
second look replays that script's **live** VL answer word for word (``__fixtures__/distractors/``,
traced as ``recorded/<model>``); three minutes later the scripted image reviewer answers: "object"
(with the object type: the clue candidate, low reliability until a team confirms it) or "not_subject"
(other hikers), approving the promotion first when the second look made one. The fixture's
``distractors`` lists each (photo, detection, verdict, the answer, the clue candidate).

**Voices**: each radio line's ``audio`` (``web/public/voices/<scenario>/``, from
``scripts/make_voice_fixture.py``) is attached when its clip still says the line.
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
PRESET_SLUG = {1101: "overdue-hiker", 2202: "missing-child", 3303: "despondent", 4404: "dementia"}
RELOOK = FIX / "relook"
CACHE = ROOT / "web/public/cache/demo"
PRIOR = FIX / "demo_prior.json"
SCENARIOS = FIX / "scenarios"
T0 = datetime.fromisoformat("2026-10-24T20:30:00+00:00")
FLIGHT_MIN = (12, 48)  # the survey flight, minutes after the call (missionTime.ts FLIGHT)
FLIGHT = (T0 + timedelta(minutes=12), T0 + timedelta(minutes=48))
NOW = T0 + timedelta(minutes=90)
FOUND_MIN = 89.5  # the find: the story's last event, before the demo's "now"
MANAGER = "Search manager (scripted for the demo fixture)"
REVIEWER = "Image reviewer (scripted for the demo fixture)"
FAKE = "scripted for the demo fixture: no model was called"
TRAILHEAD = {"lat": 49.373, "lon": -122.949}  # missionTime.ts TRAILHEAD: the lot, the subject's car
BASE_CAMP = {**TRAILHEAD, "name": "Trailhead lot"}  # the base camp (demo_scenario.STAGING[0])
SUBJECT = "adult, red jacket, day hiker"

# The fake VL model's answer per near-miss detection (0.15 to 0.29: the verifier's band), from a
# person looking at the crop in the cache's photo. f0396-d01 is a red car parked under the trees at the
# photo's top edge; f0049-d01 a pale shape in rock; f0423-d01 the photo's edge, nothing in it. f0273-d02
# (two people on a trail under the trees, not in HERIDAL's labels) has the live model's answer instead
# (``RECORDED``).
VL_ANSWERS: dict[str, dict] = {
    "f0396-d01": {"person": "no", "posture": "unknown", "group_size": None, "clothing": None,
                  "reason": "A red car parked under the trees at the photo's edge; nothing shaped like a person"},
    "f0049-d01": {"person": "unclear", "posture": "unknown", "group_size": None, "clothing": None,
                  "reason": "A pale shape among rocks; no head or limbs can be made out"},
    "f0423-d01": {"person": "no", "posture": "unknown", "group_size": None, "clothing": None,
                  "reason": "Bare ground at the photo's edge; nothing shaped like a person"},
}  # fmt: skip


SECOND_LOOK = FIX / "second_look/verdict.json"  # scripts/make_second_look_fixture.py, live model


def recorded_answers() -> dict[str, dict]:
    """The live second look's answer per detection, as ``make_second_look_fixture.py`` recorded it."""
    if not SECOND_LOOK.is_file():
        return {}
    doc = json.loads(SECOND_LOOK.read_text())
    return {doc["detection"]["id"]: {"text": doc["answer"], **doc["model_call"]}}


RECORDED = recorded_answers()

EXTRAS = ROOT / "web/public/cache-extras/distractors"  # the distractor photos and CREDITS.md
DISTRACTOR_FIX = FIX / "distractors"  # scripts/make_distractor_fixture.py: live verdicts
FIRST_EXTRA = (
    501  # distractor photos: f0501, f0502, ... after the cache's 500 (no fleet in a scenario)
)


def slug_of(kind: str) -> str:
    return kind.replace(" ", "-")


def distractor_records() -> dict[str, dict]:
    """The recorded detection and live second look per distractor kind."""
    out = {}
    for p in sorted(DISTRACTOR_FIX.glob("*.json")) if DISTRACTOR_FIX.is_dir() else []:
        doc = json.loads(p.read_text())
        out[doc["kind"]] = doc
    return out


def iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def at(minutes: float) -> datetime:
    return T0 + timedelta(minutes=minutes)


def rle(flags: list[int]) -> list[list[int]]:
    import numpy as np

    from sightline.search.coverage import runs

    return runs(np.asarray(flags, dtype=np.int8))


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
        import sightline.api.exports
        import sightline.api.missions
        import sightline.mission.command
        import sightline.mission.effects
        import sightline.mission.store
        import sightline.search.live

        for mod in (sightline.agent.trace, sightline.agent.loop, sightline.agent.verify,
                    sightline.mission.store, sightline.mission.effects, sightline.api.missions,
                    sightline.mission.command, sightline.api.exports):  # fmt: skip
            mod.now_iso = self.iso_ms  # type: ignore[attr-defined]
        sightline.search.live._now = self.iso_ms  # type: ignore[attr-defined]

    def tick(self, seconds: float = 1.0) -> None:
        """A step forward, so entries made one after another keep their order."""
        self.t += timedelta(seconds=seconds)


def briefing(facts: dict) -> str:
    """The fake briefing model: a few of the facts, word for word, in the radio's order (the agent's
    ``check_briefing`` still checks it; the full facts are in the proposal's reason)."""
    parts = (
        [f"{facts['team']}, Sightline. New assignment: sector {facts['sector']}."]
        if "team" in facts
        else []
    )
    if facts.get("subject"):
        parts.append(f"Look for: {facts['subject']}.")
    if facts.get("daylight_left"):
        parts.append(f"Daylight left: {facts['daylight_left']}.")
    return " ".join([*parts, "Over."]) if parts else ""  # the radio's ending, as the prompt asks


class FakeModels:
    """The scripted VL answers and the briefings above, traced as ``fake/<model>``."""

    def __init__(self) -> None:
        self.next_vl: dict | None = None
        self.recorded: dict | None = None  # a live answer, replayed word for word

    def chat(self, messages: list[dict], *, model: str, **kw: Any) -> Any:
        from sightline.agent.llm import ChatResult, last_user_text
        from sightline.agent.loop import template_briefing

        prompt = last_user_text(messages)
        if "Facts:" in prompt:
            text = briefing(
                json.JSONDecoder().raw_decode(prompt.rsplit("Facts:\n", 1)[1])[0]
            ) or template_briefing({})
        elif self.recorded is not None:
            r = self.recorded
            return ChatResult(r["text"], [], f"recorded/{r['model']}", r["ms"], r["tokens_in"], r["tokens_out"])  # fmt: skip
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


def main(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--scenarios", action="store_true", help="also write the four preset scenarios")
    ap.add_argument(
        "--scenario", action="append", default=[], help="a preset key or a seed (repeatable)"
    )
    ap.add_argument("--only-scenarios", action="store_true", help="skip the story")
    args = ap.parse_args(argv)
    from sightline.search.demo_scenario import PRESETS, preset_seed

    if not (CACHE / "map.json").is_file():
        print(f"no {CACHE}/map.json: run `bash web/scripts/fetch-caches.sh` first")
        return 1
    if not args.only_scenarios:
        run(None)
    seeds = [preset_seed(k) for k in PRESETS] if args.scenarios else []
    seeds += [preset_seed(x) for x in args.scenario]
    for seed in dict.fromkeys(seeds):
        run(seed)
    return 0


def run(seed: int | None) -> None:
    """The story (``seed`` None) or the scenario ``seed`` draws, through the mission API."""
    global T0, FLIGHT, NOW
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
    from sightline.mission.command import likeliest_cell, sector_of
    from sightline.mission.queue import LocalQueue
    from sightline.mission.timeline import timeline as make_timeline
    from sightline.radio.mount import StoreMissionApi
    from sightline.search.demo_scenario import generate
    from sightline.search.prior import koester_prior, prior_source, subject_category
    from sightline.search.sectors import lattice_sectors

    m = MapFile.model_validate_json((CACHE / "map.json").read_text())
    survey = Survey.model_validate_json((CACHE / "survey.json").read_text())
    dets = Detections.model_validate_json((CACHE / "detections.json").read_text())
    scn = None
    if seed is not None:
        from sightline.search.demo_scenario import MIN_ROAD_M, demo_affinity

        # the LKP and the person 300 m or more from a basemap road (the terrain affinity's raster)
        scn = generate(seed, m.grid, [c for f in survey.frames for c in f.footprint],
                       affinity=demo_affinity(m.grid), min_road_distance_m=MIN_ROAD_M,
                       frames=[(f.id, f.pose.lat, f.pose.lon) for f in survey.frames])  # fmt: skip
        T0 = datetime.fromisoformat(scn.call_at)
    else:
        T0 = datetime.fromisoformat("2026-10-24T20:30:00+00:00")
    FLIGHT = (T0 + timedelta(minutes=FLIGHT_MIN[0]), T0 + timedelta(minutes=FLIGHT_MIN[1]))
    NOW = T0 + timedelta(minutes=90)
    # the prior over the whole grid: Koester's rings for the subject's category around the LKP
    # (the cache's own is the uniform placeholder); a scenario's LKP moves, the grid stays
    lkp = scn.lkp if scn else m.lkp
    subject = scn.subject if scn else SUBJECT
    category = scn.category if scn else subject_category(subject)
    pp, pout = koester_prior(m.grid, lkp, category)
    params = m.params.model_copy(update={"prior_source": prior_source(category)})
    base = MapBase(contract_version=CONTRACT_VERSION, grid=m.grid, lkp=lkp, params=params,
                   prior=Distribution(p=[float(x) for x in pp], outside=float(pout)), canopy=m.canopy)  # fmt: skip
    layout = lattice_sectors(m.grid)
    clock = Clock()
    clock.patch()
    import sightline.api.missions

    # no conditions lookup (Tavily): the demo's conditions are the fair-weather fixture, put in below
    sightline.api.missions._fetch_conditions = lambda: None  # type: ignore[attr-defined]
    models = FakeModels()

    tmp = Path(tempfile.mkdtemp(prefix="demo-mission-"))
    store = MissionStore(tmp / "missions")
    ctx = MissionContext(
        store, queue=LocalQueue(), detector_factory=lambda: NoDetector(), hooks=NoHooks()
    )
    # no ctx.start(): no photo is uploaded, and the scheduler (ticks, overdue checks on the real
    # clock) would act at random moments of the run; the script calls the agent itself, in order
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
    camp = scn.base_camp if scn else BASE_CAMP
    mission = call("POST", "/missions", json={
        "name": f"{scn.name} (demo)" if scn else "Mount Seymour (demo)", "area_name": "Mount Seymour",
        "lkp": lkp.model_dump(), "mode": "demo", "last_seen_at": scn.last_seen_at if scn else iso(at(-180)),
        "subject": subject, "base_camp": camp})  # fmt: skip
    mid = mission["mission_id"]
    store.put_map_base(mid, base)
    if scn is not None:
        store.update_mission(mid, scenario_seed=scn.seed)
    for k, d in enumerate(survey.frames):
        store.append_frame(mid, d.model_copy(update={"rank": k + 1}), (CACHE / d.file).read_bytes())
    store.set_frames(mid, survey.frames)
    for fid, ds in dets.frames.items():
        crops = {x.crop: (CACHE / x.crop).read_bytes() for x in ds if x.crop}
        store.append_detections(mid, fid, ds, crops)
    seeded = len(
        store.events(mid)
    )  # the cache's own candidates: in the cache, not the mission's feed
    clock.tick(30)
    if scn is None:
        store.emit(mid, "mission.note", "the subject's car is in the Mount Seymour trailhead lot: the search starts there (where they set off, not a clue on the map)")  # fmt: skip
    else:
        store.emit(mid, "mission.note", f"Demo scenario: {scn.name} (seed {scn.seed}); {scn.prior_source} prior")  # fmt: skip
    here = {"lat": camp["lat"], "lon": camp["lon"]}
    for tid in ("T1", "T2", "T3", "T4"):
        # Teams One and Four are at the base camp; Two and Three check in later (off duty until then)
        status = "off_duty" if tid in ("T2", "T3") else "standby"
        call(
            "PATCH",
            f"/missions/{mid}/teams/{tid}",
            json={"position": here, "position_at": iso(at(1)), "status": status},
        )
    fair = json.loads((ROOT / "tests/geo/fixtures/conditions_clear.json").read_text())["conditions"]

    def conditions(minutes: float) -> Conditions:
        return Conditions.model_validate(
            fair | {"fetched_at": iso(at(minutes)), "sources": ["fixture (demo)"]}
        )

    clock.t = at(5)
    store.put_conditions(
        mid, conditions(5)
    )  # the first lookup; the same fair weather again at 21:30

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
    clue_lake = {
        "kind": "other",
        "text": "hiker at the lot saw a red jacket near the lake around 11:30",
        "d": (0.0004, 0.0021),
        "reliability": "medium",
        "reported_by": "command",
        "source": "form",
    }
    clue_boots = {
        "kind": "track",
        "text": "fresh boot prints heading east off the main trail",
        "d": (0.0010, -0.0008),
        "reliability": "medium",
        "reported_by": "T1",
        "source": "form",  # the search manager types it in from the team's report
    }
    clue_bottle = {
        "kind": "object",
        "text": "blue water bottle by the creek crossing",
        "d": (-0.0013, 0.0009),
        "reliability": "high",
        "reported_by": "T2",
        "source": "radio",
        "confirmed_by_turn": "r0004",
    }
    clue_whistle = {"kind": "sound", "text": "possible whistle, three blasts, to the south-west", "d": (-0.0006, -0.0012),
                    "reliability": "low", "reported_by": "T1", "source": "radio", "confirmed_by_turn": "r0007"}  # fmt: skip
    records = distractor_records() if scn is not None else {}
    for k, d in enumerate(scn.distractors if scn is not None else []):
        if d.kind not in records:
            print(
                f"  no recorded second look for the {d.kind}: run scripts/make_distractor_fixture.py"
            )
            continue
        t = FLIGHT[0] + timedelta(seconds=round(span * order[d.near_frame] / (n - 1)) + 4)
        schedule.append((t, 2, ("distractor", d, FIRST_EXTRA + k)))
        schedule.append((t + timedelta(minutes=3), 2, ("distractor_review", d, FIRST_EXTRA + k)))
    if scn is not None:
        scenario_schedule(scn, later)
        later(60, ("conditions",))
        later(72, ("tick",))
        later(73, ("decide_all",))
        later(73.5, ("checkin", "T2"))
        later(74.5, ("decide_all",))
        later(75.5, ("checkin", "T3"))
        later(76.5, ("decide_all",))
        later(78, ("start_all",))
        later(80, ("finder",))
        later(84, ("position_all",))
        later(88.8, ("found_turn",))
        later(89.2, ("found_position",))
        later(FOUND_MIN, ("found",))
    else:
        story_schedule(later, clue_lake, clue_boots, clue_bottle, clue_whistle)
    schedule.sort(key=lambda x: (x[0], x[1]))
    person: dict = {}  # the find: the scenario's person, or the story's C2 likeliest cell

    def team_of(tid: str) -> Team:
        return next(t for t in store.state(mid)["teams"] if t.id == tid)

    def task_of(sid: str) -> SectorTask:
        return next(t for t in store.state(mid)["tasks"] if t.sector_id == sid)

    def assignment_of(tid: str) -> Proposal:
        return next(
            p
            for p in store.state(mid)["proposals"]
            if p.kind == "assign_sector" and p.target.get("team") == tid
        )

    def sector_point(sid: str, f: tuple[float, float]) -> dict:
        poly = layout.polygon(sid, m.grid)
        lons, lats = [p[0] for p in poly], [p[1] for p in poly]
        return {"lat": round(min(lats) + (max(lats) - min(lats)) * f[0], 6),
                "lon": round(min(lons) + (max(lons) - min(lons)) * f[1], 6)}  # fmt: skip

    def finder() -> tuple[str, str]:
        """(team, sector) for the find: the story's Team One in C2; in a scenario, the team the
        agent sent to the person's sector, else Team Four, assigned there by the search manager."""
        if scn is None:
            return "T1", "C2"
        sid = sector_of(store, mid, scn.person.lat, scn.person.lon) or "C2"
        task = task_of(sid)
        if task.team_id:
            return task.team_id, sid
        return "T4", sid

    reviewed: list[tuple[datetime, str]] = []
    distractors: list[dict] = []
    radio_clues: list[
        dict
    ] = []  # each team report: heard (awaiting), then confirmed by the manager

    def radio_heard(turn: RadioTurn) -> None:
        """A team's report waiting for the search manager: on the event feed and the timeline (the
        team is heard); the manager's confirmation commits it into the trace (``confirm_clue``)."""
        from sightline.mission.command import heard, team_id_for

        tid = team_id_for(store.state(mid)["teams"], turn.callsign or "")
        if tid is not None:
            heard(store, mid, tid, turn.at, None)
        store.emit(mid, "radio.turn", (turn.reply or turn.transcript)[:120], ref=turn.id,
                   data=turn.model_dump(mode="json"))  # fmt: skip

    def draft_of(d: dict) -> dict:
        """The clue body of a fixture clue (``d``: offset from the LKP, or ``lat``/``lon``). A sound
        a team heard is a bearing from the team's position (contract 15.7): the arc's middle is the
        clue's point and its range the distance there, a 30° half-width, from the team out to twice
        that distance (the clue's radius is the range: a sound gives a direction, hardly a distance)."""
        body = {k: v for k, v in d.items() if k not in ("d", "at_lkp", "confirmed_by_turn")}
        if "d" in d:
            body |= {"lat": round(lkp.lat + d["d"][0], 6), "lon": round(lkp.lon + d["d"][1], 6)}
        team = next((t for t in store.state(mid)["teams"] if t.id == d["reported_by"]), None)
        if d["kind"] == "sound" and team is not None and team.position is not None:
            import math

            o = team.position
            dn = (body["lat"] - o.lat) * 110_540.0
            de = (body["lon"] - o.lon) * 111_320.0 * math.cos(math.radians(o.lat))
            body |= {"origin": {"lat": o.lat, "lon": o.lon},
                     "bearing_deg": round(math.degrees(math.atan2(de, dn)) % 360.0, 1),
                     "bearing_spread_deg": 30.0, "range_m": round(math.hypot(de, dn), 1), "radius_m": round(math.hypot(de, dn), 1)}  # fmt: skip
        return body

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
            # a team reports a clue on the radio (typed at the desk: no speech, no model): awaiting the
            # search manager's confirmation, with the clue it would be (contract 15.7); only the
            # manager's action makes it a clue
            rid, callsign, said, readback, d = what[1], what[2], what[3], what[4], what[5]
            radio_heard(RadioTurn(
                id=rid, direction="in", callsign=callsign, transcript=f"{said} (typed for the demo fixture)",
                reply=readback, audio=None, state="awaiting_confirm", actions=["draft clue"], asr_ms=None,
                llm_ms=None, tts_ms=None, at=clock.iso_ms(), draft=draft_of(d)))  # fmt: skip
            radio_clues.append({"turn_id": rid, "team": d["reported_by"], "kind": d["kind"],
                                "text": d["text"], "heard_at": clock.iso_ms()})  # fmt: skip
        elif kind == "event":
            store.emit(mid, what[1], what[2], ref=what[3])
        elif kind == "detection":
            models.next_vl = VL_ANSWERS.get(what[1])
            models.recorded = RECORDED.get(what[1])
            out = loop.handle(
                "detection", store, mid, what[1], client=models, detector=NoDetector()
            )
            for p in out:
                if p.kind == "promote_detection":
                    reviewed.append((clock.t, p.id))
        elif kind == "distractor":
            d, num = what[1], what[2]
            rec = records[d.kind]
            near = next(f for f in survey.frames if f.id == d.near_frame)
            fid = f"f{num:04d}"
            frame = type(near).model_validate(near.model_dump() | {
                "id": fid, "file": f"frames/{fid}.jpg", "flight_index": num - 1, "score": 0.0,
                "rank": num, "n_candidates": 0,
                "width_px": rec["size_px"][0], "height_px": rec["size_px"][1],
                "source": {"image": f"distractor:{slug_of(d.kind)}", "x0": 0, "y0": 0}})  # fmt: skip
            store.append_frame(mid, frame, (EXTRAS / rec["image"]).read_bytes())
            from sightline.contract import Detection

            did = f"{fid}-d01"
            conf = rec["detection"]["conf"]
            crop = f"crops/{did}.jpg" if conf >= loop.CANDIDATE_THRESHOLD else None  # a candidate
            x = Detection(id=did, box_px=tuple(rec["detection"]["box_px"]), conf=conf, crop=crop,
                          lat=d.lat, lon=d.lon, radius_m=10.0)  # fmt: skip
            crops = {crop: (EXTRAS / rec["crop"]).read_bytes()} if crop else {}
            store.append_detections(mid, fid, [x], crops)
            store.emit(
                mid, "photo.processed", f"{fid} processed (distractor: {d.kind}, demo)", ref=fid
            )
            models.next_vl, models.recorded = None, {"text": rec["answer"], **rec["model_call"]}
            out = loop.handle("detection", store, mid, did, client=models, detector=NoDetector())
            models.recorded = None
            verdict = next(v for v in store.state(mid)["verdicts"] if v.detection_id == did)
            distractors.append({
                "kind": d.kind, "frame_id": fid, "near_frame": d.near_frame, "detection_id": did,
                "image": f"cache-extras/distractors/{rec['image']}",
                "crop": f"cache-extras/distractors/{rec['crop']}", "box_px": rec["detection"]["box_px"],
                "conf": conf, "lat": d.lat, "lon": d.lon,
                "trail_m": d.trail_m, "detector": rec["detection"]["note"],
                "verdict_id": verdict.id, "person": verdict.person, "object": verdict.object,
                "reason": verdict.reason, "model": verdict.model,
                "promoted": [p.id for p in out if p.kind == "promote_detection"],
                "review": d.review, "review_object": d.object, "clue": None,
                "credit": rec["credit"]})  # fmt: skip
        elif kind == "distractor_review":
            d, num = what[1], what[2]
            did = f"f{num:04d}-d01"
            for p in store.state(mid)["proposals"]:
                if (
                    p.kind == "promote_detection"
                    and p.target.get("detection") == did
                    and p.status == "pending"
                ):
                    call("POST", f"/missions/{mid}/proposals/{p.id}/decide",
                         json={"decision": "approve", "by": REVIEWER, "reason": None})  # fmt: skip
                    reviewed[:] = [(w, q) for w, q in reviewed if q != p.id]
                    clock.tick()
            body = {"detection_id": did, "answer": d.review, "object": d.object, "by": REVIEWER}
            call("POST", f"/missions/{mid}/reviews", json=body)
            entry = next(x for x in distractors if x["detection_id"] == did)
            clue = next((c for c in store.state(mid)["clues"] if c.detection_id == did), None)
            if clue is not None:
                entry["clue"] = clue.id
                loop.handle("clue", store, mid, clue.id, client=models)
        elif kind == "clue":
            d = what[1]
            if d["source"] == "radio":  # the manager confirms the team's radio report (15.7)
                rid = d["confirmed_by_turn"]
                clue = call(
                    "POST", f"/missions/{mid}/turns/{rid}/confirm_clue", json={"by": MANAGER}
                )
                rc = next(x for x in radio_clues if x["turn_id"] == rid)
                rc |= {"clue": clue["id"], "confirmed_at": clock.iso_ms(), "confirmed_by": MANAGER}
            else:
                clue = call("POST", f"/missions/{mid}/clues", json=draft_of(d))
            loop.handle("clue", store, mid, clue["id"], client=models)
        elif kind == "task":
            sid, body, note = what[1], what[2], what[3]
            call("POST", f"/missions/{mid}/tasks/{sid}", json=body)
            if note:
                clock.tick()
                store.emit(mid, "mission.note", note, ref=sid)
        elif kind == "assign":  # the search manager's direct action (1.3)
            call("POST", f"/missions/{mid}/teams/{what[1]}/assign",
                 json={"sector": what[2], "reason": what[3], "by": MANAGER})  # fmt: skip
        elif kind == "call":  # the desk calls a team (1.3)
            call(
                "POST",
                f"/missions/{mid}/teams/{what[1]}/call",
                json={"text": what[2], "by": MANAGER},
            )
        elif kind == "sighted":  # a scenario's clue as it is reported
            c = what[1]
            body = {"kind": c.kind, "text": c.text, "lat": c.lat, "lon": c.lon,
                    "reliability": c.reliability, "reported_by": c.reported_by}  # fmt: skip
            if c.reported_by.startswith("T"):
                # a team's report: a radio turn awaiting the manager, confirmed half a minute later
                rid = f"r{9000 + int(c.minutes * 10):05d}"
                callsign = team_of(c.reported_by).callsign
                d = {**body, "source": "radio", "confirmed_by_turn": rid, "at_lkp": False}
                radio_heard(RadioTurn(
                    id=rid, direction="in", callsign=c.reported_by,
                    transcript=f"Sightline, {callsign}. {c.text[:1].upper()}{c.text[1:]}, over. (typed for the demo fixture)",
                    reply=f"{callsign}, Sightline. Copy {c.kind}, {c.text}. Holding it for the search manager to confirm, over.", audio=None,
                    state="awaiting_confirm", actions=["draft clue"], asr_ms=None, llm_ms=None, tts_ms=None,
                    at=clock.iso_ms(), draft=draft_of(d)))  # fmt: skip
                radio_clues.append({"turn_id": rid, "team": c.reported_by, "kind": c.kind,
                                    "text": c.text, "heard_at": clock.iso_ms()})  # fmt: skip
                schedule.append((clock.t + timedelta(seconds=30), 1, ("clue", d)))
                schedule.sort(key=lambda x: (x[0], x[1]))
            else:
                clue = call("POST", f"/missions/{mid}/clues", json=body | {"source": "form"})
                loop.handle("clue", store, mid, clue["id"], client=models)
        elif kind == "decide_all":
            for p in store.state(mid)["proposals"]:
                if p.kind == "assign_sector" and p.status == "pending":
                    call("POST", f"/missions/{mid}/proposals/{p.id}/decide",
                         json={"decision": "approve", "by": MANAGER, "reason": None})  # fmt: skip
                    clock.tick()
        elif kind == "start_all":
            for task in store.state(mid)["tasks"]:
                if task.state == "assigned" and task.team_id:
                    call("POST", f"/missions/{mid}/tasks/{task.sector_id}",
                         json={"state": "in_progress", "team_id": task.team_id})  # fmt: skip
                    call(
                        "PATCH",
                        f"/missions/{mid}/teams/{task.team_id}",
                        json={"status": "searching"},
                    )
        elif kind == "finder":
            team, sid = finder()
            if task_of(sid).team_id is None:
                call("POST", f"/missions/{mid}/teams/{team}/assign", json={
                    "sector": sid, "by": MANAGER,
                    "reason": "the clues lead there and no team has it (scripted for the demo fixture)"})  # fmt: skip
                clock.tick()
                call(
                    "POST",
                    f"/missions/{mid}/tasks/{sid}",
                    json={"state": "in_progress", "team_id": team},
                )
                call("PATCH", f"/missions/{mid}/teams/{team}", json={"status": "searching"})
        elif kind == "position_all":
            for task in store.state(mid)["tasks"]:
                if task.state == "in_progress" and task.team_id:
                    call("PATCH", f"/missions/{mid}/teams/{task.team_id}",
                         json={"position": sector_point(task.sector_id, (0.5, 0.5)), "position_at": clock.iso_ms()})  # fmt: skip
                    clock.tick()
        elif kind == "found_turn":
            team, sid = finder()
            callsign = team_of(team).callsign
            words = " ".join(w.capitalize() for w in sector_label(sid).split())
            radio.record_turn(mid, RadioTurn(
                id="r0010" if scn is None else "r9999", direction="in", callsign=team,
                transcript=f"Sightline, {callsign}. Subject located in {words}, conscious and talking, over. (typed for the demo fixture)",
                reply=f"{callsign}, Sightline. Copy subject located in {words}. Stay with the subject, over.",
                audio=None, state="answered", actions=[], asr_ms=None, llm_ms=None, tts_ms=None,
                at=clock.iso_ms()))  # fmt: skip
        elif kind == "found_position":
            team, sid = finder()
            if scn is not None:
                person.update(scn.person.model_dump())
            else:
                person.update(likeliest_cell(store, mid, sid).model_dump())
            call("PATCH", f"/missions/{mid}/teams/{team}",
                 json={"position": {k: round(v, 6) for k, v in person.items()}, "position_at": clock.iso_ms()})  # fmt: skip
        elif kind == "found":
            team, sid = finder()
            call("POST", f"/missions/{mid}/found", json={"team": team, "sector": sid,
                 "lat": round(person["lat"], 6), "lon": round(person["lon"], 6), "by": MANAGER})  # fmt: skip
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
            call(
                "POST", f"/missions/{mid}/tasks/{sid}", json={"state": what[2], "team_id": what[1]}
            )
            call("PATCH", f"/missions/{mid}/teams/{what[1]}", json={"status": "searching"})
        elif kind == "searched":  # the search manager marks it, with the team's POD (1.3)
            sid, pod, note = what[1], what[2], what[3]
            call("POST", f"/missions/{mid}/sectors/{sid}/searched",
                 json={"pod": pod, "team": "T4", "note": note, "by": MANAGER})  # fmt: skip
            loop.handle("task_searched", store, mid, sid, client=models)
        elif kind == "place":
            call(
                "PATCH",
                f"/missions/{mid}/teams/{what[1]}",
                json={"position": sector_point(what[2], what[3]), "position_at": clock.iso_ms()},
            )
        elif kind == "position":
            sid = assignment_of(what[1]).target["sector"]
            f = {"T1": (0.55, 0.35), "T2": (0.4, 0.6), "T3": (0.85, 0.5)}[what[1]]
            call(
                "PATCH",
                f"/missions/{mid}/teams/{what[1]}",
                json={"position": sector_point(sid, f), "position_at": clock.iso_ms()},
            )
        # the image reviewer decides each promotion three minutes after it is made; the last stays pending
        for when, pid in list(reviewed):
            if clock.t >= when + timedelta(minutes=3) and pid != reviewed[-1][1]:
                clock.tick()
                call(
                    "POST",
                    f"/missions/{mid}/proposals/{pid}/decide",
                    json={"decision": "approve", "by": REVIEWER, "reason": None},
                )
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
    events = [
        e
        for e in store.events(mid)[seeded:]
        if not (e.type == "map.updated" and e.data and e.data.get("source") == "frame")
    ]
    # the creation's own events (mission.note, the 16 proposed tasks) happened before the cache seeding
    events = [
        e for e in store.events(mid)[:seeded] if e.type in ("mission.note", "task.updated")
    ] + events
    trace = store.trace_entries(mid)
    slug = "demo" if scn is None else f"demo-{seed}"
    mission_out = Mission.model_validate({**state["mission"].model_dump(), "mission_id": slug})
    proposals = state["proposals"]

    # the second look's images, for the demo's Trace view and inbox (the store's relook/ folder)
    if scn is None:
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
        # 1.3: the cells a photo has looked at (run-length [value, count], row-major): a veil flag,
        # never a limit on the probability, which covers the whole grid (demo_prior.json)
        "photographed": rle([int(i in stepped) for i in range(m.grid.rows * m.grid.cols)]),
        "timeline": [],
        # 15.7: each clue a team reported on the radio, heard (awaiting) then confirmed by the manager
        "radio_clues": radio_clues,
    }
    if scn is not None:
        doc |= {"scenario": scn.public(), "t0": iso(T0), "flight": [iso(FLIGHT[0]), iso(FLIGHT[1])],
                "prior": prior_doc(base, category), "distractors": distractors}  # fmt: skip
    out_events = []
    renumbered = {u.seq: v.seq for u, v in zip(rest, map_updates, strict=True)}
    for seen_ids, e in enumerate(sorted(events, key=lambda e: e.at), 1):
        patch: dict[str, Any] = {"id": f"e{seen_ids:05d}"}
        if e.data and e.data.get("mission_id") == mid:  # the run's random id: the fixture's own
            patch["data"] = {**e.data, "mission_id": slug}
        if e.type == "map.updated" and e.data:
            # the update itself is in map_updates (renumbered after the cache's frames): one copy
            seq = renumbered[e.data["seq"]]
            patch |= {"data": None, "summary": f"map update {seq} ({e.data['source']})"}
        e = MissionEvent.model_validate({**e.model_dump(), **patch})
        out_events.append(e.model_dump(mode="json"))
    doc["events"] = out_events
    where = lambda lat, lon: sector_of(store, mid, lat, lon)
    doc["timeline"] = [
        x.model_dump(mode="json")
        for x in make_timeline(
            [MissionEvent.model_validate(e) for e in out_events], state["teams"], where
        )
    ]
    from sightline.radio.voices import attach_audio

    voice_slug = "demo" if scn is None else PRESET_SLUG.get(seed, f"seed-{seed}")
    attach_audio(doc["timeline"], voice_slug, ROOT / "web/public")
    # the after-action report as the server builds it (last seen, every sector's final POD, the legs;
    # the story's legs are added by make_fleet_fixture.py), the run's mission id as the fixture's
    from sightline.mission.report import build as build_report

    doc["report"] = json.loads(json.dumps(build_report(store, mid, iso(NOW))).replace(mid, slug))
    text = json.dumps(doc, indent=1, ensure_ascii=False)
    trace_text = "".join(
        TraceEntry.model_validate(x.model_dump()).model_dump_json() + "\n" for x in trace
    )
    for name, body in (("fixture", text), ("trace", trace_text)):
        assert not re.search(r"\bclear(s|ed|ing)?\b", body, re.IGNORECASE), f"the {name} says clear"
    assert state["mission"].status == "found", "the story must end found"
    shutil.rmtree(tmp, ignore_errors=True)
    if scn is not None:
        SCENARIOS.mkdir(parents=True, exist_ok=True)
        out = SCENARIOS / f"{PRESET_SLUG.get(seed, f'seed-{seed}')}.json"
        out.write_text(text + "\n")
        print(f"wrote {out.relative_to(ROOT)}: {scn.name}, seed {seed}, {len(state['clues'])} clues, "
              f"found by {state['mission'].found.team} in {state['mission'].found.sector}")  # fmt: skip
        return
    OUT.write_text(text + "\n")
    TRACE.write_text(trace_text)
    PRIOR.write_text(json.dumps(prior_doc(base, category), separators=(",", ":")) + "\n")

    print(f"wrote {OUT.relative_to(ROOT)}: {len(state['tasks'])} tasks, {len(state['clues'])} clues, "
          f"{len(proposals)} proposals, {len(out_events)} events, {len(map_updates)} map updates after the frames")  # fmt: skip
    print(
        f"wrote {TRACE.relative_to(ROOT)}: {len(trace)} entries; {len(list(RELOOK.glob('*.jpg')))} re-look images"
    )
    for p in proposals:
        print(f"  {p.id} {p.kind} {p.status:<8} {p.summary}\n      {p.reason}")
    print(
        "sectors by POA:",
        [
            (x["sector_id"], round(x["poa"] * 100, 1))
            for x in sorted(sectors, key=lambda x: -x["poa"])
        ],
    )


def prior_doc(base: Any, category: str | None) -> dict:
    """The map base's prior for the web (4 significant figures a cell; ``outside`` keeps the sum 1),
    and where its ``outside`` comes from (``prior_mass_outside``: the 1 km grid is smaller than the
    category's outer rings, so most of the rings' mass lies past its edge, reported, not dropped)."""
    from sightline.search.prior import prior_mass_outside

    p = [float(f"{x:.4g}") for x in base.prior.p]
    parts = prior_mass_outside(base.grid, base.lkp, category)
    return {
        "note": "Generated by scripts/make_command_fixtures.py: the demo map's prior over the whole grid, "
        "row-major like map.json's prior.p; the cache's map.json carries the uniform placeholder instead.",
        "prior_source": base.params.prior_source,
        "lkp": base.lkp.model_dump(),
        "p": p,
        "outside": max(0.0, 1.0 - sum(p)),
        "prior_mass_outside": {k: round(v, 4) for k, v in parts.items()},
    }


def story_schedule(
    later: Any, clue_lake: dict, clue_boots: dict, clue_bottle: dict, clue_whistle: dict
) -> None:
    """The story's own afternoon (the clues, the manager's moves, the radio), around the shared ones."""
    later(40, ("clue", clue_lake))
    later(50, ("assign", "T4", "C4", "hasty search of the trail through C4"))
    later(51, ("task", "C4", {"state": "in_progress", "team_id": "T4"}, None))
    later(51.2, ("team", "T4", {"status": "searching"}))
    # Team One hears the whistle from the top of C2 (a hasty look up the trail), to its south-west:
    # a sound is a bearing from where the team stood (contract 15.7)
    later(
        69.5,
        (
            "team",
            "T1",
            {"position": {"lat": 49.3719, "lon": -122.9422}, "position_at": iso(at(69.5))},
        ),
    )
    later(56, ("place", "T4", "C4", (0.45, 0.4)))
    later(82, ("place", "T4", "B4", (0.3, 0.55)))
    later(66, ("clue", clue_boots))
    later(67.8, ("turn", "r0004", "Team Two",
                 "Sightline, Team Two. Blue water bottle by the creek crossing, over.",
                 "Team Two, Sightline. Copy a blue water bottle by the creek crossing. Holding it for the search manager to confirm, over.",
                 clue_bottle))  # fmt: skip
    later(68, ("clue", clue_bottle))
    later(69.8, ("turn", "r0007", "Team One",
                 "Sightline, Team One. Possible whistle, three blasts, to the south-west, over.",
                 "Team One, Sightline. Copy a possible whistle, three blasts, south-west, low reliability. Holding it for the search manager to confirm, over.",
                 clue_whistle))  # fmt: skip
    later(70, ("clue", clue_whistle))
    later(60, ("conditions",))
    later(
        72, ("tick",)
    )  # 21:42, Where next: the planner on the map with the clues (Team One on standby)
    later(73, ("decide", "T1", "approve", None))
    later(73.5, ("checkin", "T2"))  # Team Two checks in at the lot: its next sector
    later(75, ("decide", "T2", "approve", None))
    later(75.5, ("checkin", "T3"))
    later(77, ("decide", "T3", "approve", None))
    later(78, ("task_team", "T1", "in_progress"))
    later(80, ("searched", "C4", 0.4, "steep; the gully not entered"))
    later(80.5, ("assign", "T4", "B4", None))
    later(81, ("task_team", "T2", "in_progress"))
    later(81.5, ("task", "B4", {"state": "in_progress", "team_id": "T4"}, None))
    later(86, ("searched", "B4", 0.6, "trail and both ditches, thick salal on the east side"))
    later(86.5, ("team", "T4", {"status": "standby"}))
    later(85, ("position", "T1"))
    later(88, ("position", "T2"))
    later(84, ("position", "T3"))
    later(79, ("call", "T3", "Team Three, Sightline. Report when you reach the creek, over."))
    later(88.8, ("found_turn",))
    later(89.2, ("found_position",))
    later(FOUND_MIN, ("found",))


def scenario_schedule(scn: Any, later: Any) -> None:
    """A scenario's clues at their times (the rest of its afternoon is shared with the story)."""
    for c in scn.clues:
        later(c.minutes, ("sighted", c))


if __name__ == "__main__":
    raise SystemExit(main())
