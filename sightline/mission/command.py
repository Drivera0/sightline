"""The command post's own actions (contract §15, v1.3): what a search manager does directly, beside
approving the agent's proposals. Each one changes the mission through ``MissionStore``, writes a
``human``/``decision`` trace entry (who, what, why) and a ``mission.note`` event whose ``data`` says
what was done, so the timeline, the ICS 214 and the audit show the agent's proposals and the direct
actions side by side.

A sector is never "done": searched means lowered by the POD the team reports; recheck puts it back on
the board with the map as it is.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

import numpy as np

from sightline.contract import Found, LatLon
from sightline.mission.store import MissionStore, now_iso

log = logging.getLogger(__name__)
OUT = ("assigned", "searching", "returning")  # a team out in the field: it can be overdue


def _t(iso: str) -> datetime:
    return datetime.fromisoformat(iso)


class ActionError(ValueError):
    """An action that can't be done now (the API's 409), with the reason."""


def human_decision(
    store: MissionStore,
    mission_id: str,
    action: str,
    summary: str,
    by: str,
    *,
    reason: str | None = None,
    team: str | None = None,
    sector: str | None = None,
    extra: dict | None = None,
    emit: bool = True,
) -> dict:
    """The trace entry and (``emit``) the event for one direct action; returns its data."""
    from sightline.agent.trace import trace_call

    data = {"action": action, "by": by, "reason": reason, "team": team, "sector": sector,
            **(extra or {})}  # fmt: skip
    refs = [r for r in (team, sector) if r]
    trace_call(store, mission_id, actor="human", kind="decision", summary=f"{summary} (by {by})",
               output=data, refs=refs)  # fmt: skip
    if emit:
        store.emit(mission_id, "mission.note", f"{summary} (by {by})", ref=team or sector,
                   data={"decision": data})  # fmt: skip
    return data


def likeliest_cell(store: MissionStore, mission_id: str, sector: str) -> LatLon:
    """The centre of the sector's most probable cell on the live map now."""
    from sightline.mission.effects import _layout
    from sightline.search.grid import cell_center

    layout = _layout(store, mission_id)
    if layout is None or sector not in {s.id for s in layout.sectors}:
        raise KeyError(f"no sector {sector}")
    live = store.live(mission_id)
    cells = np.asarray(layout.cells_of(sector), dtype=int)
    p = live.p()[0]
    return cell_center(live.base.grid, int(cells[int(np.argmax(p[cells]))]))


def sector_of(store: MissionStore, mission_id: str, lat: float, lon: float) -> str | None:
    """The lattice sector holding a point, or None outside the grid (or before sectors exist)."""
    from sightline.mission.effects import _layout
    from sightline.search.grid import cell_containing

    layout = _layout(store, mission_id)
    if layout is None:
        return None
    grid = store.live(mission_id).base.grid
    rc = cell_containing(grid, LatLon(lat=lat, lon=lon))
    if rc is None:
        return None
    return layout.sectors[int(layout.cell_sector[rc[0] * grid.cols + rc[1]])].id


def team_of(store: MissionStore, mission_id: str, team_id: str) -> Any:
    t = next((t for t in store.state(mission_id)["teams"] if t.id == team_id), None)
    if t is None:
        raise KeyError(f"no team {team_id}")
    return t


def mark_found(
    store: MissionStore,
    mission_id: str,
    team_id: str,
    sector: str | None,
    lat: float | None,
    lon: float | None,
    by: str,
) -> Any:
    """The person is found: ``Mission.status`` becomes ``found`` with who, where and when. With no
    position, the sector's likeliest cell on the map (where the team was sent to look). From then on
    the agent proposes nothing new."""
    m = store.get(mission_id)
    if m.status == "found":
        raise ActionError("the mission is already found")
    team = team_of(store, mission_id, team_id)
    if lat is None or lon is None:
        if sector is None:
            raise ValueError("give a sector or a position")
        p = likeliest_cell(store, mission_id, sector)
        lat, lon = p.lat, p.lon
    elif sector is None:
        sector = sector_of(store, mission_id, lat, lon)
    at = now_iso()
    found = Found(team=team_id, sector=sector, lat=round(lat, 6), lon=round(lon, 6), at=at)
    m = store.update_mission(mission_id, status="found", found=found)
    where = f"sector {sector}" if sector else "outside the sectors"
    summary = f"Subject found by {team.callsign} in {where}"
    human_decision(store, mission_id, "found", summary, by, team=team_id, sector=sector,
                   extra={"lat": found.lat, "lon": found.lon}, emit=False)  # fmt: skip
    store.emit(mission_id, "mission.note", f"{summary} (by {by})", ref=team_id,
               data={"found": found.model_dump(), "by": by})  # fmt: skip
    return m


# --- last heard, ETA, overdue -------------------------------------------------------------------


def team_id_for(teams: list[Any], who: str) -> str | None:
    """A team's id from its id or its callsign ("T2" or "Team Two"), else None."""
    w = who.strip().lower()
    return next((t.id for t in teams if w in (t.id.lower(), t.callsign.lower())), None)


def _was(store: MissionStore, mission_id: str, team_id: str) -> str:
    """The status a team had before it went overdue (its last overdue check-in says)."""
    for ev in reversed(store.events(mission_id)):
        c = (ev.data or {}).get("checkin") if ev.type == "mission.note" else None
        if c and c.get("team") == team_id and c.get("overdue"):
            return c.get("was") or "searching"
    return "searching"


def heard(store: MissionStore, mission_id: str, team_id: str, at: str, how: str | None) -> Any:
    """The team was heard at ``at`` (a radio turn, a clue, a position report, a relay):
    ``last_heard_at`` moves forward, and an overdue team is back in contact (its status before).
    ``how``: the check-in event's words ("position report"); None when the turn or clue is already
    the timeline's entry. Returns the team."""
    team = team_of(store, mission_id, team_id)
    last = team.last_heard_at
    update: dict[str, Any] = {}
    if last is None or _t(at) >= _t(last):
        update["last_heard_at"] = at
    back = team.status == "overdue"
    if back:
        update["status"] = _was(store, mission_id, team_id)
    if update:
        team = team.model_copy(update=update)
        store.upsert_team(mission_id, team)
    if how or back:
        text = f"{team.callsign}: {how or 'heard'}" + (", back in contact" if back else "")
        store.emit(mission_id, "mission.note", text, ref=team_id,
                   data={"checkin": {"team": team_id, "at": at, "how": how, "overdue": False,
                                     "back_in_contact": back}})  # fmt: skip
    return team


def eta_to(store: MissionStore, mission_id: str, team: Any, sector_id: str | None) -> float | None:
    """Minutes on foot from the team (its last position, else the base camp) to the sector, or back
    to the base camp with no sector (the planner's walking estimate); None without a map."""
    from sightline.mission.effects import _layout
    from sightline.search.planner import walk_minutes

    try:
        grid = store.live(mission_id).base.grid
    except ValueError:
        return None
    m = store.get(mission_id)
    camp = LatLon(lat=m.base_camp.lat, lon=m.base_camp.lon) if m.base_camp else m.area.lkp
    at = team.position or camp
    if sector_id is None:
        return round(walk_minutes(grid, at, camp))
    layout = _layout(store, mission_id)
    sector = next((s for s in layout.sectors if s.id == sector_id), None) if layout else None
    return None if sector is None else round(walk_minutes(grid, at, sector))


def check_overdue(store: MissionStore, mission_id: str, now: str, hooks: Any = None) -> list[str]:
    """Teams out in the field (assigned, searching, returning) not heard for longer than the
    mission's ``check_in_min`` become ``overdue``: a check-in event says for how long, and the agent
    hears (``hooks.on_team_overdue``). Returns the teams that went overdue now."""
    m = store.get(mission_id)
    if m.status == "found":
        return []
    out = []
    for t in store.state(mission_id)["teams"]:
        if t.status not in OUT or t.last_heard_at is None:
            continue
        minutes = (_t(now) - _t(t.last_heard_at)).total_seconds() / 60
        if minutes <= m.check_in_min:
            continue
        store.upsert_team(mission_id, t.model_copy(update={"status": "overdue"}))
        store.emit(mission_id, "mission.note",
                   f"{t.callsign} not heard for {minutes:.0f} min (check-in every {m.check_in_min:g} min)",
                   ref=t.id, data={"checkin": {"team": t.id, "overdue": True, "minutes": round(minutes),
                                               "was": t.status, "last_heard_at": t.last_heard_at}})  # fmt: skip
        out.append(t.id)
        if hooks is not None:
            try:
                hooks.on_team_overdue(store, mission_id, t.id)
            except Exception:
                log.exception("hooks.on_team_overdue failed")
    return out
