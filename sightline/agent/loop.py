"""The agent loop: evidence in, proposals out (LANE_A §5.6; A-G1).

``handle`` is called by ``sightline.agent.runner`` for one event of one mission. It reads the
mission through ``MissionStore``, asks the verifier and lane C's planner, and adds
**proposals** a person approves or rejects; it never acts. Every proposal has a reason with the
planner's numbers, evidence, and, when it concerns people in the field, a briefing written only
from the facts it was given (``write_briefing``). There is no ``dismiss_detection`` in v1.

| event        | ref          | proposals                                                       |
|--------------|--------------|-----------------------------------------------------------------|
| detection    | detection id | ``promote_detection`` for a near-miss the verifier calls a person |
| review       | detection id | person: ``alert`` to all teams + ``assign_sector`` (nearest standby team); unsure: verdict only |
| clue         | clue id      | re-plan: ``retask_drone`` / ``drone_leg`` toward the planner's best sector, plus a ``drone_leg`` for every other idle drone |
| task_searched | sector id   | re-plan, as for a clue (the team's step is on the map)          |
| team_position | team id     | ``assign_sector`` if that team is on standby; ``drone_leg`` for idle drones with no pending one |
| conditions   | mission id   | ``alert`` to recall drones when flying turns unsafe; re-plan when visibility drops below 0.6 |
| leg_done     | leg id       | next ``drone_leg`` for that drone                               |
| tick         | mission id   | ``assign_sector`` for standby teams                            |

A re-plan is one proposal per drone at most, each approved on its own; the planner discounts
sectors a ground team is assigned to or searching.
"""

from __future__ import annotations

import json
import logging
import re
import threading
from typing import Any

from sightline.agent.llm import MODEL_FAST, ChatClient
from sightline.agent.trace import now_iso, trace_call
from sightline.agent.verify import VERIFY_BAND, verify
from sightline.contract import Conditions, EvidenceRef, LatLon, Leg, Proposal
from sightline.search.grid import cell_containing
from sightline.search.planner import propose_assignments, propose_legs  # lane C (C-P1)
from sightline.search.sectors import lattice_sectors  # lane C (C-S1)

log = logging.getLogger(__name__)

CANDIDATE_THRESHOLD = 0.29
LOW_VISIBILITY = 0.6
BRIEFING_WORDS = 60
_CLEAR = re.compile(r"\b(clear|cleared)\b", re.IGNORECASE)
# Telling teams to stop is never in the facts; live, an alert for a confirmed sighting ended "No
# further action is needed."
_STAND_DOWN = re.compile(
    r"\b(no (further )?action|stand ?down|call(ed)? off|nothing (more )?to do|no need to)\b",
    re.IGNORECASE,
)
# Numbers, with any letters in front kept on them, so "B3" and "f0042" are ids, not a 3 or 42.
_NUMBER = re.compile(r"[A-Za-z]*\d+(?:[.,]\d+)?")

# What the last conditions event looked like per mission, to act only on a change.
_last_conditions: dict[str, tuple[bool | None, float]] = {}
_lock = threading.Lock()


# --- briefings ---------------------------------------------------------------------------------


def check_briefing(text: str, facts: dict) -> list[str]:
    """Problems with a briefing: too long, says "clear", a number not in the facts, or a run-on
    with no punctuation (it is read aloud on the radio: live, the model once wrote "Team One sector
    B3 photo f0005 shows adult hiker in blue jacket dark head covering sitting")."""
    problems = []
    words = text.split()
    if len(re.findall(r"[A-Za-z]{2,}", text)) < 3 or text.lstrip()[:1] in "{[":
        # e.g. "{}" from a model asked for JSON elsewhere: it must never be read on the radio
        problems.append("not a briefing: write it as plain sentences")
    if len(words) > BRIEFING_WORDS:
        problems.append(f"more than {BRIEFING_WORDS} words")
    if len(words) > 12 and sum(text.count(c) for c in ".,;:") < 1 + len(words) // 20:
        problems.append("no punctuation: write full sentences, it is read aloud on the radio")
    if _CLEAR.search(text):
        problems.append('says "clear"')
    if _STAND_DOWN.search(text):
        problems.append("tells the team to stop or that nothing is needed: not in the facts")
    allowed = set(_NUMBER.findall(json.dumps(facts, ensure_ascii=False)))
    invented = [n for n in _NUMBER.findall(text) if n not in allowed]
    if invented:
        problems.append(f"numbers not in the facts: {invented}")
    return problems


def conditions_facts(c: Conditions | None, now: str) -> dict[str, str]:
    """What a team needs from lane B's conditions, as briefing facts: daylight left, wind and rain,
    alerts (closures, warnings). Nothing when there are no conditions or a value is unknown."""
    if c is None:
        return {}
    out: dict[str, str] = {}
    if c.civil_twilight_end:
        from datetime import datetime

        left = (
            datetime.fromisoformat(c.civil_twilight_end) - datetime.fromisoformat(now)
        ).total_seconds() / 60
        if left > 0:
            out["daylight_left"] = f"{int(left // 60)} h {int(left % 60)} min"
    weather = []
    if c.wind_kmh is not None:
        weather.append(f"wind {c.wind_kmh:.0f} km/h")
    if c.gust_kmh is not None:
        weather.append(f"gusts {c.gust_kmh:.0f} km/h")
    if c.precip_mm_h:
        weather.append(f"rain {c.precip_mm_h:g} mm/h")
    if weather:
        out["weather"] = ", ".join(weather)
    if c.alerts:
        out["alerts"] = "; ".join(a.title for a in c.alerts[:2])
    return out


def template_briefing(facts: dict) -> str:
    """The fallback briefing: the facts, one short sentence each, nothing added."""
    return " ".join(f"{k.replace('_', ' ').capitalize()}: {v}." for k, v in facts.items() if v)


def write_briefing(
    facts: dict,
    client: ChatClient | None,
    store: Any = None,
    mission_id: str | None = None,
    refs: tuple[str, ...] = (),
) -> str:
    """A radio briefing of at most 60 words from ``facts`` only (MODEL_FAST). Post-checked by
    ``check_briefing``; one retry, then ``template_briefing``. No coordinates: the assignment
    card carries them, so they are never put in the facts. With ``store``, every model call and
    a fallback to the template go into the mission's trace."""

    def trace(**kw: Any) -> None:
        if store is not None and mission_id is not None:
            trace_call(store, mission_id, actor="agent", refs=refs, **kw)

    if client is None:
        return template_briefing(facts)
    messages = [
        {
            "role": "system",
            "content": (
                "You write short radio briefings for search-and-rescue ground teams, read aloud by "
                "the operator: full sentences with normal punctuation, addressed to the team. Use "
                f"only the facts given, at most {BRIEFING_WORDS} words, plain words, no coordinates. Write "
                "numbers as digits, and only numbers that are in the facts. State the facts and stop: "
                "say nothing about what is or isn't needed next (the search manager decides), and "
                "add no urgency or claims beyond the facts: a person seen in a photo is a sighting, "
                "not a find. "
                'Never say "clear" or "cleared".'
            ),
        },
        {"role": "user", "content": "Facts:\n" + json.dumps(facts, ensure_ascii=False)},
    ]
    for _ in range(2):
        try:
            r = client.chat(messages, model=MODEL_FAST, temperature=0.2)
        except Exception as e:  # offline, budget, timeouts: the template still says everything
            log.exception("briefing model call failed")
            trace(
                kind="note",
                summary=f"briefing model call failed ({type(e).__name__}): template used",
            )
            return template_briefing(facts)
        text = r.text.strip()
        problems = check_briefing(text, facts)
        trace(
            kind="model_call",
            summary="briefing" + (f" rejected: {'; '.join(problems)}" if problems else ""),
            input={"facts": facts},
            result=r,
        )
        if not problems:
            return text
        messages = [
            *messages,
            {"role": "assistant", "content": text},
            {
                "role": "user",
                "content": "Rewrite it from these facts only. Problems: "
                + "; ".join(problems)
                + "\nFacts:\n"
                + json.dumps(facts, ensure_ascii=False),
            },
        ]
    trace(kind="note", summary="briefing still had problems after a retry: template used")
    return template_briefing(facts)


# --- helpers -----------------------------------------------------------------------------------


def _layout(store: Any, mission_id: str):
    live = store.live(mission_id)
    return live, lattice_sectors(live.base.grid)


def _sector_at(live: Any, layout: Any, lat: float, lon: float) -> str | None:
    rc = cell_containing(live.base.grid, LatLon(lat=lat, lon=lon))
    if rc is None:
        return None
    idx = rc[0] * live.base.grid.cols + rc[1]
    return layout.sectors[int(layout.cell_sector[idx])].id


def _add(store: Any, mission_id: str, cause: tuple[str, ...] = (), **fields: Any) -> Proposal:
    """A pending proposal, traced with its target and ``cause`` (the clue or leg that led to it),
    so the trace links the evidence to the proposal."""
    p = store.add_proposal(
        mission_id,
        Proposal(
            id="",
            status="pending",
            created_at=now_iso(),
            decided_at=None,
            decided_by=None,
            decision_reason=None,
            edits=None,
            **{"briefing": None, "leg": None, **fields},
        ),
    )
    trace_call(
        store,
        mission_id,
        actor="agent",
        kind="proposal",
        summary=f"{p.id} {p.kind}: {p.summary}",
        output={"proposal": p.id, "kind": p.kind, "target": p.target, "reason": p.reason},
        refs=[p.id, *p.target.values(), *cause],
    )
    return p


def _pending(state: dict, kind: tuple[str, ...], key: str, value: str) -> list[Proposal]:
    return [
        p
        for p in state["proposals"]
        if p.status == "pending" and p.kind in kind and p.target.get(key) == value
    ]


def _propose_leg(
    store: Any, mission_id: str, state: dict, leg: Leg, why: str, cause: tuple[str, ...] = ()
) -> Proposal:
    """A leg proposal for ``leg.drone_id``; that drone's older pending leg proposals are
    superseded. ``retask_drone`` when the drone is already flying a leg."""
    drone = next(d for d in state["fleet"].drones if d.id == leg.drone_id)
    leg = leg.model_copy(update={"id": store.next_id(mission_id, "L")})
    for old in _pending(state, ("drone_leg", "retask_drone"), "drone", drone.id):
        store.set_proposal_status(mission_id, old.id, "superseded", by="agent")
    retask = drone.status == "flying" and drone.leg_id is not None
    verb = f"Re-task {drone.name} to" if retask else f"Send {drone.name} to"
    return _add(
        store,
        mission_id,
        cause,
        kind="retask_drone" if retask else "drone_leg",
        summary=f"{verb} sector {leg.sector_id} ({leg.expected_clearance:.1%} expected)",
        reason=f"{why} {leg.reason}".strip(),
        target={"drone": drone.id, "leg": leg.id},
        leg=leg,
        evidence=[EvidenceRef(kind="leg", ref=leg.id, caption=leg.reason)],
        created_by="planner",
    )


def _replan(
    store: Any,
    mission_id: str,
    why: str,
    drone_id: str | None = None,
    cause: tuple[str, ...] = (),
    idle_only: bool = False,
) -> list[Proposal]:
    """Leg proposals on the live map, one per drone, each for a person to approve: with
    ``drone_id``, that drone's next leg; else the best leg of the whole fleet (a re-task when its
    drone is flying) and one for every other idle drone, planned around it (sequential greedy, so
    no two share a sector). ``idle_only``: idle drones with no pending leg proposal, nothing else."""
    state = store.state(mission_id)
    if state["fleet"] is None:
        return []
    live, layout = _layout(store, mission_id)
    fleet = state["fleet"]

    def plan(f: Any, k: int) -> list[Leg]:
        return propose_legs(
            live, layout, f, state["conditions"], now_iso(), k=k, tasks=state["tasks"]
        )

    if drone_id is not None:  # plan for that drone only (the others' legs still count as taken)
        fleet = fleet.model_copy(update={"drones": [d for d in fleet.drones if d.id == drone_id]})
        legs = plan(fleet, 1)
    else:
        idle = {d.id for d in fleet.drones if d.status == "idle"}
        if idle_only:
            idle -= {d for d in idle if _pending(state, ("drone_leg", "retask_drone"), "drone", d)}
            keep = idle
        else:
            best = plan(fleet, 1)
            keep = idle | {best[0].drone_id} if best else set()
        # the best leg's drone first: greedy picks it again, then the idle drones around it
        fleet = fleet.model_copy(update={"drones": [d for d in fleet.drones if d.id in keep]})
        legs = plan(fleet, len(keep)) if keep else []
    out = []
    for leg in legs:
        out.append(_propose_leg(store, mission_id, state, leg, why, cause))
        state = store.state(mission_id)
    return out


def _assign(
    store: Any,
    mission_id: str,
    state: dict,
    team_id: str,
    sector: str,
    reason: str,
    facts: dict,
    client: ChatClient | None,
    evidence: list[EvidenceRef],
) -> list[Proposal]:
    """At most one pending ``assign_sector`` per team."""
    if _pending(state, ("assign_sector",), "team", team_id):
        return []
    team = next(t for t in state["teams"] if t.id == team_id)
    return [
        _add(
            store,
            mission_id,
            kind="assign_sector",
            summary=f"Assign sector {sector} to {team.callsign}",
            reason=reason,
            briefing=write_briefing(
                {
                    "team": team.callsign,
                    "sector": sector,
                    **facts,
                    **conditions_facts(state["conditions"], now_iso()),
                },
                client,
                store,
                mission_id,
                (team_id, sector),
            ),
            target={"team": team_id, "sector": sector},
            evidence=evidence,
            created_by="agent",
        )
    ]


# --- events ------------------------------------------------------------------------------------


def _on_detection(store, mission_id, detection_id, client, detector) -> list[Proposal]:
    det, _ = store.get_detection(mission_id, detection_id)
    if det.conf < VERIFY_BAND[0] or client is None:
        return []
    v = verify(store, mission_id, detection_id, client, detector)
    if det.conf >= CANDIDATE_THRESHOLD or v.person != "yes":
        return []  # queue items get a verdict badge only; nothing is ever dismissed
    crop = det.crop or f"relook/{det.id}-crop.jpg"
    evidence = [EvidenceRef(kind="crop", ref=crop, caption=f"detector confidence {det.conf:.2f}")]
    evidence += [
        EvidenceRef(kind="relook", ref=p, caption=t)
        for p, t in zip(v.relook_crops, v.tools, strict=True)
    ]
    evidence.append(EvidenceRef(kind="trace", ref=v.id, caption=f"second look: {v.reason}"))
    return [
        _add(
            store,
            mission_id,
            kind="promote_detection",
            summary=f"Add {det.id} to the review queue: second look says likely a person",
            reason=(
                f"Detector confidence {det.conf:.2f} is below the review threshold "
                f"{CANDIDATE_THRESHOLD}; the second look ({', '.join(v.tools)}) says: {v.reason}"
            ),
            target={"detection": det.id},
            evidence=evidence,
            created_by="verifier",
        )
    ]


def _on_review(store, mission_id, detection_id, answer, client, detector) -> list[Proposal]:
    if answer == "unsure":
        if client is not None:
            verify(store, mission_id, detection_id, client, detector)
        return []
    if answer != "person":
        return []
    det, frame = store.get_detection(mission_id, detection_id)
    state = store.state(mission_id)
    live, layout = _layout(store, mission_id)
    sector = _sector_at(live, layout, det.lat, det.lon)
    verdict = next((v for v in state["verdicts"] if v.detection_id == det.id), None)
    facts = {
        "what": "a reviewer confirmed a person in a drone photo",
        "photo": frame.id,
        "sector": sector,
        "subject": state["mission"].subject,
        "clothing": verdict.clothing if verdict else None,
        "posture": verdict.posture if verdict and verdict.posture != "unknown" else None,
    }
    evidence = [EvidenceRef(kind="crop", ref=det.crop or frame.file, caption=f"photo {frame.id}")]
    out = [
        _add(
            store,
            mission_id,
            kind="alert",
            summary=f"Alert all teams: person confirmed in photo {frame.id} (sector {sector})",
            reason=f"Reviewer confirmed detection {det.id} as a person.",
            briefing=write_briefing(facts, client, store, mission_id, (det.id,)),
            target={"team": "all"},
            evidence=evidence,
            created_by="agent",
        )
    ]
    standby = [t for t in state["teams"] if t.status == "standby"]
    if sector and standby:

        def dist(t):  # nearest standby team; unknown positions last
            if t.position is None:
                return float("inf")
            return (t.position.lat - det.lat) ** 2 + (t.position.lon - det.lon) ** 2

        team = min(standby, key=dist)
        out += _assign(
            store,
            mission_id,
            state,
            team.id,
            sector,
            f"Confirmed sighting in photo {frame.id} lies in sector {sector}; "
            f"{team.callsign} is the nearest team on standby.",
            {k: v for k, v in facts.items() if k != "sector"},
            client,
            evidence,
        )
    return out


def _on_clue(store, mission_id, clue_id) -> list[Proposal]:
    state = store.state(mission_id)
    clue = next(c for c in state["clues"] if c.id == clue_id)
    live, layout = _layout(store, mission_id)
    sector = _sector_at(live, layout, clue.lat, clue.lon)
    poa = live.sector_poa(layout).get(sector) if sector else None
    where = f" in sector {sector}, which now holds {poa:.1%} of the probability" if poa else ""
    why = f"After clue {clue.id} ({clue.kind}, {clue.reliability} reliability: {clue.text}){where}."
    return _replan(store, mission_id, why, cause=(clue.id,))


def _on_conditions(store, mission_id) -> list[Proposal]:
    c: Conditions | None = store.state(mission_id)["conditions"]
    if c is None:
        return []
    with _lock:
        prev_flyable, prev_vis = _last_conditions.get(mission_id, (None, 1.0))
        _last_conditions[mission_id] = (c.flyable, c.visibility_factor)
    fleet = store.state(mission_id)["fleet"]
    in_air = fleet is not None and any(d.status in ("flying", "returning") for d in fleet.drones)
    # A recall only when a drone is up: live, a mission with no drones got "Recall drones" at dusk.
    if c.flyable is False and prev_flyable is not False and in_air:
        return [
            _add(
                store,
                mission_id,
                kind="alert",
                summary="Recall drones: flying conditions are no longer safe",
                reason=c.flyability_reason,
                target={"drone": "all"},
                evidence=[
                    EvidenceRef(kind="conditions", ref=c.fetched_at, caption=c.flyability_reason)
                ],
                created_by="agent",
            )
        ]
    if c.visibility_factor < LOW_VISIBILITY <= prev_vis:
        why = f"Visibility factor fell to {c.visibility_factor:.2f}; re-planned with it."
        return _replan(store, mission_id, why)
    return []


def _on_leg_done(store, mission_id, leg_id) -> list[Proposal]:
    fleet = store.state(mission_id)["fleet"]
    leg = next((leg for leg in fleet.legs if leg.id == leg_id), None) if fleet else None
    if leg is None:
        return []
    return _replan(
        store, mission_id, f"Leg {leg_id} is done.", drone_id=leg.drone_id, cause=(leg_id,)
    )


def _on_task_searched(store, mission_id, sector_id) -> list[Proposal]:
    state = store.state(mission_id)
    task = next((t for t in state["tasks"] if t.sector_id == sector_id), None)
    if task is None or task.state != "searched" or task.pod is None:
        return []
    team = next((t for t in state["teams"] if t.id == task.team_id), None)
    who = team.callsign if team else "A ground team"
    why = f"{who} searched sector {sector_id} at POD {task.pod:.0%}; re-planned on the new map."
    return _replan(store, mission_id, why, cause=(sector_id,))


def _on_team_position(store, mission_id, team_id, client) -> list[Proposal]:
    """A standby team gets its next sector from where it now is; idle drones without a proposal
    get one. A flying drone is not re-tasked for a position report: it changes no probability."""
    state = store.state(mission_id)
    team = next((t for t in state["teams"] if t.id == team_id), None)
    if team is None:
        return []
    out = []
    if team.status == "standby":
        live, layout = _layout(store, mission_id)
        for tid, sector, reason in propose_assignments(live, layout, state["tasks"], [team]):
            facts = {"why": reason, "subject": state["mission"].subject}
            out += _assign(store, mission_id, state, tid, sector, reason, facts, client, [])
    why = f"{team.callsign} reported a new position."
    return out + _replan(store, mission_id, why, cause=(team_id,), idle_only=True)


def _on_tick(store, mission_id, client) -> list[Proposal]:
    state = store.state(mission_id)
    live, layout = _layout(store, mission_id)
    out = []
    for team_id, sector, reason in propose_assignments(
        live, layout, state["tasks"], state["teams"]
    ):
        facts = {"why": reason, "subject": state["mission"].subject}
        out += _assign(store, mission_id, state, team_id, sector, reason, facts, client, [])
        state = store.state(mission_id)
    return out


def handle(
    event: str,
    store: Any,
    mission_id: str,
    ref: str,
    *,
    client: ChatClient | None,
    detector: Any = None,
    answer: str | None = None,
) -> list[Proposal]:
    """Proposals for one event (table in the module docstring). ``client=None`` means no model
    is available: the verifier is skipped and briefings use the template; planner proposals
    still go out."""
    if event == "detection":
        return _on_detection(store, mission_id, ref, client, detector)
    if event == "review":
        return _on_review(store, mission_id, ref, answer, client, detector)
    if event == "clue":
        return _on_clue(store, mission_id, ref)
    if event == "conditions":
        return _on_conditions(store, mission_id)
    if event == "leg_done":
        return _on_leg_done(store, mission_id, ref)
    if event == "task_searched":
        return _on_task_searched(store, mission_id, ref)
    if event == "team_position":
        return _on_team_position(store, mission_id, ref, client)
    if event == "tick":
        return _on_tick(store, mission_id, client)
    raise ValueError(f"unknown agent event {event!r}")
