"""scripts/agent_eval.py: one scenario end to end on the local API with fake models (no network,
no keys): after the clue a drone is over or proposed toward the person's sector, the review's
proposals name the person's sector,
every approval-gate check passes, and the report has its tables."""

from __future__ import annotations

import importlib.util
import json
import sys
from collections import Counter
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
    assert {"drone_leg", "alert", "assign_sector"} <= kinds
    assert all(g["ok"] for g in run["gate"]), [g for g in run["gate"] if not g["ok"]]
    assert all(t["ok"] for t in run["truth"] if t["ok"] is not None), run["truth"]
    assert {x["evidence"] for x in run["latency"]} >= {"review", "leg_done", "tick"}
    # #135: the opening legs already put a drone over the clue's sector, so the clue moves nobody
    (clue,) = [t for t in run["truth"] if t["check"].startswith("clue:")]
    assert clue["ok"], clue
    md = (out / "agent_eval.md").read_text()
    for section in ("Proposals per scenario", "Time from evidence", "Approval gate"):
        assert f"## {section}" in md
    assert not agent_eval.CLEAR.search(md.replace('"clear"/"cleared"', ""))


def test_relook_scenario_flies_the_low_pass_and_resolves_the_person(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("SIGHTLINE_FAKE_LLM", "1")
    out = tmp_path / "eval"
    code = agent_eval.main(
        [
            "--scenarios",
            "relook",
            "--repeats",
            "1",
            "--no-failures",
            "--out",
            str(out),
            "--val",
            str(tmp_path / "no-val"),
        ]
    )
    (run,) = json.loads((out / "agent_eval.json").read_text())["runs"]
    assert code == 0, run["crash"]
    assert all(g["ok"] for g in run["gate"]), [g for g in run["gate"] if not g["ok"]]
    checks = {t["check"]: t["ok"] for t in run["truth"] if t["check"].startswith("re-look")}
    assert len(checks) == 2 and all(checks.values()), run["truth"]
    (chain,) = run["relook_chains"]
    assert chain["box_long_px"] == 21 and chain["pixel_factor"] == 4.0
    assert chain["steps"][:5] == ["unclear", "leg", "photo", "verdict", "outcome"]
    relook, full = run["flights"]
    assert relook["relook"] and relook["altitude_m"] == 25.0 and relook["photos"] >= 1
    assert not full["relook"] and full["photos"] > 100
    kinds = Counter((x["kind"], x["flown_in_full"]) for x in run["ledger"])
    assert kinds[("second_look", False)] == 2 and kinds[("leg", True)] == 2
    md = (out / "agent_eval.md").read_text()
    assert "## Re-look legs" in md and "## Did the observation help (ledger)" in md


def test_the_reflown_photo_doubles_the_box_and_legs_share_a_spot() -> None:
    import numpy as np

    from sightline.ml.types import Box, RawDetection

    img = np.zeros((300, 400, 3), np.uint8)
    out, nb, zoom = agent_eval.reflown(img, Box(190, 140, 200, 161), 50.0, 25.0)
    assert out.shape == img.shape and zoom == 2.0
    assert (nb[2] - nb[0], nb[3] - nb[1]) == (20, 42)
    near = RawDetection(Box(nb[0] + 2, nb[1], nb[2] + 2, nb[3]), 0.3)
    far = RawDetection(Box(5, 5, 25, 47), 0.9)
    weak = RawDetection(Box(*nb), 0.1)
    assert agent_eval.match([far, near, weak], nb, 0.15) is near
    assert agent_eval.match([far, weak], nb, 0.15) is None
    items = [
        {"photo": "a", "centre_m": (10.0, 10.0)},
        {"photo": "a", "centre_m": (14.0, 12.0)},  # within the same 20 m pattern
        {"photo": "a", "centre_m": (40.0, 10.0)},
        {"photo": "b", "centre_m": (10.0, 10.0)},
    ]
    assert agent_eval.legs_for(items, 20.0) == 3
