"""Agent hooks D's pipeline and API call after each event (contract §14, LANE_A §5.4, §5.6).

Each hook puts one job on the agent's queue (``sightline.agent.runner``) and returns, well
under 5 ms; the work happens on the agent's own thread. A hook never raises into the caller.
``configure`` swaps the runner (tests, or a runner with other settings).
"""

from __future__ import annotations

import logging
from typing import Any

from sightline.agent.runner import Job, Runner

log = logging.getLogger(__name__)

_runner: Runner | None = None


def configure(runner: Runner | None) -> None:
    """Use ``runner`` for every hook from now on (``None``: a default one, built on first use)."""
    global _runner
    _runner = runner


def _submit(event: str, store: Any, mission_id: str, ref: str, answer: str | None = None) -> None:
    global _runner
    try:
        if _runner is None:
            _runner = Runner()
        _runner.submit(Job(event, store, mission_id, ref, answer))
    except Exception:
        log.exception("agent hook %s failed for mission %s", event, mission_id)


def on_detection(store: Any, mission_id: str, detection_id: str) -> None:
    _submit("detection", store, mission_id, detection_id)


def on_review(store: Any, mission_id: str, detection_id: str, answer: str) -> None:
    _submit("review", store, mission_id, detection_id, answer)


def on_clue(store: Any, mission_id: str, clue_id: str) -> None:
    _submit("clue", store, mission_id, clue_id)


def on_conditions(store: Any, mission_id: str) -> None:
    _submit("conditions", store, mission_id, mission_id)


def on_leg_done(store: Any, mission_id: str, leg_id: str) -> None:
    _submit("leg_done", store, mission_id, leg_id)


def on_task_searched(store: Any, mission_id: str, sector_id: str) -> None:
    """A team marked the sector searched at a POD (the map has the step): re-plan the drones."""
    _submit("task_searched", store, mission_id, sector_id)


def on_team_position(store: Any, mission_id: str, team_id: str) -> None:
    """A team reported a new position: a standby team's next sector; idle drones' legs."""
    _submit("team_position", store, mission_id, team_id)


def on_fleet_join(store: Any, mission_id: str) -> None:
    """The fleet joined the mission: the opening legs, one proposal per drone."""
    _submit("fleet_join", store, mission_id, mission_id)


def on_tick(store: Any, mission_id: str) -> None:
    """Every 5 min or 25 photos (D's scheduler): standby teams get ``assign_sector`` proposals."""
    _submit("tick", store, mission_id, mission_id)


def on_subject_set(store: Any, mission_id: str, proposal_id: str) -> None:
    """A subject profile was approved (the prior now has its category): re-plan the drones."""
    _submit("subject_set", store, mission_id, proposal_id)
