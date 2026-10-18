"""Integration test for the reproducible HERIDAL real-position cache builder."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from PIL import Image

from sightline.contract import Pose, Survey
from sightline.geo.detections import SIMULATED_RADIUS_M
from sightline.geo.pose import RealPoseInfo
from sightline.ml.types import Box, RawDetection
from sightline.pipeline.export import validate_cache
from sightline.pipeline.formats import write_json
from sightline.pipeline.placeholders import placeholder_detector_metrics
from sightline.pipeline.real import build_real_position_survey


class FakeDetector:
    """Return one slightly offset true-positive detection for every fixture image."""

    # Produce a deterministic box in the source image coordinate system.
    def detect_tiled(self, image: Path, conf: float = 0.05) -> list[RawDetection]:
        _ = image, conf
        return [RawDetection(Box(41, 30, 61, 45), 0.9)]


# Build a complete validated cache without network access, GPU inference, or real metadata files.
def test_build_real_position_survey_uses_pipeline_export(tmp_path: Path) -> None:
    test_dir = tmp_path / "source" / "test"
    images_dir = test_dir / "images"
    labels_dir = test_dir / "labels"
    images_dir.mkdir(parents=True)
    labels_dir.mkdir()
    metadata: dict[Path, RealPoseInfo] = {}
    for index in range(2):
        image = images_dir / f"test_SB_000{index + 1}.jpg"
        Image.new("RGB", (100, 75), (70 + index, 110, 60)).save(image)
        (labels_dir / f"{image.stem}.txt").write_text("0 0.5 0.5 0.2 0.2\n")
        metadata[image] = RealPoseInfo(
            pose=Pose(
                lat=43.37 + index * 0.0001,
                lon=17.59,
                alt_agl_m=50.0,
                heading_deg=90.0,
                gsd_m=0.02,
            ),
            pitch_deg=-90.0,
            camera_model="DJI TEST",
            nadir=True,
        )

    weights = tmp_path / "weights.pt"
    weights.write_bytes(b"fixture")
    detector_metrics = tmp_path / "detector_metrics.json"
    write_json(detector_metrics, placeholder_detector_metrics(0.29))
    data = tmp_path / "real-data"
    out = tmp_path / "cache" / "real-gps"

    result = build_real_position_survey(
        test_dir=test_dir,
        weights=weights,
        detector_metrics=detector_metrics,
        data=data,
        out=out,
        candidate_threshold=0.29,
        pose_reader=metadata.get,
        detector_factory=lambda _: FakeDetector(),
    )

    assert validate_cache(out) == []
    assert (data / "survey" / "truth.json").is_file()
    assert not any("truth" in path.name.lower() for path in out.rglob("*"))
    assert result.site_images == ("test_SB_0001.jpg", "test_SB_0002.jpg")
    assert result.pin_error.p90_m == pytest.approx(0.02)
    survey = Survey.model_validate_json((out / "survey.json").read_text())
    assert survey.simulated_path is False
    assert all(frame.pose.alt_agl_m == 50.0 for frame in survey.frames)
    manifest = json.loads((out / "manifest.json").read_text())
    assert "recorded EXIF positions" in manifest["notes"]
    assert "not absolute surveyed GPS error" in manifest["notes"]
    # Pins use the standard radius; the tiny measured box offset is reported, never used as one.
    detections = json.loads((out / "detections.json").read_text())
    radii = {d["radius_m"] for frame in detections["frames"].values() for d in frame}
    assert radii <= {SIMULATED_RADIUS_M}
    assert detections["model"] == "yolo11s-heridal-tiled-run2"
