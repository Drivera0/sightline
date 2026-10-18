"""Device choice for Detector (cuda, then mps, then cpu) without needing torch installed."""

from __future__ import annotations

import sys
import types

import pytest

from sightline.ml.detect import resolve_device


def _fake_torch(cuda: bool, mps: bool | None) -> types.ModuleType:
    torch = types.ModuleType("torch")
    torch.cuda = types.SimpleNamespace(is_available=lambda: cuda)  # type: ignore[attr-defined]
    backends = types.SimpleNamespace()
    if mps is not None:
        backends.mps = types.SimpleNamespace(is_available=lambda: mps)
    torch.backends = backends  # type: ignore[attr-defined]
    return torch


@pytest.mark.parametrize(
    ("cuda", "mps", "expected"),
    [(True, True, "cuda:0"), (False, True, "mps"), (False, False, "cpu"), (False, None, "cpu")],
)
def test_auto_picks_cuda_then_mps_then_cpu(
    monkeypatch: pytest.MonkeyPatch, cuda: bool, mps: bool | None, expected: str
) -> None:
    monkeypatch.setitem(sys.modules, "torch", _fake_torch(cuda, mps))
    assert resolve_device("auto") == expected


def test_explicit_device_is_kept(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "torch", _fake_torch(True, True))
    assert resolve_device("cpu") == "cpu"
    assert resolve_device("cuda:1") == "cuda:1"
