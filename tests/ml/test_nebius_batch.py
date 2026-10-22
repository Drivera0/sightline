"""scripts/nebius_batch_detect.py: folder in, detections_raw.json out (fake detector)."""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

from sightline.ml.types import Box, RawDetection

_PATH = Path(__file__).resolve().parents[2] / "scripts" / "nebius_batch_detect.py"
_spec = importlib.util.spec_from_file_location("nebius_batch_detect", _PATH)
assert _spec and _spec.loader
batch = importlib.util.module_from_spec(_spec)
sys.modules["nebius_batch_detect"] = batch
_spec.loader.exec_module(batch)


class _Fake:
    def detect_tiled(self, image: Path, conf: float = 0.05) -> list[RawDetection]:
        return [RawDetection(Box(1, 1, 5, 5), 0.2), RawDetection(Box(10, 10, 30, 50), 0.912345)]


def test_writes_run_survey_format_sorted_by_conf(tmp_path: Path) -> None:
    for name in ("b.jpg", "a.JPG", "notes.txt"):
        (tmp_path / name).write_bytes(b"x")
    doc = batch.detect_folder(_Fake(), tmp_path)
    assert list(doc["frames"]) == ["a", "b"]  # JPEGs only, by name
    assert doc["frames"]["a"][0] == {"box": [10, 10, 30, 50], "conf": 0.912}
    assert doc["candidate_threshold"] == 0.29 and doc["save_threshold"] == 0.05
    json.dumps(doc)


def test_empty_folder_is_an_error(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        batch.detect_folder(_Fake(), tmp_path)


def test_results_round_trip_through_the_job_logs(tmp_path: Path, monkeypatch, capsys) -> None:
    """--print-results puts both files in the logs; deploy/nebius/collect.py reads them back,
    even with a timestamp before each log line."""
    import subprocess

    photos = tmp_path / "in"
    photos.mkdir()
    (photos / "a.jpg").write_bytes(b"x")
    monkeypatch.setattr(
        "sightline.ml.detect_cv.CvDetector", lambda *a, **k: type("D", (_Fake,), {"rect": True})()
    )
    assert (
        batch.main([str(photos), str(tmp_path / "out"), "--onnx", "m.onnx", "--print-results"]) == 0
    )
    logs = "".join(
        f"2026-10-22T03:00:00Z {line}\n" for line in capsys.readouterr().out.splitlines()
    )
    collect = Path(__file__).resolve().parents[2] / "deploy" / "nebius" / "collect.py"
    r = subprocess.run(
        [sys.executable, str(collect), str(tmp_path / "back")],
        input=logs,
        check=False,
        text=True,
        capture_output=True,
    )
    assert r.returncode == 0, r.stderr
    for name in ("detections_raw.json", "job_summary.json"):
        assert json.loads((tmp_path / "back" / name).read_text()) == json.loads(
            (tmp_path / "out" / name).read_text()
        )
