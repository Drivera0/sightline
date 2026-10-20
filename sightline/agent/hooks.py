"""Agent hooks D's pipeline and API call after each event (contract §14, LANE_A §5.4).

Day-1 version (A-H1): every hook writes one trace ``note`` and returns. The real behaviour
(enqueue for ``sightline.agent.runner``) arrives in A-G1 behind the same signatures, so D wires
these once. A hook never raises into the caller: a failure is logged and dropped.
"""

from __future__ import annotations

import logging
from typing import Any

from sightline.agent.trace import trace_call

log = logging.getLogger(__name__)


def _note(store: Any, mission_id: str, hook: str, detail: str, refs: list[str]) -> None:
    try:
        trace_call(
            store,
            mission_id,
            actor="agent",
            kind="note",
            summary=f"{hook}({detail}) received; agent loop not running yet (stub)",
            refs=refs,
        )
    except Exception:
        log.exception("agent hook %s failed for mission %s", hook, mission_id)


def on_detection(store: Any, mission_id: str, detection_id: str) -> None:
    _note(store, mission_id, "on_detection", detection_id, [detection_id])


def on_review(store: Any, mission_id: str, detection_id: str, answer: str) -> None:
    _note(store, mission_id, "on_review", f"{detection_id}, {answer}", [detection_id])


def on_clue(store: Any, mission_id: str, clue_id: str) -> None:
    _note(store, mission_id, "on_clue", clue_id, [clue_id])


def on_conditions(store: Any, mission_id: str) -> None:
    _note(store, mission_id, "on_conditions", mission_id, [])


def on_leg_done(store: Any, mission_id: str, leg_id: str) -> None:
    _note(store, mission_id, "on_leg_done", leg_id, [leg_id])
