"""scripts/reproduce_cv2.py end to end on three demo-cache frames: a fake network (one box at the
centre of every slice) by default, the real ONNX too when it has been downloaded."""

from __future__ import annotations

import importlib.util
import json
import shutil
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

ROOT = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("reproduce_cv2", ROOT / "scripts/reproduce_cv2.py")
assert _spec and _spec.loader
repro = importlib.util.module_from_spec(_spec)
sys.modules["reproduce_cv2"] = repro
_spec.loader.exec_module(repro)

FRAMES = ROOT / "cache/sample/frames"
REAL_ONNX = ROOT / "data/weights/release_v2/sightline-detector-v2.onnx"
# The fake box on a 1000x750 frame lands at (490, 355)-(510, 395): see test_detect_cv.py.
LABELS = {
    "f0001": "0 0.5 0.5 0.02 0.0533333\n",  # the fake box: a true positive
    "f0002": "0 0.1 0.1 0.02 0.0533333\n",  # far from it: a miss, and the fake box is a false alarm
    "f0003": "",  # nobody: the fake box is a false alarm
}


class _FakeNet:
    def __init__(self) -> None:
        self.blob: np.ndarray | None = None

    def setInput(self, blob: np.ndarray) -> None:
        self.blob = blob

    def forward(self) -> np.ndarray:
        out = np.zeros((1, 5, 2), np.float32)
        out[0, :, 0] = [512, 512, 20, 40, 0.9]
        return out


@pytest.fixture
def split(tmp_path: Path) -> Path:
    """A three-photo ``test`` split in YOLO layout, from the demo cache's frames."""
    root = tmp_path / "yolo"
    (root / "test/images").mkdir(parents=True)
    (root / "test/labels").mkdir(parents=True)
    for stem, label in LABELS.items():
        shutil.copy(FRAMES / f"{stem}.jpg", root / f"test/images/{stem}.jpg")
        (root / f"test/labels/{stem}.txt").write_text(label, encoding="utf-8")
    return root


def _expected(tmp_path: Path, voc: dict[str, float], n: int = 3) -> Path:
    path = tmp_path / "detector_metrics.json"
    detector = {"test_images": n, "threshold": 0.29, "voc": voc}
    path.write_text(json.dumps({"detector": detector}), encoding="utf-8")
    return path


def _run(split: Path, onnx: Path, expected: Path, *extra: str) -> int:
    return repro.main(
        [
            "--data-root", str(split), "--onnx", str(onnx), "--expected", str(expected),
            "--workers", "1", "--threads", "2", *extra,
        ]
    )  # fmt: skip


@pytest.fixture
def fake_onnx(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    monkeypatch.setattr(cv2.dnn, "readNetFromONNX", lambda _: _FakeNet())
    onnx = tmp_path / "m.onnx"
    onnx.write_bytes(b"")
    return onnx


def test_matching_numbers_exit_zero(split, fake_onnx, tmp_path, capsys) -> None:
    # Three boxes at conf 0.9: one hit out of two people; AP = 0.5 (recall 0.5 at precision 1).
    want = _expected(tmp_path, {"precision": 0.333, "recall": 0.5, "ap50": 0.5})
    assert _run(split, fake_onnx, want) == 0
    out = capsys.readouterr().out
    assert "VOC  P=0.333 R=0.500 AP50=0.500" in out
    assert "MATCH" in out and "MISMATCH" not in out
    assert "wall time" in out and "logical CPUs" in out


def test_a_mismatch_exits_one(split, fake_onnx, tmp_path, capsys) -> None:
    want = _expected(tmp_path, {"precision": 0.333, "recall": 0.51, "ap50": 0.5})
    assert _run(split, fake_onnx, want) == 1
    assert "recall    0.500 vs 0.510 (MISMATCH)" in capsys.readouterr().out


def test_a_different_photo_count_exits_one(split, fake_onnx, tmp_path) -> None:
    want = _expected(tmp_path, {"precision": 0.333, "recall": 0.5, "ap50": 0.5}, n=101)
    assert _run(split, fake_onnx, want) == 1


def test_subset_is_a_smoke_check_not_compared(split, fake_onnx, tmp_path, capsys) -> None:
    want = _expected(tmp_path, {"precision": 0.9, "recall": 0.9, "ap50": 0.9})
    assert _run(split, fake_onnx, want, "--subset", "2") == 0
    out = capsys.readouterr().out
    assert "2 test photos" in out and "smoke check only" in out


def test_missing_model_exits_two(split, tmp_path) -> None:
    want = _expected(tmp_path, {"precision": 0, "recall": 0, "ap50": 0})
    assert _run(split, tmp_path / "absent.onnx", want) == 2


def test_default_workers_leave_threads_for_each() -> None:
    assert repro.default_workers(32) == 4
    assert repro.default_workers(4) == 2
    assert repro.default_workers(1) == 1


@pytest.mark.skipif(not REAL_ONNX.exists(), reason="model-onnx-v2 not downloaded")
def test_real_model_runs_on_demo_frames(split, tmp_path, capsys) -> None:
    want = _expected(tmp_path, {"precision": 0, "recall": 0, "ap50": 0})
    assert _run(split, REAL_ONNX, want, "--subset", "3") == 0
    assert "VOC  P=" in capsys.readouterr().out
