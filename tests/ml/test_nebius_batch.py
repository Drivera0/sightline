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
