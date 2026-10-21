"""How the radio desk reads and writes the mission: through lane D's API (contract §13).

``RadioTools`` and the turn handler only see ``MissionApi``. ``HttpMissionApi`` calls D's REST API
(so posting a clue runs D's side effects: position, map update, agent hook); ``InMemoryMissionApi``
holds a fixture mission for tests and ``dev.py`` and records every write.
"""

from __future__ import annotations

import json
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Protocol


class MissionApi(Protocol):
    def state(self, mission_id: str) -> dict: ...  # GET /missions/{id}/state
    def card(
        self, mission_id: str, sector_id: str
    ) -> dict: ...  # GET /missions/{id}/cards/{sector}
    def patch_team(
        self, mission_id: str, team_id: str, patch: dict
    ) -> dict: ...  # PATCH /teams/{tid}
    def post_clue(self, mission_id: str, draft: dict) -> dict: ...  # POST /missions/{id}/clues


class HttpMissionApi:
    """D's mission API over HTTP (stdlib only). ``base_url`` like ``http://127.0.0.1:8000``."""

    def __init__(self, base_url: str, timeout_s: float = 10.0) -> None:
        self.base = base_url.rstrip("/")
        self.timeout = timeout_s

    def _call(self, method: str, path: str, body: dict | None = None) -> Any:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(
            self.base + path, data=data, method=method, headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=self.timeout) as r:
            return json.loads(r.read() or b"null")

    def state(self, mission_id: str) -> dict:
        return self._call("GET", f"/missions/{mission_id}/state")

    def card(self, mission_id: str, sector_id: str) -> dict:
        return self._call("GET", f"/missions/{mission_id}/cards/{sector_id}")

    def patch_team(self, mission_id: str, team_id: str, patch: dict) -> dict:
        return self._call("PATCH", f"/missions/{mission_id}/teams/{team_id}", patch)

    def post_clue(self, mission_id: str, draft: dict) -> dict:
        return self._call("POST", f"/missions/{mission_id}/clues", draft)


@dataclass
class InMemoryMissionApi:
    """A fixture mission in memory; every write is recorded in ``calls``."""

    mission_state: dict
    cards: dict[str, dict] = field(default_factory=dict)
    calls: list[tuple[str, str, dict]] = field(default_factory=list)

    def state(self, mission_id: str) -> dict:
        return self.mission_state

    def card(self, mission_id: str, sector_id: str) -> dict:
        if sector_id not in self.cards:
            raise KeyError(f"no card for sector {sector_id}")
        return self.cards[sector_id]

    def patch_team(self, mission_id: str, team_id: str, patch: dict) -> dict:
        self.calls.append(("patch_team", team_id, patch))
        team = next(t for t in self.mission_state["teams"] if t["id"] == team_id)
        team.update(patch)
        return team

    def post_clue(self, mission_id: str, draft: dict) -> dict:
        self.calls.append(("post_clue", draft["reported_by"], draft))
        clue = {**draft, "id": f"c{len(self.mission_state['clues']) + 1:03d}", "confirmed": True}
        self.mission_state["clues"].append(clue)
        return clue


def demo_mission() -> tuple[dict, dict[str, dict]]:
    """The radio demo script's mission (LANE_E §8.7): Team Two assigned to sector B3, a card for
    B3, conditions, and an approved assignment briefing waiting to be transmitted."""
    state = {
        "mission": {"mission_id": "demo0001", "name": "Seymour — missing hiker", "subject": "adult, red jacket, day hiker"},
        "teams": [
            {"id": "T1", "callsign": "Team One", "members": 3, "status": "standby", "position": None, "position_at": None, "note": None},
            {"id": "T2", "callsign": "Team Two", "members": 3, "status": "assigned", "position": {"lat": 49.3745, "lon": -122.9358}, "position_at": "2026-10-24T21:40:00Z", "note": None},
            {"id": "T3", "callsign": "Team Three", "members": 4, "status": "searching", "position": None, "position_at": None, "note": None},
            {"id": "T4", "callsign": "Team Four", "members": 2, "status": "standby", "position": None, "position_at": None, "note": None},
        ],
        "tasks": [{"sector_id": "B3", "state": "assigned", "team_id": "T2", "poa": 0.18, "pod": None, "note": None, "updated_at": "2026-10-24T21:35:00Z"}],
        "clues": [],
        "proposals": [
            {"id": "p014", "kind": "assign_sector", "summary": "Assign sector B3 to Team Two", "status": "approved",
             "briefing": "New assignment, sector Bravo Three. Enter from the east ridge, bearing 270, 600 metres. Looking for a red jacket, possibly lying down. Two hours forty of daylight.",
             "target": {"team": "T2", "sector": "B3"}, "decided_at": "2026-10-24T21:36:00Z", "decided_by": "Search manager"},
        ],
        "conditions": {"fetched_at": "2026-10-24T21:30:00Z", "wind_kmh": 18, "gust_kmh": 30, "precip_mm_h": 0.4, "flyable": True,
                       "civil_twilight_end": "2026-10-25T01:12:00Z", "alerts": [{"title": "Lower Seymour trail closed"}]},
        "events": [],
    }  # fmt: skip
    cards = {
        "B3": {
            "sector_id": "B3", "sector_label": "Bravo Three", "team_id": "T2",
            "entry": {"name": "east ridge", "lat": 49.3741, "lon": -122.9301},
            "bearing_deg_from_team": 270, "distance_m_from_team": 600, "area_m2": 62500.0,
            "waypoints": [{"name": n} for n in ("NW corner", "NE corner", "SE corner", "SW corner")],
            "look_for": ["adult, red jacket, day hiker", "possibly lying down"],
            "conditions_line": "gusts 30 km/h, light rain",
        }
    }  # fmt: skip
    return state, cards
