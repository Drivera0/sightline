"""Build the HERIDAL real-position survey through the normal validated pipeline export."""

from __future__ import annotations

import json
import shutil
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from PIL import Image

from sightline.contract import LatLon, Pose
from sightline.geo.pose import RealPoseInfo, read_pose
from sightline.geo.position_error import PinErrorSummary, measure_pin_errors, summarize_pin_errors
from sightline.geo.project import footprint, pixel_to_latlon
from sightline.geo.real import RealPhoto, cluster_real_photos, select_real_photos
from sightline.ml.crops import make_crop
from sightline.ml.data import load_split
from sightline.ml.detect import Detector
from sightline.ml.types import Box, LabeledImage, RawDetection
from sightline.pipeline.formats import (
    DetectConfig,
    DetectorMetricsFile,
    GeoDetection,
    GeoFile,
    PlacedFrame,
    PlaceFile,
    RawDetectionEntry,
    RawDetectionsFile,
    SurveyFrameEntry,
    SurveyFrameFile,
    read_json,
    write_json,
)
from sightline.pipeline.runner import current_git_sha
from sightline.pipeline.stages import Context, export_stage, map_stage, metrics_stage, rank_stage

FRAME_W_PX = 1000
FRAME_H_PX = 750
SAVE_THRESHOLD = 0.05


class TiledDetector(Protocol):
    """Small detector interface used by the real-survey builder and its CPU tests."""

    # Run native-resolution tiled inference and return boxes in source-image pixels.
    def detect_tiled(self, image: Path, conf: float = SAVE_THRESHOLD) -> list[RawDetection]: ...


@dataclass(frozen=True)
class RealSurveyResult:
    """Counts and measured error produced alongside a validated real-position cache."""

    cache: Path
    site_images: tuple[str, ...]
    photos_with_complete_pose: int
    photos_nadir: int
    photos_oblique: int
    photos_missing_pose: int
    labelled_people: int
    pin_error: PinErrorSummary


# Build and validate a real-position cache from HERIDAL photos, labels, pose metadata, and weights.
def build_real_position_survey(
    *,
    test_dir: Path,
    weights: Path,
    detector_metrics: Path,
    data: Path,
    out: Path,
    web_out: Path | None = None,
    candidate_threshold: float = 0.29,
    model_name: str = "yolo11s-heridal-tiled",
    max_site_separation_m: float = 500.0,
    pose_reader: Callable[[Path], RealPoseInfo | None] = read_pose,
    detector_factory: Callable[[Path], TiledDetector] = Detector,
) -> RealSurveyResult:
    """Evaluate every nadir pose, then export the largest coherent site through Lane D."""
    if not weights.is_file():
        raise FileNotFoundError(weights)
    metrics = read_json(detector_metrics, DetectorMetricsFile)
    if metrics.detector.threshold != candidate_threshold:
        raise ValueError(
            f"detector metrics threshold {metrics.detector.threshold} does not match "
            f"candidate threshold {candidate_threshold}"
        )

    labelled_images = load_split("test", root=test_dir.parent)
    labelled_by_path = {image.path: image for image in labelled_images}
    selection = select_real_photos(labelled_by_path, pose_reader=pose_reader)
    if not selection.accepted:
        raise ValueError("no photos have a complete nadir pose")
    clusters = cluster_real_photos(
        selection.accepted,
        max_separation_m=max_site_separation_m,
    )
    site = clusters[0]

    detector = detector_factory(weights)
    predictions: dict[Path, list[RawDetection]] = {}
    errors_m: list[float] = []
    labelled_people = 0
    for photo in selection.accepted:
        labelled = labelled_by_path[photo.image]
        detections = detector.detect_tiled(photo.image, conf=SAVE_THRESHOLD)
        predictions[photo.image] = detections
        labelled_people += len(labelled.boxes)
        summary = measure_pin_errors(
            detections,
            labelled.boxes,
            photo.pose_info.pose,
            threshold=candidate_threshold,
        )
        errors_m.extend(summary.errors_m)
    pin_error = summarize_pin_errors(errors_m)
    if pin_error.p90_m is None or pin_error.p90_m <= 0:
        raise ValueError(
            "no non-zero true-positive pin errors were available for a measured radius"
        )

    _reset_generated_folders(data)
    _write_real_intermediates(
        data,
        site,
        labelled_by_path,
        predictions,
        metrics,
        weights,
        candidate_threshold,
        model_name,
        pin_error.p90_m,
    )
    ctx = Context(
        data=data,
        n_frames=len(site),
        n_positive=len(site),
        weights=weights,
        candidate_threshold=candidate_threshold,
        model_name=model_name,
    )
    rank_stage(ctx)
    map_stage(ctx)
    metrics_stage(ctx)
    export_stage(
        ctx,
        out,
        survey_id="heridal-real-gps",
        web_out=web_out,
        git_sha=current_git_sha(),
        extra_notes=(
            (
                f"Largest coherent metadata cluster: {len(site)} photos. "
                f"Detection radius is the {pin_error.p90_m:.3f} m p90 label-relative box-centre "
                f"offset over {pin_error.n_matches} strict VOC matches; it is not absolute "
                "surveyed GPS error."
            ),
        ),
    )
    _write_evaluation_report(
        data / "work" / "real_position_eval.json",
        selection_counts=(
            len(selection.accepted) + len(selection.oblique),
            len(selection.accepted),
            len(selection.oblique),
            len(selection.missing_pose),
        ),
        labelled_people=labelled_people,
        threshold=candidate_threshold,
        pin_error=pin_error,
        site=site,
    )
    return RealSurveyResult(
        cache=out,
        site_images=tuple(photo.image.name for photo in site),
        photos_with_complete_pose=len(selection.accepted) + len(selection.oblique),
        photos_nadir=len(selection.accepted),
        photos_oblique=len(selection.oblique),
        photos_missing_pose=len(selection.missing_pose),
        labelled_people=labelled_people,
        pin_error=pin_error,
    )


# Remove only the pipeline-owned survey and work folders before a deterministic rebuild.
def _reset_generated_folders(data: Path) -> None:
    for folder in (data / "survey", data / "work"):
        shutil.rmtree(folder, ignore_errors=True)
    (data / "survey" / "frames").mkdir(parents=True)
    (data / "work" / "detect" / "crops").mkdir(parents=True)


# Prepare contract-validated intermediate files consumed by the standard downstream stages.
def _write_real_intermediates(
    data: Path,
    site: Sequence[RealPhoto],
    labelled_by_path: dict[Path, LabeledImage],
    predictions: dict[Path, list[RawDetection]],
    metrics: DetectorMetricsFile,
    weights: Path,
    threshold: float,
    model_name: str,
    radius_m: float,
) -> None:
    survey = data / "survey"
    work = data / "work"
    centre = LatLon(
        lat=sum(photo.pose_info.pose.lat for photo in site) / len(site),
        lon=sum(photo.pose_info.pose.lon for photo in site) / len(site),
    )
    area_name = _site_name(site)
    specs: list[SurveyFrameEntry] = []
    placed: dict[str, PlacedFrame] = {}
    raw_frames: dict[str, list[RawDetectionEntry]] = {}
    geo_frames: dict[str, list[GeoDetection]] = {}
    truth: dict[str, list[tuple[int, int, int, int]]] = {}

    for index, photo in enumerate(site, start=1):
        frame_id = f"f{index:04d}"
        labelled = labelled_by_path[photo.image]
        scale_x = FRAME_W_PX / labelled.width
        scale_y = FRAME_H_PX / labelled.height
        if abs(scale_x - scale_y) > 1e-9:
            raise ValueError(
                f"{photo.image.name}: aspect ratio cannot be resized to "
                f"{FRAME_W_PX}x{FRAME_H_PX} without distortion"
            )
        frame_path = survey / "frames" / f"{frame_id}.jpg"
        with Image.open(photo.image) as image:
            image.resize((FRAME_W_PX, FRAME_H_PX), Image.Resampling.LANCZOS).save(
                frame_path,
                format="JPEG",
                quality=85,
            )
        specs.append(
            SurveyFrameEntry(
                id=frame_id,
                flight_index=index - 1,
                source_image=photo.image.name,
                x0=0,
                y0=0,
                path=str(frame_path),
            )
        )
        source_pose = photo.pose_info.pose
        cache_pose = Pose(
            lat=source_pose.lat,
            lon=source_pose.lon,
            alt_agl_m=source_pose.alt_agl_m,
            heading_deg=source_pose.heading_deg,
            gsd_m=source_pose.gsd_m / scale_x,
        )
        placed[frame_id] = PlacedFrame(
            pose=cache_pose,
            footprint=footprint(cache_pose, FRAME_W_PX, FRAME_H_PX),
        )
        raw_frames[frame_id], geo_frames[frame_id] = _scaled_detections(
            frame_id,
            photo.image,
            predictions[photo.image],
            cache_pose,
            scale_x,
            scale_y,
            threshold,
            radius_m,
            work / "detect" / "crops",
        )
        truth[frame_id] = [_box_tuple(_scale_box(box, scale_x, scale_y)) for box in labelled.boxes]

    write_json(survey / "frames.json", SurveyFrameFile(specs))
    (survey / "truth.json").write_text(json.dumps(truth, indent=2) + "\n")
    write_json(
        work / "place" / "poses.json",
        PlaceFile(
            simulated_path=False,
            area_name=area_name,
            lkp=centre,
            frames=placed,
        ),
    )
    config = DetectConfig(
        weights=str(weights),
        model=model_name,
        candidate_threshold=threshold,
        save_threshold=SAVE_THRESHOLD,
    )
    write_json(work / "detect" / "config.json", config)
    write_json(
        work / "detect" / "detections_raw.json",
        RawDetectionsFile(
            model=model_name,
            save_threshold=SAVE_THRESHOLD,
            candidate_threshold=threshold,
            frames=raw_frames,
        ),
    )
    write_json(work / "detect" / "detector_metrics.json", metrics)
    write_json(work / "georef" / "detections_geo.json", GeoFile(frames=geo_frames))


# Scale source detections for the cache frame and calculate each real ground position.
def _scaled_detections(
    frame_id: str,
    source_image: Path,
    detections: Sequence[RawDetection],
    pose: Pose,
    scale_x: float,
    scale_y: float,
    threshold: float,
    radius_m: float,
    crops_dir: Path,
) -> tuple[list[RawDetectionEntry], list[GeoDetection]]:
    raw: list[RawDetectionEntry] = []
    geo: list[GeoDetection] = []
    for number, detection in enumerate(detections, start=1):
        scaled = _scale_box(detection.box, scale_x, scale_y)
        box = _box_tuple(scaled)
        raw.append(RawDetectionEntry(box=box, conf=detection.conf))
        point = pixel_to_latlon(*scaled.center, pose, FRAME_W_PX, FRAME_H_PX)
        geo.append(GeoDetection(box=box, lat=point.lat, lon=point.lon, radius_m=radius_m))
        if detection.conf >= threshold:
            make_crop(
                source_image,
                detection.box,
                crops_dir / f"{frame_id}-d{number:02d}.jpg",
            )
    return raw, geo


# Resize one source-image box into the fixed 1000x750 cache coordinate system.
def _scale_box(box: Box, scale_x: float, scale_y: float) -> Box:
    return Box(
        round(box.x1 * scale_x),
        round(box.y1 * scale_y),
        round(box.x2 * scale_x),
        round(box.y2 * scale_y),
    )


# Convert Lane A's typed box into the tuple required by Lane D's intermediate models.
def _box_tuple(box: Box) -> tuple[int, int, int, int]:
    return box.x1, box.y1, box.x2, box.y2


# Derive a concise display name from the shared HERIDAL filename site code.
def _site_name(site: Sequence[RealPhoto]) -> str:
    site_codes = {parts[1] for photo in site if len(parts := photo.image.stem.split("_")) >= 3}
    code = next(iter(site_codes)) if len(site_codes) == 1 else "real-position"
    return f"HERIDAL {code} site (real EXIF positions)"


# Keep the measurement provenance under data/work, never in the browser cache.
def _write_evaluation_report(
    path: Path,
    *,
    selection_counts: tuple[int, int, int, int],
    labelled_people: int,
    threshold: float,
    pin_error: PinErrorSummary,
    site: Sequence[RealPhoto],
) -> None:
    complete, nadir, oblique, missing = selection_counts
    report = {
        "threshold": threshold,
        "pose_filter": "abs(gimbal_pitch_deg + 90) <= 10",
        "photos_complete_pose": complete,
        "photos_nadir": nadir,
        "photos_oblique_skipped": oblique,
        "photos_missing_pose_skipped": missing,
        "labelled_people_in_nadir_photos": labelled_people,
        "matched_true_positives": pin_error.n_matches,
        "mean_error_m": pin_error.mean_m,
        "median_error_m": pin_error.median_m,
        "p90_error_m": pin_error.p90_m,
        "max_error_m": pin_error.max_m,
        "site_images": [photo.image.name for photo in site],
        "limitation": (
            "Offsets compare detector box centres with georeferenced label-box centres; HERIDAL "
            "has no surveyed person GPS coordinates, so this does not measure absolute GPS error."
        ),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(report, indent=2) + "\n")
