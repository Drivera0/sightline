"""Measure detector-pin offsets against georeferenced HERIDAL label centres."""

from __future__ import annotations

import math
import statistics
from dataclasses import dataclass

from sightline.contract import Pose
from sightline.ml.evaluate import iou
from sightline.ml.types import Box, RawDetection

VOC_IOU = 0.5


@dataclass(frozen=True)
class PinErrorSummary:
    """Label-relative offsets for true-positive detections in metres."""

    errors_m: tuple[float, ...]
    mean_m: float | None
    median_m: float | None
    p90_m: float | None
    max_m: float | None

    # Count the true-positive detector/label pairs included in the statistics.
    @property
    def n_matches(self) -> int:
        """Return the number of matched detector/label pairs in the summary."""
        return len(self.errors_m)


# Match predictions to labels using Lane A's VOC rule and measure their centre offsets on ground.
def measure_pin_errors(
    detections: list[RawDetection],
    truth: list[Box],
    pose: Pose,
    *,
    threshold: float,
    iou_threshold: float = VOC_IOU,
) -> PinErrorSummary:
    """Measure georeferenced centre error for confidence-filtered, one-to-one true positives."""
    if not 0 <= threshold <= 1:
        raise ValueError("threshold must be between 0 and 1")
    if not 0 < iou_threshold <= 1:
        raise ValueError("iou_threshold must be between 0 and 1")

    unused = set(range(len(truth)))
    errors: list[float] = []
    for detection in sorted(detections, key=lambda item: item.conf, reverse=True):
        if detection.conf < threshold:
            continue
        candidates = [(iou(detection.box, truth[index]), index) for index in sorted(unused)]
        if not candidates:
            continue
        best_iou, best_index = max(candidates, key=lambda item: (item[0], -item[1]))
        if best_iou < iou_threshold:
            continue
        unused.remove(best_index)
        errors.append(_box_centre_error_m(detection.box, truth[best_index], pose))
    return summarize_pin_errors(errors)


# Combine per-photo offsets into one transparent dataset-level statistical summary.
def summarize_pin_errors(errors_m: list[float]) -> PinErrorSummary:
    """Calculate mean, median, linear-interpolated p90, and maximum error."""
    if any(error < 0 or not math.isfinite(error) for error in errors_m):
        raise ValueError("errors_m must contain finite non-negative values")
    values = tuple(errors_m)
    if not values:
        return PinErrorSummary(values, None, None, None, None)
    ordered = sorted(values)
    return PinErrorSummary(
        errors_m=values,
        mean_m=statistics.fmean(values),
        median_m=statistics.median(values),
        p90_m=_percentile(ordered, 0.90),
        max_m=max(values),
    )


# Convert the box-centre pixel offset with the same GSD used by the projection model.
def _box_centre_error_m(prediction: Box, label: Box, pose: Pose) -> float:
    prediction_u, prediction_v = prediction.center
    label_u, label_v = label.center
    return math.hypot(prediction_u - label_u, prediction_v - label_v) * pose.gsd_m


# Calculate a linear-interpolated percentile using the inclusive endpoint convention.
def _percentile(ordered: list[float], quantile: float) -> float:
    position = (len(ordered) - 1) * quantile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    weight = position - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight
