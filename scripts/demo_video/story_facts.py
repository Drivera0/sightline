"""The story's names, read off the demo mission fixture, for the captions and the narration.

A caption or a narration line can say ``{find_team}``, ``{find_sector}``, ``{find_sector_said}`` ("Charlie
Two"), ``{story_team}``, ``{story_sector}``, ``{story_sector_said}``, ``{clue_team}``, ``{clue_text}``,
``{find_call}`` or ``{find_reply}``; ``fill`` puts in what the fixture says, so a scenario change (a
different finding team or sector, another first assignment) never leaves a line naming the old one. The
rules follow storyCopy.ts: the story's proposal is the scenario's first ``assign_sector``; its clue is the
last clue before it that its reason names (by radio when one did); the find's call is the finding team's
last radio call in before the find that says located or found.
"""

from __future__ import annotations

import json
import re
from functools import cache
from pathlib import Path

FIXTURE = Path(__file__).resolve().parents[2] / "web/src/command/__fixtures__/demo_mission.json"
NATO = dict(zip("ABCDEFGHIJKLMNOPQRSTUVWXYZ", ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliett", "Kilo", "Lima", "Mike", "November", "Oscar", "Papa", "Quebec", "Romeo", "Sierra", "Tango", "Uniform", "Victor", "Whiskey", "X-ray", "Yankee", "Zulu"], strict=True))  # fmt: skip
NUMBERS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]


def said(sector: str) -> str:
    """ "C2" -> "Charlie Two", as a sector is said on the radio."""
    m = re.fullmatch(r"([A-Z])(\d)", sector or "")
    return f"{NATO[m.group(1)]} {NUMBERS[int(m.group(2))].capitalize()}" if m else sector


def spoken(text: str) -> str:
    """A radio line as said: the fixture's parenthesised notes dropped."""
    return re.sub(r"\s*\([^)]*\)", "", text).strip()


@cache
def facts(path: Path = FIXTURE) -> dict[str, str]:
    d = json.loads(path.read_text())
    teams = {t["id"]: t["callsign"] for t in d.get("teams", [])}
    out: dict[str, str] = {}
    props = sorted((p for p in d.get("proposals", []) if p["kind"] == "assign_sector" and (p.get("target") or {}).get("sector")),
                   key=lambda p: p["created_at"])  # fmt: skip
    if props:
        p = props[0]
        out |= {"story_team": teams.get(p["target"].get("team"), p["target"].get("team", "")),
                "story_team_id": p["target"].get("team", ""), "story_sector": p["target"]["sector"], "story_sector_said": said(p["target"]["sector"])}  # fmt: skip
        before = sorted(
            (c for c in d.get("clues", []) if c["at"] <= p["created_at"]), key=lambda c: c["at"]
        )
        named = [
            c
            for c in before
            if re.search(rf"\b{c['id']}\b", p["reason"])
            or c["text"].split(",")[0].strip() in p["reason"]
        ]
        radio = [c for c in named if c.get("source") == "radio"]
        clue = (radio or named or before or [None])[-1]
        if clue:
            out |= {"clue_team": teams.get(clue.get("reported_by"), ""), "clue_text": clue["text"]}
    f = (d.get("mission") or {}).get("found")
    if f:
        out |= {
            "find_team_id": f["team"],
            "find_team": teams.get(f["team"], f["team"]),
            "find_sector": f["sector"],
            "find_sector_said": said(f["sector"]),
        }
        radio = [
            e
            for e in d.get("timeline", [])
            if e.get("kind") == "radio" and e.get("team") == f["team"] and e["at"] <= f["at"]
        ]
        calls = [
            e
            for e in radio
            if e.get("direction") == "in" and re.search(r"located|found", e["text"], re.IGNORECASE)
        ]
        if calls:
            out["find_call"] = spoken(calls[-1]["text"])
            replies = [
                e for e in radio if e.get("direction") == "out" and e["at"] >= calls[-1]["at"]
            ]
            if replies:
                out["find_reply"] = spoken(replies[0]["text"])
    return out


def fill(text: str) -> str:
    """`text` with the fixture's names put in; a name the fixture doesn't have stops the run."""
    if "{" not in text:
        return text
    try:
        return text.format_map(facts())
    except KeyError as e:
        raise SystemExit(
            f"{text!r}: the demo mission fixture has no {e} (story_facts.py)"
        ) from None
