"""The mission debrief (LANE_C §5.7, C-D1): markdown built from the mission's own log.

Deterministic tables first: the timeline of key events; sightings with the second look and the
reviewer's answer; every proposal with who decided it and when; each sector's drone coverage, task
state and POD ("searched by Team Two at POD 50 %"); conditions over time; clues; sectors not yet
searched by a team, ranked by POA. Then, with a ``ChatClient``, a one-paragraph narrative written
**only** from those tables and post-checked: every number in it must appear in the tables, and it
must not say "clear". Two failed tries and the debrief has no narrative; the tables are the record.

The word "clear"/"cleared" never appears: free text from the log (a clue, a reason) that contains it
is masked, because a debrief that says an area was cleared can stop a search.

Built by lane A for lane C (issue #64); lane C owns this file.
"""

from __future__ import annotations

import json
import logging
import re
from collections import Counter
from typing import Any

from sightline.contract import MissionEvent, TraceEntry

log = logging.getLogger(__name__)

_CLEAR = re.compile(r"\bclear(s|ed|ing)?\b", re.IGNORECASE)
_NUMBER = re.compile(r"[A-Za-z]*\d+(?:[.,]\d+)?")
NARRATIVE_WORDS = 120
TIMELINE_TYPES = {
    "proposal.new",
    "proposal.decided",
    "clue.added",
    "task.updated",
    "verdict",
    "conditions.updated",
    "mission.note",
    "radio.turn",
}


def _safe(text: Any) -> str:
    """Table-safe and never "clear": pipes and newlines escaped, the word masked."""
    s = "" if text is None else str(text)
    s = _CLEAR.sub("[word withheld]", s)
    return s.replace("|", "\\|").replace("\n", " ").strip()


def _t(at: str | None) -> str:
    return "" if not at else at[5:16].replace("T", " ")


def _pct(x: float | None) -> str:
    return "–" if x is None else f"{round(x * 100)} %"


def _table(head: list[str], rows: list[list[Any]]) -> list[str]:
    if not rows:
        return ["_None._", ""]
    out = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
    out += ["| " + " | ".join(_safe(c) for c in r) + " |" for r in rows]
    return [*out, ""]


def _callsigns(state: dict) -> dict[str, str]:
    return {t.id: t.callsign for t in state.get("teams", [])}


def _timeline(events: list[MissionEvent]) -> list[list[Any]]:
    rows = [
        [_t(e.at), e.type, e.summary]
        for e in events
        if e.type in TIMELINE_TYPES and not e.summary.endswith(": proposed")  # the seeded tasks
    ]
    counts = Counter(e.type for e in events)
    tail = [
        f"{counts[k]} {label}"
        for k, label in (
            ("photo.processed", "photos processed"),
            ("detection.new", "candidates flagged"),
            ("map.updated", "map updates"),
        )
        if counts[k]
    ]
    if tail:
        rows.append(["", "totals", ", ".join(tail)])
    return rows


def _sightings(state: dict, events: list[MissionEvent]) -> list[list[Any]]:
    reviews: dict[str, str] = {}
    for e in events:
        if e.type == "mission.note" and e.ref and (e.data or {}).get("answer"):
            reviews[e.ref] = e.data["answer"]  # the last answer stands
    rows = []
    seen = set()
    for v in state.get("verdicts", []):
        seen.add(v.detection_id)
        saw = ", ".join(x for x in (v.clothing, v.posture if v.posture != "unknown" else None) if x)
        rows.append(
            [
                v.detection_id,
                v.person,
                saw or "–",
                v.reason,
                reviews.get(v.detection_id, "not reviewed"),
            ]
        )
    for det_id, answer in reviews.items():
        if det_id not in seen:
            rows.append([det_id, "no second look", "–", "–", answer])
    return rows


def _proposals(state: dict) -> list[list[Any]]:
    rows = []
    for p in state.get("proposals", []):
        decided = (
            f"{p.status} by {p.decided_by} at {_t(p.decided_at)}" if p.decided_at else p.status
        )
        why = f" ({p.decision_reason})" if p.decision_reason else ""
        rows.append([p.id, _t(p.created_at), p.kind, p.created_by, p.summary, decided + why])
    return rows


def _sector_rows(state: dict, sectors: list[dict]) -> list[list[Any]]:
    tasks = {t.sector_id: t for t in state.get("tasks", [])}
    names = _callsigns(state)
    rows = []
    for s in sectors:
        t = tasks.get(s["sector_id"])
        if t is None or t.state == "proposed":
            ground = "not assigned"
        elif t.state == "searched":
            team = names.get(t.team_id or "", t.team_id or "a team")
            ground = f"searched by {team} at POD {_pct(t.pod)}"
        else:
            ground = f"{t.state.replace('_', ' ')} ({names.get(t.team_id or '', t.team_id or '–')})"
        rows.append(
            [s["sector_id"], s.get("label", ""), _pct(s["poa"]), _pct(s["drone_coverage"]), ground]
        )
    return rows


def _conditions(state: dict, events: list[MissionEvent]) -> list[list[Any]]:
    snaps = [e.data for e in events if e.type == "conditions.updated" and e.data]
    if not snaps and state.get("conditions") is not None:
        snaps = [state["conditions"].model_dump()]
    rows = []
    for c in snaps:
        wind = "–" if c.get("wind_kmh") is None else f"{c['wind_kmh']:.0f} km/h"
        if c.get("gust_kmh") is not None:
            wind += f", gusts {c['gust_kmh']:.0f}"
        rain = "–" if c.get("precip_mm_h") is None else f"{c['precip_mm_h']:.1f} mm/h"
        fly = {True: "yes", False: "no", None: "unknown"}[c.get("flyable")]
        alerts = "; ".join(a.get("title", "") for a in c.get("alerts", [])) or "none"
        rows.append(
            [_t(c["fetched_at"]), wind, rain, f"{fly}: {c.get('flyability_reason', '')}", alerts]
        )
    return rows


def _clues(state: dict) -> list[list[Any]]:
    names = _callsigns(state)
    return [
        [
            c.id,
            _t(c.at),
            c.kind,
            c.text,
            names.get(c.reported_by, c.reported_by),
            c.reliability,
            f"{c.radius_m:.0f} m",
            "yes" if c.confirmed else "no",
        ]
        for c in state.get("clues", [])
    ]


def _unsearched(state: dict, sectors: list[dict]) -> list[list[Any]]:
    done = {t.sector_id for t in state.get("tasks", []) if t.state == "searched"}
    left = sorted((s for s in sectors if s["sector_id"] not in done), key=lambda s: -s["poa"])
    return [
        [i + 1, s["sector_id"], _pct(s["poa"]), _pct(s["drone_coverage"])]
        for i, s in enumerate(left)
    ]


def _trace_rows(trace: list[TraceEntry]) -> list[list[Any]]:
    by = Counter((e.actor, e.kind) for e in trace)
    return [[a, k, n] for (a, k), n in sorted(by.items())]


def check_narrative(text: str, tables: str) -> list[str]:
    """Problems with a narrative: says "clear", too long, or a number not in the tables."""
    problems = []
    if _CLEAR.search(text):
        problems.append('says "clear"')
    if len(text.split()) > NARRATIVE_WORDS:
        problems.append(f"more than {NARRATIVE_WORDS} words")
    allowed = set(_NUMBER.findall(tables))
    invented = [n for n in _NUMBER.findall(text) if n not in allowed]
    if invented:
        problems.append(f"numbers not in the tables: {invented}")
    return problems


def _narrative(tables: str, client: Any) -> str | None:
    from sightline.agent.llm import MODEL_FAST

    messages = [
        {
            "role": "system",
            "content": (
                "You summarise a search-and-rescue mission log for the debrief, in one paragraph of "
                f"at most {NARRATIVE_WORDS} words. Use only what is in the tables. Write numbers as "
                "digits, exactly as they appear in the tables, and no other numbers. A sector a team "
                'searched is described by its POD; nothing is ever ruled out. Never say "clear", '
                '"clears", "cleared" or "clearing". A person seen in a photo is a sighting, not a find.'
            ),
        },
        {"role": "user", "content": "Tables:\n" + tables},
    ]
    for _ in range(2):
        try:
            text = client.chat(messages, model=MODEL_FAST, temperature=0.2).text.strip()
        except Exception:  # offline or out of budget: the tables are the debrief
            log.exception("debrief narrative call failed")
            return None
        problems = check_narrative(text, tables)
        if not problems:
            return text
        messages += [
            {"role": "assistant", "content": text},
            {"role": "user", "content": "Rewrite it. Problems: " + json.dumps(problems)},
        ]
    return None


def debrief(
    state: dict,
    trace: list[TraceEntry],
    events: list[MissionEvent],
    client: Any = None,
    *,
    sectors: list[dict] | None = None,
    now: str | None = None,
) -> str:
    """The debrief as markdown. ``state`` is ``MissionStore.state``; ``events`` should be the whole
    log (``store.events``), not the recent tail in the state. ``sectors`` are the rows of
    ``GET /sectors`` (sector_id, label, poa, drone_coverage); without them the sector tables are
    empty. ``client`` (a ``ChatClient``) adds the checked narrative."""
    m = state["mission"]
    sectors = sectors or []
    head = [
        f"# Debrief: {_safe(m.name)}",
        "",
        f"Area: {_safe(m.area.name)} · Mission {m.mission_id} · started {_t(m.created_at)}"
        + (f" · debrief at {_t(now)}" if now else ""),
        "",
        f"Subject: {_safe(m.subject or 'not given')}",
        "",
        "_Sightline proposes; people decide. POD is how well a sector was searched; no sector is ruled out._",
        "",
    ]
    body: list[str] = []
    for title, cols, rows in (
        ("Timeline", ["time", "event", "what"], _timeline(events)),
        ("Sightings", ["detection", "person (second look)", "seen", "why", "reviewer"], _sightings(state, events)),
        ("Proposals and decisions", ["id", "time", "kind", "by", "summary", "decision"], _proposals(state)),
        ("Sectors", ["sector", "name", "POA now", "drone coverage", "ground"], _sector_rows(state, sectors)),
        ("Conditions over time", ["time", "wind", "rain", "flyable", "alerts"], _conditions(state, events)),
        ("Clues", ["id", "time", "kind", "what", "reported by", "reliability", "radius", "confirmed"], _clues(state)),
        ("Not yet searched by a team, by POA", ["rank", "sector", "POA now", "drone coverage"], _unsearched(state, sectors)),
        ("Log", ["actor", "kind", "entries"], _trace_rows(trace)),
    ):  # fmt: skip
        body += [f"## {title}", "", *_table(cols, rows)]
    tables = "\n".join(body)
    out = head
    if client is not None:
        text = _narrative(tables, client)
        if text:
            out += [
                "## Summary",
                "",
                text,
                "",
                "_Written by a model from the tables below, and checked against them._",
                "",
            ]
    return "\n".join([*out, *body]).rstrip() + "\n"
