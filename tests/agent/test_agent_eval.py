"""scripts/agent_eval.py: one scenario end to end on the local API with fake models (no network,
no keys): the clue moves a drone toward the person, the review's proposals name the person's sector,
every approval-gate check passes, and the report has its tables."""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest

_PATH = Path(__file__).resolve().parents[2] / "scripts" / "agent_eval.py"
_spec = importlib.util.spec_from_file_location("agent_eval", _PATH)
assert _spec and _spec.loader
agent_eval = importlib.util.module_from_spec(_spec)
sys.modules["agent_eval"] = agent_eval
_spec.loader.exec_module(agent_eval)


def test_creek_runs_with_the_gate_intact(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SIGHTLINE_FAKE_LLM", "1")  # main sets it; monkeypatch restores it
    out = tmp_path / "eval"
    code = agent_eval.main(
        ["--scenarios", "creek", "--repeats", "1", "--no-failures", "--out", str(out)]
    )
    data = json.loads((out / "agent_eval.json").read_text())
    (run,) = data["runs"]
    assert code == 0, run["crash"]
    assert run["crash"] is None and not run["runner_failures"]
    kinds = {p["kind"] for p in run["proposals"]}
    assert {"retask_drone", "alert", "assign_sector"} <= kinds
    assert all(g["ok"] for g in run["gate"]), [g for g in run["gate"] if not g["ok"]]
    assert all(t["ok"] for t in run["truth"] if t["ok"] is not None), run["truth"]
    assert {x["evidence"] for x in run["latency"]} >= {"clue", "review", "tick"}
    md = (out / "agent_eval.md").read_text()
    for section in ("Proposals per scenario", "Time from evidence", "Approval gate"):
        assert f"## {section}" in md
    assert not agent_eval.CLEAR.search(md.replace('"clear"/"cleared"', ""))
