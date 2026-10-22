"""The command post's own actions (contract §15, v1.3): what a search manager does directly, beside
approving the agent's proposals. Each one changes the mission through ``MissionStore``, writes a
``human``/``decision`` trace entry (who, what, why) and a ``mission.note`` event whose ``data`` says
what was done, so the timeline, the ICS 214 and the audit show the agent's proposals and the direct
actions side by side.

A sector is never "done": searched means lowered by the POD the team reports; recheck puts it back on
the board with the map as it is.
"""

from __future__ import annotations

from typing import Any

import numpy as np

from sightline.contract import Found, LatLon
from sightline.mission.store import MissionStore, now_iso


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
