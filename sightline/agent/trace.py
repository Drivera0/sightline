"""Trace helpers over ``MissionStore.trace`` (docs/LANE_A_SPRINT.md §4, contract §12.2).

Every model and tool call the agent (or another lane) makes goes into ``trace.jsonl`` through
``trace_call``. What goes in is passed through ``trim`` first: images stay as paths, base64 is
dropped, API keys are redacted, long strings are cut.
"""

from __future__ import annotations

import dataclasses
import os
import re
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import PurePath
from typing import Any

from pydantic import BaseModel

from sightline.agent._contract_v12 import TraceActor, TraceEntry, TraceKind
from sightline.agent.llm import ChatResult

SECRET_ENV = ("NEBIUS_API_KEY", "TAVILY_API_KEY", "NVIDIA_API_KEY", "AWS_SECRET_ACCESS_KEY")
REDACTED = "[redacted]"

_SECRET_KEY = re.compile(
    r"api[_-]?key|authorization|secret|password|access[_-]?token", re.IGNORECASE
)
_BEARER = re.compile(r"Bearer\s+\S+")
_DATA_URI = re.compile(r"data:[\w/+.-]+;base64,[A-Za-z0-9+/=]+")
_BASE64 = re.compile(r"[A-Za-z0-9+/]{200,}={0,2}")  # one unbroken run, as encoders write it


def now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _secrets() -> list[str]:
    return [v for k in SECRET_ENV if (v := os.environ.get(k)) and len(v) >= 8]


def _trim_str(s: str, max_str: int, secrets: list[str]) -> str:
    for v in secrets:
        s = s.replace(v, REDACTED)
    s = _BEARER.sub(f"Bearer {REDACTED}", s)
    s = _DATA_URI.sub(lambda m: f"[base64 image dropped, {len(m.group())} chars]", s)
    if _BASE64.fullmatch(s.strip()):
        return f"[base64 dropped, {len(s)} chars]"
    if len(s) > max_str:
        return f"{s[:max_str]}… [{len(s) - max_str} more chars]"
    return s


def _trim(obj: object, max_str: int, secrets: list[str]) -> object:
    if obj is None or isinstance(obj, bool | int | float):
        return obj
    if isinstance(obj, str):
        return _trim_str(obj, max_str, secrets)
    if isinstance(obj, PurePath):
        return str(obj)
    if isinstance(obj, bytes | bytearray | memoryview):
        return f"[{len(obj)} bytes dropped]"
    if isinstance(obj, BaseModel):
        return _trim(obj.model_dump(mode="json"), max_str, secrets)
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        return _trim(dataclasses.asdict(obj), max_str, secrets)
    if isinstance(obj, dict):
        return {
            str(k): REDACTED if _SECRET_KEY.search(str(k)) else _trim(v, max_str, secrets)
            for k, v in obj.items()
        }
    if isinstance(obj, list | tuple | set | frozenset):
        return [_trim(v, max_str, secrets) for v in obj]
    return _trim_str(str(obj), max_str, secrets)


def trim(obj: object, max_str: int = 2000) -> object:
    """A JSON-ready copy of ``obj`` that is safe to trace: base64 and bytes dropped, secrets
    (env values of ``SECRET_ENV``, secret-looking keys, bearer tokens) redacted, strings cut at
    ``max_str``; paths kept as strings."""
    return _trim(obj, max_str, _secrets())


def trace_call(
    store: Any,
    mission_id: str,
    *,
    actor: TraceActor,
    kind: TraceKind,
    summary: str,
    input: dict | None = None,
    output: dict | None = None,
    result: ChatResult | None = None,
    refs: Iterable[str] = (),
) -> TraceEntry:
    """Append one trace entry through ``store.trace`` (which assigns the id) and return it.

    With a ``result`` the entry takes its model, ms and tokens, and its text and tool calls as the
    output unless ``output`` is given. Pass images in ``input`` by path, e.g.
    ``{"prompt": ..., "images": ["relook/v0021-zoom.jpg"]}``.
    """
    if result is not None and output is None:
        output = {"text": result.text, "tool_calls": result.tool_calls}
    entry = TraceEntry(
        id="",
        at=now_iso(),
        actor=actor,
        kind=kind,
        summary=_trim_str(summary, 300, _secrets()),
        input=trim(input) if input is not None else None,  # type: ignore[arg-type]
        output=trim(output) if output is not None else None,  # type: ignore[arg-type]
        model=result.model if result else None,
        ms=result.ms if result else None,
        tokens_in=result.tokens_in if result else None,
        tokens_out=result.tokens_out if result else None,
        refs=list(refs),
    )
    return store.trace(mission_id, entry)
