"""Trace helpers (sightline/agent/trace.py): what may and may not reach trace.jsonl."""

from __future__ import annotations

import base64
from pathlib import Path

from sightline.agent._contract_v12 import TraceEntry
from sightline.agent.llm import ChatResult
from sightline.agent.trace import REDACTED, trace_call, trim

B64 = base64.b64encode(bytes(range(256)) * 4).decode()


def test_trim_drops_base64_and_keeps_paths() -> None:
    msg = {
        "role": "user",
        "content": [
            {"type": "text", "text": "person?"},
            {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{B64}"}},
        ],
        "images": [Path("relook/v0001-zoom.jpg")],
        "raw": B64,
        "bytes": b"\xff\xd8",
    }
    out = trim(msg)
    assert B64 not in repr(out)
    assert out["content"][1]["image_url"]["url"].startswith("[base64 image dropped")
    assert out["images"] == ["relook/v0001-zoom.jpg"]
    assert out["raw"].startswith("[base64 dropped")
    assert out["bytes"] == "[2 bytes dropped]"


def test_trim_keeps_ordinary_long_text_and_cuts_it() -> None:
    text = "a person in a red jacket near the creek " * 100
    out = trim({"t": text}, max_str=50)["t"]
    assert out.startswith(text[:50]) and out.endswith("more chars]")


def test_trim_redacts_secrets(monkeypatch) -> None:
    monkeypatch.setenv("NEBIUS_API_KEY", "nb-supersecret-123")
    out = trim(
        {
            "api_key": "anything",
            "headers": {"Authorization": "Bearer xyz"},
            "note": "key was nb-supersecret-123 and Bearer abc.def",
            "tokens_in": 12,
        }
    )
    assert out["api_key"] == REDACTED
    assert out["headers"]["Authorization"] == REDACTED
    assert "nb-supersecret-123" not in out["note"] and "abc.def" not in out["note"]
    assert out["tokens_in"] == 12


class _ListStore:
    def __init__(self) -> None:
        self.entries: list[TraceEntry] = []

    def trace(self, mission_id: str, entry: TraceEntry) -> TraceEntry:
        entry = entry.model_copy(update={"id": f"t{len(self.entries) + 1:06d}"})
        self.entries.append(entry)
        return entry


def test_trace_call_takes_model_numbers_from_the_result() -> None:
    store = _ListStore()
    r = ChatResult('{"person": "yes"}', [], "nvidia/vl", 812, 900, 40)
    e = trace_call(
        store,
        "ab12cd34",
        actor="verifier",
        kind="model_call",
        summary="VL verdict for f0001-d01",
        input={"images": [Path("crops/f0001-d01.jpg")]},
        result=r,
        refs=["f0001-d01"],
    )
    assert e.id == "t000001" and e.at.endswith("Z")
    assert (e.model, e.ms, e.tokens_in, e.tokens_out) == ("nvidia/vl", 812, 900, 40)
    assert e.output == {"text": '{"person": "yes"}', "tool_calls": []}
    assert e.input == {"images": ["crops/f0001-d01.jpg"]}
    assert e.refs == ["f0001-d01"]
