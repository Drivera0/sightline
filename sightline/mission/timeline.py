"""The mission's one timeline (contract §15, v1.3): every mission event a command post reads, as
``TimelineEntry`` lines of seven kinds: ``radio`` (a team's turn as transcribed, and the desk's
reply or call), ``clue``, ``detection`` (candidates, promotions, second looks), ``decision`` (an
approval or rejection of a proposal, or a direct action), ``checkin`` (position reports, relays,
overdue and back in contact), ``drone`` (legs approved, started and done, links, recalls, battery)
and ``found``.

Derived, never stored: the event log (``events.jsonl``) is the record. ``GET /missions/{id}/events``
returns the list as JSON; the SSE stream sends each line as a ``timeline`` event after the event it
comes from (same id). ``entries`` and ``timeline`` are pure; ``for_store`` reads the mission.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable
from typing import Any

from sightline.contract import MissionEvent, TimelineEntry

SectorOf = Callable[[float, float], str | None]
_DRONE = re.compile(r"^D\d+$")


def _team(teams: Iterable[Any], who: str | None) -> str | None:
    if not who:
        return None
    w = who.strip().lower()
    for t in teams:
        tid, callsign = (t["id"], t["callsign"]) if isinstance(t, dict) else (t.id, t.callsign)
        if w in (tid.lower(), callsign.lower()):
            return tid
    return None


def _sector(sector_of: SectorOf | None, d: dict) -> str | None:
    if sector_of is None or d.get("lat") is None or d.get("lon") is None:
        return None
    try:
        return sector_of(d["lat"], d["lon"])
    except (ValueError, KeyError):  # a point the map can't place has no sector
        return None


def entries(
    ev: MissionEvent, teams: Iterable[Any] = (), sector_of: SectorOf | None = None
) -> list[TimelineEntry]:
    """The timeline lines one event makes (none for most: map steps, task and team saves...)."""
    teams = list(teams)
    d: dict = ev.data or {}

    def line(kind: str, text: str, **kw: Any) -> TimelineEntry:
        return TimelineEntry(id=kw.pop("id", ev.id), at=kw.pop("at", ev.at), kind=kind,  # type: ignore[arg-type]
                             text=text, **kw)  # fmt: skip

    if ev.type == "radio.turn":
        tid = _team(teams, d.get("callsign")) or d.get("callsign")
        turn = d.get("id") or ev.ref
        at = d.get("at") or ev.at  # when it was said, not when it was recorded
        out: list[TimelineEntry] = []
        if d.get("direction") == "in":
            if (d.get("transcript") or "").strip():
                out.append(line("radio", d["transcript"].strip(), at=at, team=tid, refs=[turn],
                                turn_id=turn, direction="in"))  # fmt: skip
            if d.get("reply"):
                out.append(line("radio", d["reply"], id=f"{ev.id}-reply", at=at, team=tid, refs=[turn],
                                turn_id=turn, direction="out"))  # fmt: skip
        elif d.get("reply"):
            out.append(
                line("radio", d["reply"], team=tid, refs=[turn], turn_id=turn, direction="out")
            )
        return out
    if ev.type == "clue.added":
        return [line("clue", f"{d.get('kind', 'clue')}: {d.get('text', ev.summary)}",
                     team=_team(teams, d.get("reported_by")), sector=_sector(sector_of, d),
                     refs=[r for r in (ev.ref,) if r])]  # fmt: skip
    if ev.type == "detection.new":
        return [line("detection", ev.summary, sector=_sector(sector_of, d),
                     refs=[r for r in (ev.ref, d.get("promoted_by")) if r])]  # fmt: skip
    if ev.type == "verdict":
        return [line("detection", ev.summary, refs=[r for r in (ev.ref, d.get("id")) if r])]
    if ev.type == "proposal.decided":
        if d.get("status") not in ("approved", "rejected"):
            return []  # superseded or expired: no one decided
        target = d.get("target") or {}
        by = d.get("decided_by")
        text = (
            f"{by} {d['status']} {d.get('created_by', 'agent')} {d.get('id')}: {d.get('summary')}"
        )
        if d.get("decision_reason"):
            text += f" (reason: {d['decision_reason']})"
        team = target.get("team") if target.get("team") != "all" else None
        return [line("decision", text, team=team, drone=target.get("drone"),
                     sector=target.get("sector"), refs=[r for r in (d.get("id"),) if r], by=by)]  # fmt: skip
    if ev.type == "fleet.updated" and "approved for" in ev.summary:
        leg = next((x for x in (d.get("legs") or []) if x.get("id") == ev.ref), {})
        return [line("drone", ev.summary, drone=leg.get("drone_id"), sector=leg.get("sector_id"),
                     refs=[r for r in (ev.ref,) if r])]  # fmt: skip
    if ev.type != "mission.note":
        return []
    if d.get("found"):
        f = d["found"]
        return [line("found", ev.summary, team=f.get("team"), sector=f.get("sector"),
                     refs=[r for r in (f.get("team"), f.get("sector")) if r], by=d.get("by"))]  # fmt: skip
    if d.get("decision"):
        x = d["decision"]
        return [line("decision", ev.summary, team=x.get("team"), sector=x.get("sector"),
                     refs=[r for r in (x.get("team"), x.get("sector")) if r], by=x.get("by"))]  # fmt: skip
    if d.get("checkin"):
        c = d["checkin"]
        return [
            line(
                "checkin", ev.summary, team=c.get("team"), refs=[c["team"]] if c.get("team") else []
            )
        ]
    if d.get("relay"):
        r = d["relay"]
        via = r.get("via") or []
        return [line("checkin", ev.summary, team=r.get("team_id"), drone=via[0] if via else None,
                     sector=_sector(sector_of, r), refs=[r.get("team_id"), *via])]  # fmt: skip
    if d.get("fleet_link"):
        f = d["fleet_link"]
        target = f.get("target") or ""
        if not _DRONE.match(target):
            return [line("checkin", ev.summary, team=target, refs=[target])]
        return [line("drone", ev.summary, drone=target, refs=[target])]
    if d.get("recall"):
        r = d["recall"]
        return [line("drone", ev.summary, drone=r.get("drone"),
                     refs=[x for x in (r.get("drone"), d.get("proposal")) if x])]  # fmt: skip
    if d.get("drone"):
        x = d["drone"]
        return [line("drone", ev.summary, drone=x.get("drone"), sector=x.get("sector"),
                     refs=[r for r in (x.get("drone"), x.get("leg")) if r])]  # fmt: skip
    return []


def timeline(
    events: Iterable[MissionEvent], teams: Iterable[Any] = (), sector_of: SectorOf | None = None
) -> list[TimelineEntry]:
    """Every timeline line of ``events``, in event order."""
    teams = list(teams)
    return [x for ev in events for x in entries(ev, teams, sector_of)]


def for_store(store: Any, mission_id: str) -> tuple[list[Any], SectorOf]:
    """The mission's teams and a sector lookup for ``entries``."""
    from sightline.mission.command import sector_of

    teams = store.state(mission_id)["teams"]
    return teams, lambda lat, lon: sector_of(store, mission_id, lat, lon)


def mission_timeline(store: Any, mission_id: str) -> list[TimelineEntry]:
    """The whole timeline of a mission, oldest first."""
    teams, where = for_store(store, mission_id)
    return timeline(store.events(mission_id), teams, where)
