"""The video's recall shot (scripts/demo_video): guarded on the API's conditions override, labelled
without "clear"; the Nebius cut has the fleet beat. No browser, no server."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

VIDEO = Path(__file__).resolve().parents[2] / "scripts/demo_video"


def _record():
    name = "demo_video_record"
    if name not in sys.modules:  # dataclasses look their module up in sys.modules
        spec = importlib.util.spec_from_file_location(name, VIDEO / "record.py")
        sys.modules[name] = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(sys.modules[name])
    return sys.modules[name]


def test_the_recall_shot_runs_only_when_the_api_has_the_override() -> None:
    record = _record()
    with_it = {"paths": {record.OVERRIDE_PATH: {"post": {}}}}
    assert record.recall_guard("http://api", lambda url: with_it) is None
    reason = record.recall_guard("http://api", lambda url: {"paths": {}})
    assert reason and "override" in reason

    def down(url: str) -> dict:
        raise OSError("refused")

    assert "no API schema" in record.recall_guard("http://api", down)


def test_the_recall_shot_has_a_label_and_the_nebius_cut_has_the_fleet_beat() -> None:
    yaml = pytest.importorskip("yaml")  # the video extra; CI runs without it
    cfg = yaml.safe_load((VIDEO / "captions.yaml").read_text())
    label = cfg["labels"]["recall"]["text"].lower()
    assert "clear" not in label and "simulated" not in label
    # shot list v2: the fleet's lost link and relay come from the demo mission (no API), longer in the
    # Nebius cut; the live recall stays a --live extra
    segs = [s if isinstance(s, str) else s.get("shot") for s in cfg["cuts"]["nebius"]["segments"]]
    assert segs.index("run") < segs.index("fleet") < segs.index("radio") < segs.index("find")


def test_the_override_route_the_guard_looks_for_is_the_api_s() -> None:
    from sightline.api.missions import missions_router

    assert _record().OVERRIDE_PATH in {r.path for r in missions_router.routes}
