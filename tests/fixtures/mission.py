"""Mission objects shared by the mission API tests and ``scripts/smoke.py``."""

from __future__ import annotations

from sightline.contract import TraceEntry


def committed_turn(turn_id: str) -> TraceEntry:
    """The radio turn where a team said "affirmative" to a clue readback, as the radio desk
    records it; a radio clue is accepted only with such a turn (contract §12.3 invariant 6)."""
    return TraceEntry(
        id="",
        at="2026-10-24T21:41:00Z",
        actor="radio",
        kind="radio_turn",
        summary="Affirmative, over.",
        input=None,
        output={"id": turn_id, "direction": "in", "state": "committed", "actions": ["post_clue"]},
        model=None,
        ms=None,
        tokens_in=None,
        tokens_out=None,
        refs=[],
    )
