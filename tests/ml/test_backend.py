"""LANE_A §6 test 2: make_detector picks the backend from the env and falls back to Torch with a
clear error when the ONNX is missing. No model files are loaded."""

from __future__ import annotations

from pathlib import Path

import pytest

from sightline.ml import backend


class _FakeCv:
    def __init__(self, onnx_path: Path) -> None:
        self.onnx_path = onnx_path


class _FakeTorch:
    def __init__(self, weights: Path) -> None:
        if not Path(weights).exists():
            raise FileNotFoundError(weights)
        self.weights = weights


@pytest.fixture(autouse=True)
def _fakes(monkeypatch, tmp_path):
    monkeypatch.setattr(backend, "CvDetector", _FakeCv)
    monkeypatch.setattr(backend, "Detector", _FakeTorch)
    monkeypatch.setattr(backend, "DEFAULT_ONNX", tmp_path / "missing.onnx")
    for var in ("SIGHTLINE_BACKEND", "SIGHTLINE_ONNX", "SIGHTLINE_WEIGHTS"):
        monkeypatch.delenv(var, raising=False)


@pytest.fixture
def files(tmp_path) -> tuple[Path, Path]:
    pt, onnx = tmp_path / "w.pt", tmp_path / "w.onnx"
    pt.write_bytes(b"pt")
    onnx.write_bytes(b"onnx")
    return pt, onnx


def test_cv2_is_the_default(files) -> None:
    pt, onnx = files
    det = backend.make_detector(weights=pt)
    assert isinstance(det, _FakeCv) and det.onnx_path == onnx  # found next to the weights


def test_env_picks_the_backend(files, monkeypatch) -> None:
    pt, onnx = files
    monkeypatch.setenv("SIGHTLINE_BACKEND", "torch")
    assert isinstance(backend.make_detector(weights=pt, onnx=onnx), _FakeTorch)
    monkeypatch.setenv("SIGHTLINE_BACKEND", "CV2")
    assert isinstance(backend.make_detector(weights=pt, onnx=onnx), _FakeCv)


def test_argument_beats_env(files, monkeypatch) -> None:
    pt, onnx = files
    monkeypatch.setenv("SIGHTLINE_BACKEND", "cv2")
    assert isinstance(backend.make_detector(weights=pt, onnx=onnx, backend="torch"), _FakeTorch)


def test_sightline_onnx_env_is_used(files, monkeypatch, tmp_path) -> None:
    other = tmp_path / "elsewhere.onnx"
    other.write_bytes(b"x")
    monkeypatch.setenv("SIGHTLINE_ONNX", str(other))
    assert backend.make_detector(weights=files[0]).onnx_path == other


def test_missing_onnx_falls_back_to_torch(tmp_path, caplog) -> None:
    pt = tmp_path / "only.pt"
    pt.write_bytes(b"pt")
    det = backend.make_detector(weights=pt, onnx=tmp_path / "nope.onnx")
    assert isinstance(det, _FakeTorch)
    assert "falling back to torch" in caplog.text


def test_missing_everything_is_one_clear_error(tmp_path) -> None:
    with pytest.raises(FileNotFoundError, match="fetch-model.sh") as e:
        backend.make_detector(weights=tmp_path / "no.pt", onnx=tmp_path / "no.onnx")
    assert "no.onnx" in str(e.value) and "no.pt" in str(e.value)


def test_unknown_backend_is_rejected() -> None:
    with pytest.raises(ValueError, match="SIGHTLINE_BACKEND"):
        backend.make_detector(backend="tensorrt")


def test_default_weights_onnx_is_found(files, monkeypatch) -> None:
    pt, onnx = files
    monkeypatch.setattr(backend, "DEFAULT_WEIGHTS", pt)
    assert backend.make_detector().onnx_path == onnx


def test_dynamic_export_is_preferred(files) -> None:
    pt, _ = files
    dynamic = pt.with_name("w-dynamic.onnx")
    dynamic.write_bytes(b"onnx")
    assert backend.make_detector(weights=pt).onnx_path == dynamic
