"""What Nemotron may call during a radio turn (LANE_E §8.3). Read-mostly: nothing here changes an
assignment. ``draft_clue`` only stores a draft in the session; it is posted after the team
confirms the readback (``turn.py``). ``report_position`` / ``report_status`` update the roster.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from sightline.radio.mission_api import MissionApi

# Statuses a team may report by voice; "assigned" and "standby" are set by the search manager.
REPORTABLE_STATUS = {"searching", "returning"}
NATO = {"alpha": "A", "bravo": "B", "charlie": "C", "delta": "D"}


def sector_id_from(name: str) -> str:
    """ "B3", "b3", "Bravo Three", "bravo 3" → "B3" (live and replay sectors are A1–D4)."""
    from sightline.radio.protocol import normalize

    words = normalize(name).split()
    if len(words) == 2 and words[0] in NATO and words[1].isdigit():
        return f"{NATO[words[0]]}{words[1]}"
    return name.strip().upper().replace(" ", "")


CLUE_KINDS = ["object", "track", "sighting", "sound", "other"]


def _now() -> datetime:
    return datetime.now(UTC)


def _iso(t: datetime) -> str:
    return t.strftime("%Y-%m-%dT%H:%M:%SZ")


def _fn(name: str, description: str, properties: dict, required: list[str]) -> dict:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {"type": "object", "properties": properties, "required": required},
        },
    }


_TEAM = {"team_id": {"type": "string"}}
TOOL_SPECS = [
    _fn("get_assignment", "The team's assigned sector, entry point and what to look for.", _TEAM, ["team_id"]),
    _fn(
        "get_sector_boundary",
        "Corners of a sector, and bearing and distance to its entry from the team.",
        {"sector_id": {"type": "string"}, "from_team": {"type": "string"}},
        ["sector_id"],
    ),
    _fn("get_conditions", "Current weather, daylight and alerts for the search area.", {}, []),
    _fn(
        "get_updates_since",
        "Approved messages that concern the team in the last minutes.",
        {**_TEAM, "minutes": {"type": "integer"}},
        ["team_id"],
    ),
    _fn(
        "draft_clue",
        "Draft a clue the team reports (something found, a track, a sighting, a sound). It is read back for confirmation, not logged yet.",
        {
            **_TEAM,
            "kind": {"type": "string", "enum": CLUE_KINDS},
            "text": {"type": "string"},
            "lat": {"type": ["number", "null"]},
            "lon": {"type": ["number", "null"]},
            "at_team_position": {"type": "boolean"},
            "reliability": {"type": "string", "enum": ["low", "medium", "high"]},
        },
        ["team_id", "kind", "text", "at_team_position"],
    ),
    _fn(
        "report_position",
        "The team reports where it is.",
        {**_TEAM, "lat": {"type": "number"}, "lon": {"type": "number"}},
        ["team_id", "lat", "lon"],
    ),
    _fn(
        "report_status",
        "The team reports it is searching or returning.",
        {**_TEAM, "status": {"type": "string", "enum": sorted(REPORTABLE_STATUS)}},
        ["team_id", "status"],
    ),
]  # fmt: skip


@dataclass
class RadioTools:
    api: MissionApi
    mission_id: str
    drafts: dict[str, dict]  # team_id -> clue draft awaiting confirmation (the session's)

    def call(self, name: str, arguments: dict) -> dict:
        """Run one tool by name; unknown tools and bad arguments come back as ``{"error": ...}``."""
        fn = (
            getattr(self, name, None)
            if name in {s["function"]["name"] for s in TOOL_SPECS}
            else None
        )
        if fn is None:
            return {"error": f"unknown tool {name}"}
        try:
            return fn(**arguments)
        except (KeyError, TypeError, ValueError, StopIteration) as e:
            return {"error": f"{name}: {type(e).__name__}: {e}"}

    def _team(self, team_id: str) -> dict:
        return next(t for t in self.api.state(self.mission_id)["teams"] if t["id"] == team_id)

    def get_assignment(self, team_id: str) -> dict:
        state = self.api.state(self.mission_id)
        task = next(
            (
                t
                for t in state["tasks"]
                if t["team_id"] == team_id and t["state"] in ("assigned", "in_progress")
            ),
            None,
        )
        if task is None:
            return {"team_id": team_id, "assignment": None}
        card = self.api.card(self.mission_id, task["sector_id"])
        return {
            "sector_id": task["sector_id"],
            "sector": card["sector_label"],
            "state": task["state"],
            "entry": card["entry"]["name"],
            "bearing_deg": card.get("bearing_deg_from_team"),
            "distance_m": card.get("distance_m_from_team"),
            "look_for": card.get("look_for", []),
        }

    def get_sector_boundary(self, sector_id: str, from_team: str | None = None) -> dict:
        """The sector's size and named landmarks (not generic "NW corner" names, which tell a team
        nothing on the radio), and the way to its entry from the team."""
        sector_id = sector_id_from(sector_id)
        card = self.api.card(self.mission_id, sector_id)
        out: dict[str, Any] = {"sector_id": sector_id, "sector": card["sector_label"]}
        if card.get("area_m2"):
            out["size"] = f"about {round(card['area_m2'] ** 0.5 / 50) * 50} metres across"
        landmarks = [
            w["name"]
            for w in card.get("waypoints", [])
            if not re.fullmatch(r"(N|S)(E|W) corner", w["name"])
        ]
        if landmarks:
            out["landmarks"] = landmarks
        out["entry"] = card["entry"]["name"]
        if from_team:
            out["bearing_deg"] = card.get("bearing_deg_from_team")
            out["distance_m"] = card.get("distance_m_from_team")
        return out

    def get_conditions(self) -> dict:
        """Conditions in plain words, ready to say on the radio (no units codes or UTC stamps)."""
        c = self.api.state(self.mission_id).get("conditions")
        if not c:
            return {"conditions": None}
        out: dict[str, Any] = {}
        if c.get("wind_kmh") is not None:
            out["wind"] = f"{round(c['wind_kmh'])} kilometres per hour"
        if c.get("gust_kmh") is not None:
            out["gusts"] = f"{round(c['gust_kmh'])} kilometres per hour"
        rain = c.get("precip_mm_h")
        if rain is not None:  # the usual rain-rate bands
            out["rain"] = (
                "none"
                if rain == 0
                else "light rain"
                if rain < 2.5
                else "moderate rain"
                if rain < 7.6
                else "heavy rain"
            )
        if c.get("flyable") is not None:
            out["drones_can_fly"] = "yes" if c["flyable"] else "no"
        if c.get("civil_twilight_end"):
            from sightline.radio.protocol import local_clock

            out["daylight_until"] = f"{local_clock(c['civil_twilight_end'])} local"
        out["alerts"] = [a["title"] for a in c.get("alerts", [])]
        if c.get("fetched_at"):
            out["as_of"] = f"{local_clock(c['fetched_at'])} local"
        return out

    def conditions_summary(self) -> str | None:
        """The conditions as short radio sentences, built here so the punctuation (and so the
        voice's pauses) never depends on the model: live it ran them together ("gust thirty
        kilometres per hour light rain drones can fly yes")."""
        c = self.get_conditions()
        if c.get("conditions", True) is None:
            return None
        parts = []
        if "wind" in c:
            gusts = (
                f", gusts {c['gusts'].removesuffix(' kilometres per hour')}" if "gusts" in c else ""
            )
            parts.append(f"Wind {c['wind']}{gusts}.")
        elif "gusts" in c:
            parts.append(f"Gusts {c['gusts']}.")
        if "rain" in c:
            parts.append("No rain." if c["rain"] == "none" else f"{c['rain'].capitalize()}.")
        if "drones_can_fly" in c:
            parts.append("Drones can fly." if c["drones_can_fly"] == "yes" else "Drones grounded.")
        if "daylight_until" in c:
            parts.append(f"Daylight until {c['daylight_until']}.")
        parts += [f"Alert, {a}." for a in c.get("alerts", [])]
        if "as_of" in c:
            parts.append(f"As of {c['as_of']}.")
        return " ".join(parts) or None

    def get_updates_since(self, team_id: str, minutes: int = 30) -> list[dict]:
        since = _iso(_now() - timedelta(minutes=minutes))
        return [
            {"summary": p["summary"], "briefing": p.get("briefing")}
            for p in self.api.state(self.mission_id)["proposals"]
            if p["status"] == "approved"
            and p["target"].get("team") in (team_id, "all")
            and (p.get("decided_at") or "") >= since
        ]

    def draft_clue(
        self,
        team_id: str,
        kind: str,
        text: str,
        at_team_position: bool,
        lat: float | None = None,
        lon: float | None = None,
        reliability: str = "medium",
    ) -> dict:
        if kind not in CLUE_KINDS:
            raise ValueError(f"kind must be one of {CLUE_KINDS}")
        if not at_team_position and (lat is None or lon is None):
            at_team_position = True  # no place given: where the team is (LANE_E §8.7 beat 3)
        self.drafts[team_id] = {
            "kind": kind,
            "text": text,
            "lat": None if at_team_position else lat,
            "lon": None if at_team_position else lon,
            "at_team_position": at_team_position,
            "radius_m": None,
            "reliability": reliability,
            "reported_by": team_id,
            "source": "radio",
        }
        return {"status": "awaiting readback confirmation"}

    def report_position(self, team_id: str, lat: float, lon: float) -> dict:
        self._team(team_id)
        patch = {"position": {"lat": float(lat), "lon": float(lon)}, "position_at": _iso(_now())}
        self.api.patch_team(self.mission_id, team_id, patch)
        return {"status": "position updated"}

    def report_status(self, team_id: str, status: str) -> dict:
        if status not in REPORTABLE_STATUS:
            raise ValueError(f"status must be one of {sorted(REPORTABLE_STATUS)}")
        self._team(team_id)
        self.api.patch_team(self.mission_id, team_id, {"status": status})
        return {"status": f"{team_id} {status}"}

    def spec(self) -> list[dict[str, Any]]:
        return TOOL_SPECS
