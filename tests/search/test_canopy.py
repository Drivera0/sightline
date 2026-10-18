"""Tests for the per-pixel canopy classifier and its threshold tuner (LANE_C §3.3, §6.2, §7.7)."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from sightline.search.canopy import (
    canopy_features,
    canopy_fraction,
    canopy_mask,
    mask_from_features,
)
from sightline.search.tune_canopy import REPORT_NAME, TuneResult, main, tune

H_PX, W_PX = 60, 80


def _solid(rgb: tuple[int, int, int], h_px: int = H_PX, w_px: int = W_PX) -> np.ndarray:
    image = np.zeros((h_px, w_px, 3), dtype=np.uint8)
    image[:, :] = rgb
    return image


def _noisy(mean_rgb: tuple[int, int, int], sigma: float, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    base = np.array(mean_rgb, dtype=np.float64)
    # One shared brightness noise per pixel keeps the hue (chromaticity) roughly fixed.
    brightness = rng.normal(0.0, sigma, size=(H_PX, W_PX, 1))
    return np.clip(base + brightness * base / base.mean(), 0, 255).astype(np.uint8)


def test_mask_dtype_and_shape() -> None:
    mask = canopy_mask(_solid((40, 160, 40)))
    assert mask.dtype == np.bool_
    assert mask.shape == (H_PX, W_PX)


def test_flat_green_is_not_canopy() -> None:
    assert canopy_fraction(_solid((60, 170, 50))) == pytest.approx(0.0)


def test_black_is_canopy_shadow() -> None:
    assert canopy_fraction(_solid((0, 0, 0))) == pytest.approx(1.0)


def test_noisy_green_is_canopy() -> None:
    assert canopy_fraction(_noisy((70, 150, 60), sigma=40.0, seed=7)) > 0.8


def test_noisy_bright_grey_is_not_canopy() -> None:
    assert canopy_fraction(_noisy((180, 180, 180), sigma=40.0, seed=7)) < 0.1


def test_mask_restricts_average() -> None:
    image = _solid((60, 170, 50))
    image[:, : W_PX // 2] = 0
    left = np.zeros((H_PX, W_PX), dtype=bool)
    left[:, : W_PX // 2] = True
    assert canopy_fraction(image, left) == pytest.approx(1.0)
    # Keep the right mask away from the black edge, where the 7×7 window sees texture.
    right = np.zeros((H_PX, W_PX), dtype=bool)
    right[:, W_PX // 2 + 4 :] = True
    assert canopy_fraction(image, right) == pytest.approx(0.0)


def test_empty_mask_raises() -> None:
    with pytest.raises(ValueError):
        canopy_fraction(_solid((0, 0, 0)), np.zeros((H_PX, W_PX), dtype=bool))


def test_mask_shape_mismatch_raises() -> None:
    with pytest.raises(ValueError):
        canopy_fraction(_solid((0, 0, 0)), np.ones((H_PX, W_PX + 1), dtype=bool))


def test_thresholds_pass_through() -> None:
    image = _solid((50, 50, 50))  # shadow at the default threshold (60), not at 40
    assert canopy_fraction(image) == pytest.approx(1.0)
    assert canopy_fraction(image, shadow_thr=40) == pytest.approx(0.0)


def test_cached_features_match_mask() -> None:
    image = _noisy((90, 140, 70), sigma=25.0, seed=3)
    features = canopy_features(image)
    for exg_thr, std_thr, shadow_thr in [(0.04, 12.0, 60), (0.0, 6.0, 80), (0.1, 20.0, 40)]:
        expected = canopy_mask(image, exg_thr, std_thr, shadow_thr)
        actual = mask_from_features(features, exg_thr, std_thr, shadow_thr)
        np.testing.assert_array_equal(actual, expected)


def test_tune_perfect_on_black_and_flat_green() -> None:
    images = [_solid((0, 0, 0))] * 3 + [_solid((60, 170, 50))] * 3
    labels = [1.0] * 3 + [0.0] * 3
    result = tune(images, labels)
    assert isinstance(result, TuneResult)
    assert result.best_mae == pytest.approx(0.0)
    assert result.default_mae == pytest.approx(0.0)
    assert len(result.best_predictions) == 6
    assert len(result.default_predictions) == 6


def test_tune_finds_better_shadow_threshold() -> None:
    # Dark grey (max channel 70) is labelled canopy: only shadow_thr = 80 gets it right.
    images = [_solid((70, 70, 70))] * 3 + [_solid((60, 170, 50))] * 3
    labels = [1.0] * 3 + [0.0] * 3
    result = tune(images, labels)
    assert result.default_mae == pytest.approx(0.5)
    assert result.best_mae == pytest.approx(0.0)
    assert result.best_thresholds["shadow_thr"] == 80


def test_tune_length_mismatch_raises() -> None:
    with pytest.raises(ValueError):
        tune([_solid((0, 0, 0))], [1.0, 0.0])


def _write_labels(tmp_path: Path, labels: list[float | None]) -> Path:
    frames = []
    for i, label in enumerate(labels):
        colour = (0, 0, 0) if label == 1.0 else (60, 170, 50)
        name = f"img{i}.png"
        Image.fromarray(_solid(colour, 40, 50)).save(tmp_path / name)
        frames.append(
            {
                "id": f"c{i:02d}",
                "image": name,
                "x0": 5,
                "y0": 5,
                "width_px": 30,
                "height_px": 20,
                "canopy": label,
            }
        )
    path = tmp_path / "canopy_labels.json"
    path.write_text(json.dumps({"version": 1, "note": "test", "frames": frames}))
    return path


def test_main_too_few_labels_exits_1(tmp_path: Path) -> None:
    labels_path = _write_labels(tmp_path, [1.0, 0.0, None, None, None, 1.0])
    code = main(["--labels", str(labels_path), "--repo-root", str(tmp_path), "--write-report"])
    assert code == 1
    assert not (tmp_path / REPORT_NAME).exists()


def test_main_writes_report_only_with_flag(tmp_path: Path) -> None:
    labels_path = _write_labels(tmp_path, [1.0, 1.0, 1.0, 0.0, 0.0, None, 0.0])
    args = ["--labels", str(labels_path), "--repo-root", str(tmp_path)]
    assert main(args) == 0
    assert not (tmp_path / REPORT_NAME).exists()
    assert main([*args, "--write-report"]) == 0
    report = (tmp_path / REPORT_NAME).read_text()
    assert "Labelled frames: 6" in report
    assert "Best MAE: 0.0000" in report
    assert "by eye" in report
