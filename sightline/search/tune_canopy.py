"""Tune the canopy classifier thresholds against hand-labelled frames (LANE_C_SEARCH §6.2).

Usage: uv run python -m sightline.search.tune_canopy [--labels PATH] [--write-report]

Grid-searches ``exg_thr``, ``std_thr`` and ``shadow_thr`` and keeps the set with the
lowest mean absolute error against the by-eye canopy labels. Without
``--write-report`` nothing is written.
"""

from __future__ import annotations

import argparse
import datetime as dt
import itertools
import json
import sys
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image

from sightline.search.canopy import (
    DEFAULT_EXG_THR,
    DEFAULT_SHADOW_THR,
    DEFAULT_STD_THR,
    CanopyFeatures,
    canopy_features,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_LABELS_PATH = REPO_ROOT / "tests" / "search" / "fixtures" / "canopy_labels.json"
REPORT_NAME = "canopy_report.md"
MIN_LABELLED = 5


@dataclass(frozen=True)
class ThresholdGrid:
    """Values tried for each threshold. The defaults are included so they can win ties."""

    exg_thr: tuple[float, ...] = (0.0, 0.02, 0.04, 0.06, 0.08, 0.1)
    std_thr: tuple[float, ...] = (6.0, 8.0, 10.0, 12.0, 15.0, 20.0)
    shadow_thr: tuple[int, ...] = (40, 50, 60, 70, 80)


@dataclass(frozen=True)
class TuneResult:
    """Best thresholds, their MAE, and the MAE of the default thresholds."""

    best_thresholds: dict[str, float]
    best_mae: float
    best_predictions: list[float]
    default_thresholds: dict[str, float]
    default_mae: float
    default_predictions: list[float]
    n_combinations: int = field(default=0)


def _fraction_table(
    features: CanopyFeatures, grid: ThresholdGrid
) -> dict[tuple[float, float, int], float]:
    """Canopy fraction of one image for every threshold combination."""
    green = {e: features.exg > e for e in grid.exg_thr}
    textured = {s: features.local_std > s for s in grid.std_thr}
    shadow = {h: features.max_channel < h for h in grid.shadow_thr}
    table: dict[tuple[float, float, int], float] = {}
    for e, s in itertools.product(grid.exg_thr, grid.std_thr):
        green_textured = green[e] & textured[s]
        for h in grid.shadow_thr:
            table[(e, s, h)] = float((green_textured | shadow[h]).mean())
    return table


def tune(
    images: Sequence[np.ndarray],
    labels: Sequence[float],
    grid: ThresholdGrid | None = None,
) -> TuneResult:
    """Grid-search the thresholds that minimise mean absolute error against ``labels``.

    ``images`` are uint8 H×W×3 RGB arrays; ``labels`` are canopy fractions in [0, 1].
    Ties keep the default thresholds, then the first combination in grid order.
    """
    if len(images) != len(labels):
        raise ValueError(f"{len(images)} images but {len(labels)} labels")
    if not images:
        raise ValueError("need at least one labelled image")
    grid = grid or ThresholdGrid()
    default_key = (DEFAULT_EXG_THR, DEFAULT_STD_THR, DEFAULT_SHADOW_THR)
    grid_with_default = ThresholdGrid(
        exg_thr=tuple(sorted({*grid.exg_thr, default_key[0]})),
        std_thr=tuple(sorted({*grid.std_thr, default_key[1]})),
        shadow_thr=tuple(sorted({*grid.shadow_thr, default_key[2]})),
    )
    tables = [_fraction_table(canopy_features(image), grid_with_default) for image in images]
    truth = np.asarray(labels, dtype=np.float64)

    def predictions(key: tuple[float, float, int]) -> list[float]:
        return [table[key] for table in tables]

    def mae(key: tuple[float, float, int]) -> float:
        return float(np.mean(np.abs(np.asarray(predictions(key)) - truth)))

    default_mae = mae(default_key)
    best_key, best_mae = default_key, default_mae
    combinations = list(itertools.product(grid.exg_thr, grid.std_thr, grid.shadow_thr))
    for key in combinations:
        score = mae(key)
        if score < best_mae - 1e-12:
            best_key, best_mae = key, score

    def as_dict(key: tuple[float, float, int]) -> dict[str, float]:
        return {"exg_thr": key[0], "std_thr": key[1], "shadow_thr": key[2]}

    return TuneResult(
        best_thresholds=as_dict(best_key),
        best_mae=best_mae,
        best_predictions=predictions(best_key),
        default_thresholds=as_dict(default_key),
        default_mae=default_mae,
        default_predictions=predictions(default_key),
        n_combinations=len(combinations),
    )


def _load_crop(repo_root: Path, frame: dict) -> np.ndarray:
    path = repo_root / frame["image"]
    with Image.open(path) as image:
        rgb = np.asarray(image.convert("RGB"), dtype=np.uint8)
    y0, x0 = int(frame["y0"]), int(frame["x0"])
    crop = rgb[y0 : y0 + int(frame["height_px"]), x0 : x0 + int(frame["width_px"])]
    if crop.size == 0:
        raise ValueError(f"empty crop for frame {frame['id']} in {path}")
    return crop


def _per_image_rows(
    ids: Sequence[str], labels: Sequence[float], result: TuneResult
) -> list[tuple[str, float, float, float]]:
    return [
        (frame_id, label, default, best)
        for frame_id, label, default, best in zip(
            ids, labels, result.default_predictions, result.best_predictions, strict=True
        )
    ]


def _format_thresholds(thresholds: dict[str, float]) -> str:
    return ", ".join(f"{name}={value:g}" for name, value in thresholds.items())


def _render_report(
    ids: Sequence[str], labels: Sequence[float], result: TuneResult, today: dt.date
) -> str:
    lines = [
        "# Canopy classifier tuning report",
        "",
        f"- Date: {today.isoformat()}",
        f"- Labelled frames: {len(labels)}",
        f"- Combinations tried: {result.n_combinations}",
        f"- Best thresholds: {_format_thresholds(result.best_thresholds)}",
        f"- Best MAE: {result.best_mae:.4f}",
        f"- Default thresholds: {_format_thresholds(result.default_thresholds)}",
        f"- Default MAE: {result.default_mae:.4f}",
        "",
        "Caveat: the labels are by eye, on a 5-step scale (0, 0.25, 0.5, 0.75, 1), by one",
        "person, on a small set of 1000×750 crops. The thresholds were tuned on the same",
        "frames that give the MAE, so the MAE is optimistic.",
        "",
        "| id | label | default | best |",
        "|---|---|---|---|",
    ]
    for frame_id, label, default, best in _per_image_rows(ids, labels, result):
        lines.append(f"| {frame_id} | {label:.2f} | {default:.3f} | {best:.3f} |")
    return "\n".join(lines) + "\n"


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--labels", type=Path, default=DEFAULT_LABELS_PATH, help="Labels JSON.")
    parser.add_argument(
        "--repo-root", type=Path, default=REPO_ROOT, help="Image paths are relative to this."
    )
    parser.add_argument(
        "--write-report",
        action="store_true",
        help=f"Write {REPORT_NAME} next to the labels file.",
    )
    args = parser.parse_args(argv)

    labels_doc = json.loads(args.labels.read_text())
    frames = [frame for frame in labels_doc["frames"] if frame.get("canopy") is not None]
    if len(frames) < MIN_LABELLED:
        print(
            f"Only {len(frames)} labelled frame(s) in {args.labels}; need at least "
            f"{MIN_LABELLED}. Set 'canopy' on more frames and run again. Nothing written.",
            file=sys.stderr,
        )
        return 1

    ids = [str(frame["id"]) for frame in frames]
    labels = [float(frame["canopy"]) for frame in frames]
    images = [_load_crop(args.repo_root, frame) for frame in frames]
    result = tune(images, labels)

    print(f"Labelled frames: {len(frames)}  (combinations tried: {result.n_combinations})")
    print(f"Best thresholds:    {_format_thresholds(result.best_thresholds)}")
    print(f"Best MAE:           {result.best_mae:.4f}")
    print(f"Default thresholds: {_format_thresholds(result.default_thresholds)}")
    print(f"Default MAE:        {result.default_mae:.4f}")
    print()
    print(f"{'id':<8}{'label':>8}{'default':>10}{'best':>8}")
    for frame_id, label, default, best in _per_image_rows(ids, labels, result):
        print(f"{frame_id:<8}{label:>8.2f}{default:>10.3f}{best:>8.3f}")

    if args.write_report:
        report_path = args.labels.parent / REPORT_NAME
        report_path.write_text(_render_report(ids, labels, result, dt.date.today()))
        print(f"\nWrote {report_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
