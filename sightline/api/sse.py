"""Server-sent events for ``GET /missions/{id}/events`` (contract §13, LANE_D §4).

Each event is ``event: <type>\\nid: <id>\\ndata: <json>\\n\\n``; a comment line every
``HEARTBEAT_S`` keeps proxies (Caddy) from closing an idle stream. ``Last-Event-ID`` resumes:
``MissionStore.subscribe`` replays what came after it.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable

from sightline.contract import MissionEvent, TimelineEntry

HEARTBEAT_S = 15.0


def format_event(ev: MissionEvent) -> str:
    return f"event: {ev.type}\nid: {ev.id}\ndata: {ev.model_dump_json()}\n\n"


def format_timeline(ev: MissionEvent, entry: TimelineEntry) -> str:
    """A timeline line (1.3) as an SSE ``timeline`` event, with the id of the event it comes from."""
    return f"event: timeline\nid: {ev.id}\ndata: {entry.model_dump_json()}\n\n"


async def event_stream(
    events: AsyncIterator[MissionEvent],
    heartbeat_s: float = HEARTBEAT_S,
    timeline: Callable[[MissionEvent], list[TimelineEntry]] | None = None,
) -> AsyncIterator[str]:
    """SSE text for ``events``, with a heartbeat comment whenever nothing arrives for a while.
    ``timeline``: each event's timeline lines, sent right after it as ``timeline`` events."""
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
            for entry in timeline(ev) if timeline is not None else []:
                yield format_timeline(ev, entry)
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
