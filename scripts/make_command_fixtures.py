"""The command view's demo mission (LANE_E §7 E-04): fixtures so the Vercel site, which has no API,
can show the command view (`#m/demo/command`).

    bash web/scripts/fetch-caches.sh          # once: the demo cache
    uv run python scripts/make_command_fixtures.py

Writes ``web/src/command/__fixtures__/demo_mission.json``: the mission, 4 teams, 8 sector tasks across
every state, 5 clues (2 by radio, 3 from the form), 6 proposals (2 pending, with real crops from the
demo cache), a conversation of events, fair-weather conditions, and the 16 lattice sectors with the POA
and drone coverage of the demo map after its flight (``LiveMap`` over the cache's real steps). Every
object is validated against the contract. The map itself is read in the browser from
``/cache/demo/map.json``. Everything here is a demo: labelled so on screen.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "web/src/command/__fixtures__/demo_mission.json"
MAP = ROOT / "web/public/cache/demo/map.json"
T0 = datetime.fromisoformat("2026-10-24T20:30:00+00:00")


def at(minutes: float) -> str:
    return (T0 + timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")


def main() -> int:
    from sightline.contract import (
        CONTRACT_VERSION,
        Clue,
        Conditions,
        Distribution,
        MapBase,
        MapFile,
        MapUpdate,
        Mission,
        MissionEvent,
        Proposal,
        SectorTask,
        Team,
    )
    from sightline.geo.cards import sector_label
    from sightline.search.live import LiveMap
    from sightline.search.sectors import lattice_sectors

    if not MAP.is_file():
        print(f"no {MAP}: run `bash web/scripts/fetch-caches.sh` first")
        return 1
    m = MapFile.model_validate_json(MAP.read_text())
    base = MapBase(contract_version=CONTRACT_VERSION, grid=m.grid, lkp=m.lkp, params=m.params,
                   prior=Distribution(p=m.prior.p, outside=m.prior.outside), canopy=m.canopy)  # fmt: skip
    live = LiveMap.from_base(base)
    stepped: set[int] = set()
    for k, s in enumerate(m.steps):
        live.apply(
            MapUpdate(
                seq=k + 1,
                kind="step",
                source="frame",
                ref=s.frame_id,
                cells=s.cells,
                at=at(k * 0.1),
            )
        )
        stepped.update(i for i, _ in s.cells)
    layout = lattice_sectors(m.grid)
    first = live.sector_poa(layout)
    top = sorted(first, key=lambda sid: (-first[sid], sid))  # by POA after the flight
    # the two sectors the ground teams have searched (POD 60 % and 40 %) step the map like a live mission
    ground = []
    for k, (sid, pod) in enumerate(((top[5], 0.6), (top[7], 0.4))):
        cells = [(int(i), pod) for i in layout.cells_of(sid)]
        ground.append(
            MapUpdate(
                seq=len(m.steps) + k + 1,
                kind="step",
                source="ground",
                ref=sid,
                cells=cells,
                at=at(62 + 8 * k),
            )
        )
        live.apply(
            MapUpdate(
                seq=len(m.steps) + k + 1,
                kind="step",
                source="ground",
                ref=sid,
                cells=cells,
                at=at(62 + 8 * k),
            )
        )
    poa = live.sector_poa(layout)
    sectors = []
    for s in layout.sectors:
        cells = layout.cells_of(s.id)
        sectors.append({
            "sector_id": s.id, "label": sector_label(s.id), "poa": round(poa[s.id], 4),
            "drone_coverage": round(sum(int(i) in stepped for i in cells) / len(cells), 3),
            "polygon": [list(c) for c in layout.polygon(s.id, m.grid)],
        })  # fmt: skip
    by_poa = sorted(sectors, key=lambda x: -x["poa"])

    mission = Mission(contract_version=CONTRACT_VERSION, mission_id="demo", name="Mount Seymour (demo)",
                      area={"name": "Mount Seymour", "lkp": m.lkp.model_dump()}, created_at=at(0), mode="demo",
                      last_seen_at=at(-180), subject="adult, red jacket, day hiker")  # fmt: skip

    def team(
        i: int, name: str, status: str, pos: tuple[float, float] | None, seen: float | None
    ) -> Team:
        p = None if pos is None else {"lat": m.lkp.lat + pos[0], "lon": m.lkp.lon + pos[1]}
        return Team(id=f"T{i}", callsign=f"Team {name}", members=3, status=status, position=p,
                    position_at=None if seen is None else at(seen), note=None)  # fmt: skip

    teams = [
        team(1, "One", "searching", (0.0012, -0.0015), 85),
        team(2, "Two", "searching", (-0.0016, 0.0011), 88),
        team(3, "Three", "assigned", (0.0002, 0.0001), 80),
        team(4, "Four", "standby", None, None),
    ]
    sp = {x["sector_id"]: x["poa"] for x in sectors}

    def task(
        sid: str, state: str, team_id: str | None, pod: float | None, note: str | None, t: float
    ) -> SectorTask:
        return SectorTask(
            sector_id=sid,
            state=state,
            team_id=team_id,
            poa=sp[sid],
            pod=pod,
            note=note,
            updated_at=at(t),
        )

    # 8 tasks across the states: searched (2), in progress (2), assigned (1), proposed (3)
    tasks = [
        task(
            top[5],
            "searched",
            None,
            0.6,
            "trail and both ditches, thick salal on the east side",
            62,
        ),
        task(top[7], "searched", None, 0.4, "steep; the gully not entered", 70),
        task(top[0], "in_progress", "T1", None, None, 75),
        task(top[2], "in_progress", "T2", None, None, 78),
        task(top[1], "assigned", "T3", None, None, 82),
        task(top[3], "proposed", None, None, None, 0),
        task(top[4], "proposed", None, None, None, 0),
        task(top[6], "proposed", None, None, None, 0),
    ]

    def clue(
        i: int,
        kind: str,
        text: str,
        d: tuple[float, float],
        by: str,
        src: str,
        rel: str,
        t: float,
        turn: str | None = None,
    ) -> Clue:
        return Clue(id=f"c00{i}", kind=kind, text=text, lat=m.lkp.lat + d[0], lon=m.lkp.lon + d[1], at_team_position=False,
                    radius_m={"object": 30.0, "track": 75.0, "sighting": 100.0, "sound": 200.0, "other": 75.0}[kind],
                    reliability=rel, reported_by=by, source=src, confirmed_by_turn=turn, at=at(t), confirmed=True)  # fmt: skip

    clues = [
        clue(
            1,
            "other",
            "car at the Mount Seymour trailhead, last seen 18:00",
            (0.0030, -0.0040),
            "command",
            "form",
            "high",
            2,
        ),
        clue(
            2,
            "track",
            "fresh boot prints heading east off the main trail",
            (0.0010, -0.0008),
            "T1",
            "form",
            "medium",
            66,
        ),
        clue(
            3,
            "object",
            "blue water bottle by the creek crossing",
            (-0.0013, 0.0009),
            "T2",
            "radio",
            "high",
            84,
            "r0004",
        ),
        clue(
            4,
            "sound",
            "possible whistle, three blasts, to the south-west",
            (-0.0006, -0.0012),
            "T1",
            "radio",
            "low",
            87,
            "r0007",
        ),
        clue(
            5,
            "other",
            "hiker at the lot saw a red jacket near the lake around 15:30",
            (0.0004, 0.0021),
            "command",
            "form",
            "medium",
            40,
        ),
    ]

    def prop(
        i: int,
        kind: str,
        summary: str,
        reason: str,
        target: dict,
        ev: list[dict],
        status: str,
        by: str,
        t: float,
        briefing: str | None = None,
        decided: tuple[str, float, str | None] | None = None,
    ) -> Proposal:
        return Proposal(id=f"p00{i}", kind=kind, summary=summary, reason=reason, briefing=briefing, target=target,
                        evidence=ev, status=status, created_by=by, created_at=at(t),
                        decided_at=None if not decided else at(decided[1]), decided_by=None if not decided else decided[0],
                        decision_reason=None if not decided else decided[2], edits=None)  # fmt: skip

    crop = lambda d, cap: {"kind": "crop", "ref": f"crops/{d}.jpg", "caption": cap}
    proposals = [
        prop(
            1,
            "assign_sector",
            f"Assign sector {top[0]} to Team One",
            f"{top[0]} holds {sp[top[0]]:.1%} of the probability, tied for the most: no drone photo covers it yet. Team One is the nearest team on standby.",
            {"team": "T1", "sector": top[0]},
            [],
            "approved",
            "planner",
            72,
            f"Team One, Sightline. New assignment: sector {top[0]}. Enter from the north edge. Look for an adult in a red jacket.",
            ("Search manager", 73, None),
        ),
        prop(
            2,
            "assign_sector",
            f"Assign sector {top[1]} to Team Three",
            f"{top[1]} holds {sp[top[1]]:.1%}, tied for the most; no drone photo covers it yet.",
            {"team": "T3", "sector": top[1]},
            [],
            "approved",
            "planner",
            79,
            None,
            ("Search manager", 81, None),
        ),
        prop(
            3,
            "dismiss_detection",
            "Dismiss f0273-d01 (a rock)",
            "Second look: a light-coloured rock with a shadow; no limbs or clothing.",
            {"detection": "f0273-d01"},
            [crop("f0273-d01", "detector 0.42; second look: rock")],
            "rejected",
            "verifier",
            64,
            None,
            ("Image reviewer", 65, "Keep it for a person to look at"),
        ),
        prop(
            4,
            "promote_detection",
            "Promote f0127-d01 to the review queue",
            "Second look: a person sitting, red top, on the edge of the trail (detector 0.80).",
            {"detection": "f0127-d01"},
            [crop("f0127-d01", "detector 0.80; second look: person, sitting, red top")],
            "pending",
            "verifier",
            89,
        ),
        prop(
            5,
            "alert",
            "Alert all teams: possible whistle to the south-west",
            "Team One reported three whistle blasts (low reliability) toward the south-west; nothing confirmed.",
            {"to": "all"},
            [{"kind": "clue", "ref": "c004", "caption": "possible whistle"}],
            "pending",
            "agent",
            88,
            "All teams, Sightline. Team One heard what may be three whistle blasts to the south-west. Listen for it on your sweeps.",
        ),
        prop(
            6,
            "promote_detection",
            "Promote f0336-d01 to the review queue",
            "Second look: unclear, a dark shape under trees (detector 0.82).",
            {"detection": "f0336-d01"},
            [crop("f0336-d01", "detector 0.82; second look: unclear")],
            "approved",
            "verifier",
            58,
            None,
            ("Image reviewer", 60, None),
        ),
    ]

    c = json.loads((ROOT / "tests/geo/fixtures/conditions_clear.json").read_text())["conditions"]
    c |= {"fetched_at": at(80), "sources": ["fixture (demo)"]}
    conditions = Conditions.model_validate(c)

    raw = [
        (0, "mission.note", "mission created: Mount Seymour (demo)", None),
        (2, "clue.added", "other: car at the Mount Seymour trailhead, last seen 18:00", "c001"),
        (5, "conditions.updated", "conditions for Mount Seymour", None),
        (12, "photo.processed", "f0001 processed (the flight starts)", "f0001"),
        (
            40,
            "clue.added",
            "other: hiker at the lot saw a red jacket near the lake around 15:30",
            "c005",
        ),
        (48, "photo.processed", "f0500 processed (the flight ends)", "f0500"),
        (58, "proposal.new", "Promote f0336-d01 to the review queue", "p006"),
        (60, "proposal.decided", "p006 approved by Image reviewer", "p006"),
        (62, "task.updated", f"sector {top[5]}: searched at POD 60 %", top[5]),
        (64, "proposal.new", "Dismiss f0273-d01 (a rock)", "p003"),
        (65, "proposal.decided", "p003 rejected by Image reviewer", "p003"),
        (66, "clue.added", "track: fresh boot prints heading east off the main trail", "c002"),
        (66.5, "map.updated", "map update (clue)", "c002"),
        (70, "task.updated", f"sector {top[7]}: searched at POD 40 %", top[7]),
        (72, "proposal.new", f"Assign sector {top[0]} to Team One", "p001"),
        (73, "proposal.decided", "p001 approved by Search manager", "p001"),
        (74, "radio.turn", f"Team One, Sightline. New assignment: sector {top[0]}.", "r0002"),
        (75, "task.updated", f"sector {top[0]}: in progress", top[0]),
        (78, "task.updated", f"sector {top[2]}: in progress", top[2]),
        (79, "proposal.new", f"Assign sector {top[1]} to Team Three", "p002"),
        (80, "conditions.updated", "conditions for Mount Seymour", None),
        (81, "proposal.decided", "p002 approved by Search manager", "p002"),
        (82, "task.updated", f"sector {top[1]}: assigned", top[1]),
        (
            84,
            "radio.turn",
            "Team Two: blue water bottle by the creek crossing (read back and confirmed)",
            "r0004",
        ),
        (84.2, "clue.added", "object: blue water bottle by the creek crossing", "c003"),
        (85, "team.updated", "Team One: position", "T1"),
        (
            87,
            "radio.turn",
            "Team One: possible whistle, three blasts, south-west (confirmed)",
            "r0007",
        ),
        (87.2, "clue.added", "sound: possible whistle, three blasts, to the south-west", "c004"),
        (88, "proposal.new", "Alert all teams: possible whistle to the south-west", "p005"),
        (89, "proposal.new", "Promote f0127-d01 to the review queue", "p004"),
    ]
    events = [MissionEvent(id=f"e{k + 1:05d}", type=t, at=at(mn), summary=s, ref=r, data=None)
              for k, (mn, t, s, r) in enumerate(raw)]  # fmt: skip

    doc = {
        "note": "Generated by scripts/make_command_fixtures.py from the demo cache; do not edit by hand. A demo.",
        "now": at(90),
        "mission": mission.model_dump(mode="json"),
        "teams": [x.model_dump(mode="json") for x in teams],
        "tasks": [x.model_dump(mode="json") for x in tasks],
        "clues": [x.model_dump(mode="json") for x in clues],
        "proposals": [x.model_dump(mode="json") for x in proposals],
        "conditions": conditions.model_dump(mode="json"),
        "events": [x.model_dump(mode="json") for x in events],
        "sectors": sectors,
        # after the cache's frame steps (seq 1..N, built in the browser from map.json)
        "ground_updates": [u.model_dump(mode="json") for u in ground],
    }
    text = json.dumps(doc, indent=1, ensure_ascii=False)
    import re

    assert not re.search(r"\bclear(s|ed|ing)?\b", text, re.IGNORECASE), "a fixture says clear"
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(text + "\n")
    print(
        f"wrote {OUT.relative_to(ROOT)}: {len(tasks)} tasks, {len(clues)} clues, {len(proposals)} proposals, {len(events)} events"
    )
    print("sectors by POA:", [(x["sector_id"], x["poa"], x["drone_coverage"]) for x in by_poa[:8]])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
