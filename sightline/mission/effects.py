"""What each human decision and field report does (LANE_D §5.4): the part that closes the loop.

Nothing here happens without the decision or report that triggers it. The map steps are lane C's
math (``LiveMap``); until C-L1 lands they are skipped and the returned note says so. Agent hooks
(lane A) only enqueue; a failing hook never stops an effect.

Done by lane A for lane D (issue #51); lane D owns this file.
"""

from __future__ import annotations

import logging
from typing import Any

from sightline.contract import (
    Clue,
    ClueDraft,
    FleetTelemetry,
    MapUpdate,
    Proposal,
    SectorTask,
    Team,
)
from sightline.mission.store import MissionStore, now_iso

log = logging.getLogger(__name__)
WAITS_FOR_C = "map update skipped: waits for C-L1 (LiveMap)"
# Lane B's default clue radii (sightline/geo/clues.py), kept under this name for callers.


def _hook(hooks: Any, name: str, *args: Any) -> None:
    if hooks is None:
        return
    try:
        getattr(hooks, name)(*args)
    except Exception:
        log.exception("hooks.%s failed", name)


def _map(store: MissionStore, mission_id: str, make) -> MapUpdate | None | str:
    """Run one of C's LiveMap methods and store its update; a note instead while C is missing."""
    try:
        update = make(store.live(mission_id))
    except NotImplementedError:
        return WAITS_FOR_C
    except ValueError as e:  # no map base
        return f"map update skipped: {e}"
    if update is None:
        return None
    return store.append_map_update(mission_id, update)


def _layout(store: MissionStore, mission_id: str) -> Any | None:
    """C's lattice sectors (A1..D4) for this mission's grid, or None until C-S1 lands."""
    try:
        from sightline.search.sectors import lattice_sectors  # type: ignore[import-not-found]
    except ImportError:
        return None
    return lattice_sectors(store.live(mission_id).base.grid)


def sector_overview(store: MissionStore, mission_id: str) -> list[dict]:
    """Each sector now: label, POA on the live map, drone coverage (the share of its cells a photo
    has looked at) and its outline (closed [lon, lat] ring). For ``GET /sectors`` (the command view
    and the live map) and the debrief."""
    from sightline.geo.cards import sector_label

    layout = _layout(store, mission_id)
    if layout is None:
        return []
    live = store.live(mission_id)
    poa = live.sector_poa(layout)
    canopy = live.canopy()
    out = []
    for s in layout.sectors:
        cells = layout.cells_of(s.id)
        seen = sum(canopy[int(i)] is not None for i in cells) / len(cells)
        out.append(
            {
                "sector_id": s.id,
                "label": sector_label(s.id),
                "poa": round(poa[s.id], 4),
                "drone_coverage": round(seen, 3),
                "polygon": [list(c) for c in layout.polygon(s.id, live.base.grid)],
            }
        )
    return out


def on_decision(store: MissionStore, mission_id: str, p: Proposal) -> None:
    """After ``store.decide_proposal``: an approved ``assign_sector`` assigns the task and the
    team; an approved ``promote_detection`` puts the detection in the review queue; an approved
    recall (``retask_drone`` with a ``home`` target) is said in the feed. (Approved
    legs enter the fleet inside ``decide_proposal``; ``alert``s need nothing more: the radio's
    outbound queue reads approved proposals with a briefing.)"""
    if p.status != "approved":
        return
    state = store.state(mission_id)
    if p.kind == "assign_sector":
        team_id, sector_id = p.target.get("team"), p.target.get("sector")
        task = next((t for t in state["tasks"] if t.sector_id == sector_id), None)
        if task is not None:
            store.upsert_task(
                mission_id,
                task.model_copy(
                    update={
                        "state": "assigned",
                        "team_id": team_id,
                        "pod": None,
                        "updated_at": now_iso(),
                    }
                ),
            )
        team = next((t for t in state["teams"] if t.id == team_id), None)
        if team is not None:
            from sightline.mission.command import eta_to

            eta = eta_to(store, mission_id, team, sector_id)
            store.upsert_team(
                mission_id, team.model_copy(update={"status": "assigned", "eta_min": eta})
            )
    elif p.kind == "retask_drone" and "home" in p.target:
        # a recall: the store already cancelled the drone's leg and approved the home leg (the
        # re-task path); the feed says so in words, with the reason it was approved on
        drones = state["fleet"].drones if state["fleet"] else []
        drone = next((d for d in drones if d.id == p.target["drone"]), None)
        name = drone.name if drone else p.target["drone"]
        store.emit(mission_id, "mission.note", f"{name} recalled home ({p.id}): {p.reason}",
                   ref=p.target["drone"], data={"recall": p.target, "proposal": p.id})  # fmt: skip
    elif p.kind == "promote_detection":
        det_id = p.target.get("detection")
        det, _ = store.get_detection(mission_id, det_id)
        # The review queue = conf ≥ threshold, or an approved promotion (LANE_D §5.4).
        store.emit(
            mission_id,
            "detection.new",
            f"{det_id} promoted to the review queue",
            ref=det_id,
            data={**det.model_dump(), "promoted_by": p.id},
        )


# Which state a sector task can move to (LANE_E §7.2): assign, start or unassign, mark searched, reopen.
TASK_MOVES: dict[str, set[str]] = {
    "proposed": {"assigned"},
    "assigned": {"in_progress", "proposed"},
    "in_progress": {"searched"},
    "searched": {"proposed"},
}


def on_task_update(
    store: MissionStore, mission_id: str, task: SectorTask, hooks: Any = None
) -> MapUpdate | None | str:
    """Save the task; a sector ``searched`` with a POD steps the map over its cells (C), then the
    agent re-plans (``on_task_searched``). Only the command view's moves are allowed (LANE_E §7.2,
    ``TASK_MOVES``)."""
    old = next((t for t in store.state(mission_id)["tasks"] if t.sector_id == task.sector_id), None)
    before = old.state if old else "proposed"
    if task.state != before and task.state not in TASK_MOVES[before]:
        raise ValueError(f"sector {task.sector_id} can't go from {before} to {task.state}")
    if task.state == "searched" and task.pod is None:
        raise ValueError("a searched sector needs a POD")
    if task.state == "searched" and not 0 < task.pod <= 0.9:
        raise ValueError("POD must be above 0 and at most 90 %")
    if task.state != "searched" and task.pod is not None:
        raise ValueError("POD is only set when the sector is searched")
    store.upsert_task(mission_id, task)
    if task.state != "searched":
        return None
    layout = _layout(store, mission_id)
    if layout is None:
        return "map update skipped: waits for C-S1 (lattice sectors)"
    cells = [int(i) for i in layout.cells_of(task.sector_id)]
    update = _map(
        store, mission_id, lambda live: live.ground_update(cells, task.pod, task.sector_id)
    )
    _hook(hooks, "on_task_searched", store, mission_id, task.sector_id)
    return update


def on_team_update(store: MissionStore, mission_id: str, team: Team, hooks: Any = None) -> Team:
    """Save the team; a new position goes to the agent (``on_team_position``): a team on standby
    gets its next sector from where it is, and idle drones are planned around it."""
    old = next((t for t in store.state(mission_id)["teams"] if t.id == team.id), None)
    store.upsert_team(mission_id, team)
    if team.position is not None and (old is None or old.position != team.position):
        from sightline.mission.command import heard

        # a position report is a check-in (1.3): last heard, and back from overdue
        team = heard(store, mission_id, team.id, team.position_at or now_iso(), "position report")
        _hook(hooks, "on_team_position", store, mission_id, team.id)
    return team


def clue_from_draft(store: MissionStore, mission_id: str, draft: ClueDraft) -> Clue:
    """A clue from the form or the radio, ready for ``on_clue``; ValueError says what's wrong.

    A radio draft needs ``confirmed_by_turn``: a committed radio turn in the trace (the team's
    "affirmative" to the readback, contract §12.3 invariant 6). "At the team's position" uses the
    team's last reported position (lane B's ``resolve_position``; its warnings go to the event
    feed). The radius defaults by kind (lane B's ``DEFAULT_RADIUS_M``)."""
    if draft.source == "radio":
        committed = {
            (e.output or {}).get("id")
            for e in store.trace_entries(mission_id)
            if e.kind == "radio_turn" and (e.output or {}).get("state") == "committed"
        }
        if not draft.confirmed_by_turn or draft.confirmed_by_turn not in committed:
            raise ValueError(
                "a radio clue needs confirmed_by_turn: the committed turn of its readback"
            )
    from sightline.geo.clues import default_radius, resolve_position

    try:
        grid = store.live(mission_id).base.grid
    except ValueError:
        grid = None
    lat, lon, warnings = resolve_position(draft, store.state(mission_id)["teams"], grid, now_iso())
    for w in warnings:  # lane B's position warnings go to the feed with the clue
        store.emit(mission_id, "mission.note", f"clue position: {w}", data={"warning": w})
    return Clue.model_validate(
        {
            **draft.model_dump(),
            "lat": lat,
            "lon": lon,
            "id": "",
            "radius_m": default_radius(draft),
            "at": now_iso(),
            "confirmed": False,
        }
    )


def on_clue(
    store: MissionStore, mission_id: str, clue: Clue, hooks: Any = None
) -> tuple[Clue, MapUpdate | None | str]:
    """Add the (confirmed) clue, reweight the map around it (C), then tell the agent."""
    clue = store.add_clue(mission_id, clue)
    if any(t.id == clue.reported_by for t in store.state(mission_id)["teams"]):
        from sightline.mission.command import heard

        heard(store, mission_id, clue.reported_by, clue.at, None)  # the clue is the check-in
    update = _map(store, mission_id, lambda live: live.clue_update(clue))
    _hook(hooks, "on_clue", store, mission_id, clue.id)
    return clue, update


def on_review(
    store: MissionStore, mission_id: str, detection_id: str, answer: str, hooks: Any = None
) -> MapUpdate | None | str:
    """A reviewer's answer: the map changes around the detection (C), then the agent hears."""
    if answer not in ("person", "not_person", "unsure"):
        raise ValueError("answer must be person, not_person or unsure")
    det, frame = store.get_detection(mission_id, detection_id)
    from sightline.contract import LatLon

    update = _map(
        store,
        mission_id,
        lambda live: live.review_update(
            detection_id, frame.id, LatLon(lat=det.lat, lon=det.lon), det.radius_m, answer
        ),
    )
    store.emit(
        mission_id,
        "mission.note",
        f"review {detection_id}: {answer}",
        ref=detection_id,
        data={"answer": answer},
    )
    _hook(hooks, "on_review", store, mission_id, detection_id, answer)
    return update


def on_conditions(
    store: MissionStore, mission_id: str, c, hooks: Any = None
) -> MapUpdate | None | str:
    store.put_conditions(mission_id, c)
    update = _map(store, mission_id, lambda live: live.conditions_update(c))
    _hook(hooks, "on_conditions", store, mission_id)
    return update


def on_fleet(store: MissionStore, mission_id: str, t: FleetTelemetry, hooks: Any = None):
    """Merge telemetry; each leg newly ``done`` goes to the agent (``on_leg_done``). The first
    telemetry with drones creates the mission's fleet (how the fleet sim joins over HTTP); it is
    ``simulated`` when every drone is. Then the agent proposes the opening legs
    (``on_fleet_join``)."""
    if store.state(mission_id)["fleet"] is None:
        if not t.drones:
            raise ValueError("no fleet yet: send the drones first")
        from sightline.contract import FleetState, LatLon

        camp = store.get(mission_id).base_camp
        home = LatLon(lat=camp.lat, lon=camp.lon) if camp else None
        # each drone launches from and returns to the base camp unless it says otherwise (1.3)
        drones = [d.model_copy(update={"leg_id": None, "home": d.home or home}) for d in t.drones]
        fleet = FleetState(
            simulated=all(d.simulated for d in drones), drones=drones, legs=[], updated_at=t.at
        )
        store.put_fleet(mission_id, fleet)
        _hook(hooks, "on_fleet_join", store, mission_id)
        return fleet
    fleet, done = store.merge_telemetry(mission_id, t)
    for leg_id in done:
        _hook(hooks, "on_leg_done", store, mission_id, leg_id)
    return fleet
