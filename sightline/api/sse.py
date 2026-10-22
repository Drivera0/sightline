"""Server-sent events for ``GET /missions/{id}/events`` (contract §13, LANE_D §4).

Each event is ``event: <type>\\nid: <id>\\ndata: <json>\\n\\n``; a comment line every
``HEARTBEAT_S`` keeps proxies (Caddy) from closing an idle stream. ``Last-Event-ID`` resumes:
``MissionStore.subscribe`` replays what came after it.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator

from sightline.contract import MissionEvent

HEARTBEAT_S = 15.0


def format_event(ev: MissionEvent) -> str:
    return f"event: {ev.type}\nid: {ev.id}\ndata: {ev.model_dump_json()}\n\n"


async def event_stream(
    events: AsyncIterator[MissionEvent], heartbeat_s: float = HEARTBEAT_S
) -> AsyncIterator[str]:
    """SSE text for ``events``, with a heartbeat comment whenever nothing arrives for a while."""
    it = aiter(events)
    pending: asyncio.Task | None = None
    try:
        while True:
            pending = pending or asyncio.ensure_future(anext(it))
            done, _ = await asyncio.wait({pending}, timeout=heartbeat_s)
            if not done:
                yield ": heartbeat\n\n"
                continue
            try:
                ev = pending.result()
            except StopAsyncIteration:
                return
            pending = None
            yield format_event(ev)
    finally:
        if pending is not None:  # finish the cancelled read before closing the generator
            pending.cancel()
            try:
                await pending
            except (asyncio.CancelledError, StopAsyncIteration):
                pass
        aclose = getattr(it, "aclose", None)
        if aclose is not None:
            await aclose()
