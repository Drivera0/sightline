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
| clue         | clue id      | ``retask_drone`` / ``drone_leg`` toward the planner's best sector |
| conditions   | mission id   | ``alert`` to recall drones when flying turns unsafe; re-plan when visibility drops below 0.6 |
| leg_done     | leg id       | next ``drone_leg`` for that drone                               |
| tick         | mission id   | ``assign_sector`` for standby teams                            |
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
from sightline.search.sectors import lattice_sectors  # lane C (C-S1)

try:  # lane C's planner (C-P1); the stub until it lands
    from sightline.search.planner import propose_assignments, propose_legs  # type: ignore
except ImportError:
    from sightline.agent._stubs import propose_assignments, propose_legs

log = logging.getLogger(__name__)

CANDIDATE_THRESHOLD = 0.29
LOW_VISIBILITY = 0.6
BRIEFING_WORDS = 60
_CLEAR = re.compile(r"\b(clear|cleared)\b", re.IGNORECASE)
# Numbers, with any letters in front kept on them, so "B3" and "f0042" are ids, not a 3 or 42.
_NUMBER = re.compile(r"[A-Za-z]*\d+(?:[.,]\d+)?")

# What the last conditions event looked like per mission, to act only on a change.
_last_conditions: dict[str, tuple[bool | None, float]] = {}
_lock = threading.Lock()


# --- briefings ---------------------------------------------------------------------------------


def check_briefing(text: str, facts: dict) -> list[str]:
    """Problems with a briefing: too long, says "clear", or has a number not in the facts."""
    problems = []
    if len(text.split()) > BRIEFING_WORDS:
        problems.append(f"more than {BRIEFING_WORDS} words")
    if _CLEAR.search(text):
        problems.append('says "clear"')
    allowed = set(_NUMBER.findall(json.dumps(facts, ensure_ascii=False)))
    invented = [n for n in _NUMBER.findall(text) if n not in allowed]
    if invented:
        problems.append(f"numbers not in the facts: {invented}")
    return problems


def template_briefing(facts: dict) -> str:
    """The fallback briefing: the facts, one short sentence each, nothing added."""
    return " ".join(f"{k.replace('_', ' ').capitalize()}: {v}." for k, v in facts.items() if v)


def write_briefing(facts: dict, client: ChatClient | None) -> str:
    """A radio briefing of at most 60 words from ``facts`` only (MODEL_FAST). Post-checked by
    ``check_briefing``; one retry, then ``template_briefing``. No coordinates: the assignment
    card carries them, so they are never put in the facts."""
    if client is None:
        return template_briefing(facts)
    messages = [
        {
            "role": "system",
            "content": (
                "You write short radio briefings for search-and-rescue ground teams. Use only the "
                f"facts given, at most {BRIEFING_WORDS} words, plain words, no coordinates. Write "
                "numbers as digits, and only numbers that are in the facts. Add no orders, urgency "
                "or claims beyond the facts: a person seen in a photo is a sighting, not a find. "
                'Never say "clear" or "cleared".'
            ),
        },
        {"role": "user", "content": "Facts:\n" + json.dumps(facts, ensure_ascii=False)},
    ]
    for _ in range(2):
        try:
            text = client.chat(messages, model=MODEL_FAST, temperature=0.2).text.strip()
        except Exception:  # offline, budget, timeouts: the template still says everything
            log.exception("briefing model call failed")
            break
        problems = check_briefing(text, facts)
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


def _add(store: Any, mission_id: str, **fields: Any) -> Proposal:
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
        refs=[p.id, *p.target.values()],
    )
    return p


def _pending(state: dict, kind: tuple[str, ...], key: str, value: str) -> list[Proposal]:
    return [
        p
        for p in state["proposals"]
        if p.status == "pending" and p.kind in kind and p.target.get(key) == value
    ]


def _propose_leg(store: Any, mission_id: str, state: dict, leg: Leg, why: str) -> Proposal:
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
        kind="retask_drone" if retask else "drone_leg",
        summary=f"{verb} sector {leg.sector_id} ({leg.expected_clearance:.1%} expected)",
        reason=f"{why} {leg.reason}".strip(),
        target={"drone": drone.id, "leg": leg.id},
        leg=leg,
        evidence=[EvidenceRef(kind="leg", ref=leg.id, caption=leg.reason)],
        created_by="planner",
    )


def _replan(store: Any, mission_id: str, why: str, drone_id: str | None = None) -> list[Proposal]:
    state = store.state(mission_id)
    if state["fleet"] is None:
        return []
    live, layout = _layout(store, mission_id)
    legs = propose_legs(live, layout, state["fleet"], state["conditions"], now_iso())
    if drone_id is not None:
        legs = [leg for leg in legs if leg.drone_id == drone_id]
    return [_propose_leg(store, mission_id, state, legs[0], why)] if legs else []


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
            briefing=write_briefing({"team": team.callsign, "sector": sector, **facts}, client),
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
            briefing=write_briefing(facts, client),
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
    return _replan(store, mission_id, why)


def _on_conditions(store, mission_id) -> list[Proposal]:
    c: Conditions | None = store.state(mission_id)["conditions"]
    if c is None:
        return []
    with _lock:
        prev_flyable, prev_vis = _last_conditions.get(mission_id, (None, 1.0))
        _last_conditions[mission_id] = (c.flyable, c.visibility_factor)
    if c.flyable is False and prev_flyable is not False:
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
    return _replan(store, mission_id, f"Leg {leg_id} is done.", drone_id=leg.drone_id)


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
    if event == "tick":
        return _on_tick(store, mission_id, client)
    raise ValueError(f"unknown agent event {event!r}")
