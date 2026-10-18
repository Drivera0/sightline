"""Tests for label-relative detector-pin error measurement."""

from __future__ import annotations

import pytest

from sightline.contract import Pose
from sightline.geo.position_error import measure_pin_errors
from sightline.ml.types import Box, RawDetection


# Convert matched box-centre offsets to metres and ignore low-confidence detections.
def test_measure_pin_errors_uses_true_positive_centres() -> None:
    pose = Pose(lat=43.37, lon=17.59, alt_agl_m=50.0, heading_deg=0.0, gsd_m=0.02)
    truth = [Box(100, 100, 160, 160), Box(300, 300, 360, 360)]
    detections = [
        RawDetection(Box(110, 100, 170, 160), 0.90),  # centre is 10 px = 0.2 m east
        RawDetection(Box(300, 320, 360, 380), 0.80),  # centre is 20 px = 0.4 m south
        RawDetection(Box(700, 500, 760, 560), 0.10),  # below threshold
    ]

    summary = measure_pin_errors(detections, truth, pose, threshold=0.29)

    assert summary.n_matches == 2
    assert summary.errors_m == pytest.approx((0.2, 0.4), abs=1e-6)
    assert summary.mean_m == pytest.approx(0.3)
    assert summary.median_m == pytest.approx(0.3)
    assert summary.p90_m == pytest.approx(0.38)
    assert summary.max_m == pytest.approx(0.4)


# Use greedy one-to-one VOC matching so duplicate predictions do not double-count a label.
def test_measure_pin_errors_matches_each_label_once() -> None:
    pose = Pose(lat=43.37, lon=17.59, alt_agl_m=50.0, heading_deg=0.0, gsd_m=0.02)
    truth = [Box(100, 100, 160, 160)]
    detections = [
        RawDetection(Box(100, 100, 160, 160), 0.95),
        RawDetection(Box(102, 102, 162, 162), 0.90),
    ]

    summary = measure_pin_errors(detections, truth, pose, threshold=0.29)

    assert summary.n_matches == 1
    assert summary.errors_m == (0.0,)


# Return an explicit empty result rather than inventing a radius without true-positive matches.
def test_measure_pin_errors_handles_no_matches() -> None:
    pose = Pose(lat=43.37, lon=17.59, alt_agl_m=50.0, heading_deg=0.0, gsd_m=0.02)

    summary = measure_pin_errors(
        [RawDetection(Box(500, 500, 560, 560), 0.9)],
        [Box(100, 100, 160, 160)],
        pose,
        threshold=0.29,
    )

    assert summary.n_matches == 0
    assert summary.p90_m is None
