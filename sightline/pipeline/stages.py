"""Pipeline stages. Each reads and writes `data/<...>/`, so it can be re-run on its own.

Order: frames, place, detect, georef, rank, map, metrics, export. Placeholders that stand in for
missing lane functions are recorded in `ctx.lanes` (see `lanes.py`).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from sightline.pipeline.formats import (
    GeoDetection,
    GeoFile,
    PlacedFrame,
    PlaceFile,
    RawDetectionsFile,
    SurveyFrameFile,
    read_json,
    write_json,
)
from sightline.pipeline.lanes import Lanes
from sightline.pipeline.survey import build_survey, write_survey


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
