"""scripts/trace_excerpt.py: following refs from a proposal back to the OpenCV re-look."""

import importlib.util
import sys
from pathlib import Path

_PATH = Path(__file__).resolve().parents[2] / "scripts" / "trace_excerpt.py"
_spec = importlib.util.spec_from_file_location("trace_excerpt", _PATH)
assert _spec and _spec.loader
excerpt = importlib.util.module_from_spec(_spec)
sys.modules["trace_excerpt"] = excerpt
_spec.loader.exec_module(excerpt)


def _e(kind: str, refs: list[str], summary: str = "") -> dict:
    return {"at": "t", "actor": "agent", "kind": kind, "summary": summary or kind, "refs": refs}


def test_chain_follows_refs_and_leaves_other_detections_out() -> None:
    entries = [
        _e("tool_call", ["f0001-d01"]),
        _e("tool_call", ["f0002-d01"]),  # another detection: not in the chain
        _e("verdict", ["f0001-d01", "v0001"]),
        _e("proposal", ["p001", "f0001-d01"]),
        _e("decision", ["p001", "f0001-d01"]),
        _e("proposal", ["p002", "f0009-d01"]),
    ]
    got = [e["kind"] for e in excerpt.chain(entries, "p001")]
    assert got == ["tool_call", "verdict", "proposal", "decision"]


def test_committed_chain_has_every_step() -> None:
    d = Path(__file__).resolve().parents[2] / "docs" / "architecture" / "av-chain"
    entries = [
        __import__("json").loads(line) for line in (d / "trace.jsonl").read_text().splitlines()
    ]
    kinds = [e["kind"] for e in excerpt.chain(entries, "p001")]
    assert kinds == ["note", "tool_call", "model_call", "verdict", "proposal", "decision"]
