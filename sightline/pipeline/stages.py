"""Pipeline stages. Each reads and writes `data/<...>/`, so it can be re-run on its own.

Order: frames, place, detect, georef, rank, map, metrics, export. Placeholders that stand in for
missing lane functions are recorded in `ctx.lanes` (see `lanes.py`).
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from sightline.contract import MapFile, Stages
from sightline.pipeline.export import export_cache
from sightline.pipeline.formats import (
    DetectConfig,
    DetectorMetricsFile,
    FrameCellsFile,
    GeoDetection,
    GeoFile,
    PlacedFrame,
    PlaceFile,
    RankEntry,
    RankFile,
    RawDetectionsFile,
    SurveyFrameFile,
    read_json,
    write_json,
)
from sightline.pipeline.lanes import Lanes, MapFrame
from sightline.pipeline.mapmath import normalise_map
from sightline.pipeline.placeholders import placeholder_detector_metrics
from sightline.pipeline.rank import rank_frames, ranking_metrics
from sightline.pipeline.survey import build_survey, write_survey

PLACEHOLDER_RECALL = 0.80  # used by `map` until lane A has written detector_metrics.json
DEFAULT_NOTES = "Real HERIDAL test imagery on a simulated flight path over Mount Seymour."


@dataclass
class Context:
    """Everything a stage needs besides the files it reads."""

    data: Path = Path("data")
    lanes: Lanes = field(default_factory=Lanes)
    n_frames: int = 500
    n_positive: int = 6
    seed: int = 7
    weights: Path | None = None  # detector weights for lane A's run_survey; None = placeholder
    candidate_threshold: float = 0.25
    model_name: str = "yolo11s-heridal-tiled"
    # HERIDAL test split in YOLO format. Default: data/heridal/yolo_full/test
    test_dir: Path | None = None

    def __post_init__(self) -> None:
        if self.test_dir is None:
            self.test_dir = self.data / "heridal" / "yolo_full" / "test"

    @property
    def survey_dir(self) -> Path:
        return self.data / "survey"

    @property
    def work(self) -> Path:
        return self.data / "work"


def _frame_ids(ctx: Context) -> list[str]:
    """Frame ids in flight order, from the `frames` stage."""
    entries = read_json(ctx.survey_dir / "frames.json", SurveyFrameFile, produced_by="frames").root
    return [e.id for e in sorted(entries, key=lambda e: e.flight_index)]


def frames_stage(ctx: Context) -> None:
    """Cut frames from the HERIDAL test photos; write the JPEGs, `frames.json` and `truth.json`."""
    assert ctx.test_dir is not None
    images = ctx.lanes.test_images(ctx.test_dir)
    frames, truth = build_survey(
        images, ctx.n_frames, ctx.n_positive, ctx.seed, survey_dir=ctx.survey_dir
    )
    write_survey(frames, truth, images, ctx.survey_dir)


def place_stage(ctx: Context) -> None:
    """Give every frame a pose and a footprint (lane B, or the placeholder flight)."""
    ids = _frame_ids(ctx)
    flight = ctx.lanes.flight(len(ids), ctx.seed)
    frames = {
        frame_id: PlacedFrame(pose=pose, footprint=ctx.lanes.footprint(pose))
        for frame_id, pose in zip(ids, flight.poses, strict=True)
    }
    write_json(
        ctx.work / "place" / "poses.json",
        PlaceFile(simulated_path=True, area_name=flight.area_name, lkp=flight.lkp, frames=frames),
    )


def detect_stage(ctx: Context) -> None:
    """Run lane A's detector on the frames (GPU), or write empty placeholder detections."""
    ctx.lanes.detect(
        ctx.survey_dir / "frames",
        _frame_ids(ctx),
        ctx.work / "detect",
        ctx.weights,
        ctx.candidate_threshold,
        ctx.model_name,
    )


def georef_stage(ctx: Context) -> None:
    """Turn each raw detection box into a ground position (lane B, or the placeholder geometry)."""
    place = read_json(ctx.work / "place" / "poses.json", PlaceFile, produced_by="place")
    raw = read_json(
        ctx.work / "detect" / "detections_raw.json", RawDetectionsFile, produced_by="detect"
    )
    frames: dict[str, list[GeoDetection]] = {}
    for frame_id, detections in raw.frames.items():
        pose = place.frames[frame_id].pose
        positions = []
        for detection in detections:
            lat, lon, radius_m = ctx.lanes.georef(pose, detection.box)
            positions.append(GeoDetection(box=detection.box, lat=lat, lon=lon, radius_m=radius_m))
        frames[frame_id] = positions
    write_json(ctx.work / "georef" / "detections_geo.json", GeoFile(frames=frames))


def _flight_index(ctx: Context) -> dict[str, int]:
    entries = read_json(ctx.survey_dir / "frames.json", SurveyFrameFile, produced_by="frames").root
    return {e.id: e.flight_index for e in entries}


def rank_stage(ctx: Context) -> None:
    """Score and rank the frames from the raw detections (threshold from lane A's config)."""
    flight_index = _flight_index(ctx)
    config = read_json(ctx.work / "detect" / "config.json", DetectConfig, produced_by="detect")
    raw = read_json(
        ctx.work / "detect" / "detections_raw.json", RawDetectionsFile, produced_by="detect"
    )
    ranked = rank_frames(raw.frames, flight_index, config.candidate_threshold)
    write_json(
        ctx.work / "rank" / "rank.json",
        RankFile(
            frames={
                frame_id: RankEntry(score=score, rank=rank, n_candidates=n_candidates)
                for frame_id, (score, rank, n_candidates) in ranked.items()
            }
        ),
    )


def map_stage(ctx: Context) -> None:
    """Build the search map (lane C, or a placeholder) and make it obey the contract's rules."""
    place = read_json(ctx.work / "place" / "poses.json", PlaceFile, produced_by="place")
    flight_index = _flight_index(ctx)
    metrics_path = ctx.work / "detect" / "detector_metrics.json"
    recall = PLACEHOLDER_RECALL
    if metrics_path.is_file():
        recall = read_json(metrics_path, DetectorMetricsFile).detector.recall
    frames = [
        MapFrame(
            id=frame_id,
            image_path=ctx.survey_dir / "frames" / f"{frame_id}.jpg",
            pose=place.frames[frame_id].pose,
            footprint=place.frames[frame_id].footprint,
            flight_index=index,
        )
        for frame_id, index in sorted(flight_index.items(), key=lambda item: item[1])
    ]
    map_file, cells = ctx.lanes.build_map(frames, place.lkp, recall)
    write_json(ctx.work / "map" / "map.json", normalise_map(map_file))
    write_json(ctx.work / "map" / "frame_cells.json", FrameCellsFile(frames=cells))


def metrics_stage(ctx: Context) -> None:
    """Collect detector metrics (lane A), ranking metrics (here) and the search simulation (lane C)."""
    config = read_json(ctx.work / "detect" / "config.json", DetectConfig, produced_by="detect")
    detector_path = ctx.work / "detect" / "detector_metrics.json"
    if detector_path.is_file():
        detector = read_json(detector_path, DetectorMetricsFile)
    else:
        detector = placeholder_detector_metrics(config.candidate_threshold)
        ctx.lanes.note_placeholder(
            "detector_metrics",
            "lane A detector_metrics.json is missing, used zeros labelled PLACEHOLDER",
        )
    write_json(ctx.work / "metrics" / "detector_metrics.json", detector)

    flight_index = _flight_index(ctx)
    rank = read_json(ctx.work / "rank" / "rank.json", RankFile, produced_by="rank")
    truth_path = ctx.survey_dir / "truth.json"
    if not truth_path.is_file():
        raise FileNotFoundError(f"{truth_path} is missing (written by the `frames` stage)")
    truth = {
        frame_id: [tuple(box) for box in boxes]
        for frame_id, boxes in json.loads(truth_path.read_text()).items()
    }
    ranking = ranking_metrics({f: e.rank for f, e in rank.frames.items()}, flight_index, truth)
    write_json(ctx.work / "metrics" / "ranking.json", ranking)

    map_file = read_json(ctx.work / "map" / "map.json", MapFile, produced_by="map")
    cells = read_json(ctx.work / "map" / "frame_cells.json", FrameCellsFile, produced_by="map")
    write_json(ctx.work / "metrics" / "search_sim.json", ctx.lanes.simulate(map_file, cells.frames))


def export_stage(
    ctx: Context,
    out: Path,
    survey_id: str = "seymour-demo",
    web_out: Path | None = None,
    stages: Stages | None = None,
    git_sha: str | None = None,
    generated_at: datetime | None = None,
    extra_notes: Sequence[str] = (),
) -> None:
    """Build, validate and write the cache. The manifest names every placeholder that was used."""
    placeholders = ctx.lanes.placeholder_notes()
    notes = DEFAULT_NOTES
    if placeholders:
        notes += (
            " Placeholders used: " + "; ".join(f"{k}: {v}" for k, v in placeholders.items()) + "."
        )
    if extra_notes:
        notes += " " + " ".join(extra_notes)
    export_cache(
        ctx.work,
        out,
        survey_id,
        survey_dir=ctx.survey_dir,
        web_out=web_out,
        stages=stages,
        notes=notes,
        git_sha=git_sha,
        generated_at=generated_at,
    )
