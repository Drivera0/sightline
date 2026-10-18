"""Tests for the canopy labelling helper (no data/, no network)."""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from sightline.search.label_canopy import (
    NOTE,
    Crop,
    build_labels,
    crop_has_person,
    crop_origins,
    crop_stats,
    has_labels,
    person_centres,
    select_crops,
    write_labels,
)


def _random_stats(n: int = 60, seed: int = 0) -> tuple[np.ndarray, list[str]]:
    rng = np.random.default_rng(seed)
    stats = rng.random((n, 3))
    groups = [f"img{i // 4}" for i in range(n)]
    return stats, groups


def test_crop_origins_full_and_short_images() -> None:
    assert len(crop_origins(4000, 3000)) == 16
    origins = crop_origins(4000, 2250)
    assert len(origins) == 12
    assert max(y for _, y in origins) == 1500
    assert origins[0] == (0, 0) and origins[1] == (1000, 0)


def test_person_centres_and_crop_check(tmp_path: Path) -> None:
    label = tmp_path / "a.txt"
    label.write_text("0 0.3 0.1 0.01 0.01\n")
    centres = person_centres(label, 4000, 3000)
    assert centres == [pytest.approx((1200.0, 300.0))]
    assert crop_has_person(1000, 0, 1000, 750, centres)
    assert not crop_has_person(0, 0, 1000, 750, centres)
    assert person_centres(tmp_path / "missing.txt", 4000, 3000) == []


def test_crop_stats_green_dark_and_texture() -> None:
    green = np.zeros((20, 20, 3), dtype=np.uint8)
    green[..., 1] = 200
    exg, dark, tex = crop_stats(green)
    assert exg == pytest.approx(2.0)
    assert dark == 0.0
    assert tex == 0.0

    black = np.zeros((20, 20, 3), dtype=np.uint8)
    assert crop_stats(black)[1] == 1.0

    rng = np.random.default_rng(1)
    noisy = rng.integers(0, 256, (20, 20, 3), dtype=np.uint8)
    assert crop_stats(noisy)[2] > 20.0


def test_select_is_deterministic_and_counts() -> None:
    stats, groups = _random_stats()
    a = select_crops(stats, groups, count=10, seed=7)
    b = select_crops(stats, groups, count=10, seed=7)
    assert a == b
    assert len(a) == 10 and len(set(a)) == 10


def test_select_respects_per_image_cap() -> None:
    stats, groups = _random_stats()
    picks = select_crops(stats, groups, count=20, max_per_group=2, seed=3)
    counts: dict[str, int] = {}
    for i in picks:
        counts[groups[i]] = counts.get(groups[i], 0) + 1
    assert max(counts.values()) <= 2


def test_select_skips_excluded_rows() -> None:
    stats, groups = _random_stats()
    exclude = [i % 2 == 0 for i in range(len(groups))]
    picks = select_crops(stats, groups, count=10, exclude=exclude, seed=7)
    assert all(not exclude[i] for i in picks)


def test_select_spreads_over_extremes() -> None:
    # Two tight clusters plus an outlier; farthest-point must visit all three.
    stats = np.array([[0, 0, 0]] * 5 + [[1, 1, 1]] * 5 + [[0, 1, 0]], dtype=float)
    stats += np.arange(11)[:, None] * 1e-6
    groups = [str(i) for i in range(11)]
    picks = select_crops(stats, groups, count=3, seed=0)
    assert any(p < 5 for p in picks) and any(5 <= p < 10 for p in picks)


def test_select_raises_when_too_few() -> None:
    stats, groups = _random_stats(n=8)
    with pytest.raises(ValueError):
        select_crops(stats, groups, count=5, max_per_group=2, seed=7)


def test_build_labels_format() -> None:
    crops = [Crop("data/x/a.jpg", 0, 0), Crop("data/x/b.jpg", 1000, 750)]
    doc = build_labels(crops)
    assert doc["version"] == 1 and doc["note"] == NOTE
    assert [f["id"] for f in doc["frames"]] == ["c01", "c02"]
    assert doc["frames"][1] == {
        "id": "c02",
        "image": "data/x/b.jpg",
        "x0": 1000,
        "y0": 750,
        "width_px": 1000,
        "height_px": 750,
        "canopy": None,
    }


def test_write_labels_protects_human_scores(tmp_path: Path) -> None:
    path = tmp_path / "labels.json"
    doc = build_labels([Crop("data/x/a.jpg", 0, 0)])
    write_labels(path, doc)
    assert json.loads(path.read_text()) == doc
    write_labels(path, doc)  # all null: overwrite is fine

    filled = json.loads(path.read_text())
    filled["frames"][0]["canopy"] = 0.5
    path.write_text(json.dumps(filled))
    assert has_labels(path)
    with pytest.raises(FileExistsError):
        write_labels(path, doc)
    assert json.loads(path.read_text())["frames"][0]["canopy"] == 0.5
    write_labels(path, doc, force=True)
    assert not has_labels(path)
