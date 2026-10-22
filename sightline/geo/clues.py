"""Where a clue is (LANE_B §5.2, ``resolve_position``): from the lat/lon given, or the reporting
team's last position, with the radius for its kind when the report gave none, and warnings when the
position is weak (a stale team fix, a point outside the search grid).

Built by lane A for lane B (issue #74); lane B owns this file.
"""

from __future__ import annotations

from datetime import UTC, datetime

from sightline.contract import ClueDraft, Grid, LatLon, Team
from sightline.search.grid import cell_containing

# Default radius by kind (LANE_B §4), except a sighting: 100 m, not 50, because a person seen moves on,
# and the OpenCV report's re-task chain (§5.2) was recorded with 100 m. Change both together.
DEFAULT_RADIUS_M = {"object": 30.0, "track": 75.0, "sighting": 100.0, "sound": 200.0, "other": 75.0}
STALE_MIN = 30


def default_radius(draft: ClueDraft) -> float:
    return draft.radius_m if draft.radius_m is not None else DEFAULT_RADIUS_M[draft.kind]


def resolve_position(
    draft: ClueDraft, teams: list[Team], grid: Grid | None, now: str | None = None
) -> tuple[float, float, list[str]]:
    """(lat, lon, warnings). ValueError when there is no position at all."""
    now_t = datetime.fromisoformat(now) if now else datetime.now(UTC)
    warnings: list[str] = []
    if draft.at_team_position:
        team = next((t for t in teams if t.id == draft.reported_by), None)
        if team is None:
            raise ValueError(f"no team {draft.reported_by}")
        if team.position is None:
            raise ValueError(f"no known position for {team.callsign}")
        lat, lon = team.position.lat, team.position.lon
        if team.position_at:
            age = (now_t - datetime.fromisoformat(team.position_at)).total_seconds() / 60
            if age > STALE_MIN:
                warnings.append(f"{team.callsign}'s position is {age:.0f} min old")
    elif draft.lat is not None and draft.lon is not None:
        if not (-90 <= draft.lat <= 90 and -180 <= draft.lon <= 180):
            raise ValueError("a clue's latitude must be -90 to 90 and its longitude -180 to 180")
        lat, lon = draft.lat, draft.lon
    else:
        raise ValueError("a clue needs lat/lon or at_team_position")
    if grid is not None and cell_containing(grid, LatLon(lat=lat, lon=lon)) is None:
        warnings.append("outside the search grid: kept, but it does not move the map")
    return lat, lon, warnings
