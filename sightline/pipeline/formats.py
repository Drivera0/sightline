"""Intermediate files between pipeline stages (`data/work/<stage>/`, `data/survey/`).

These are NOT contract files: they never reach the cache directly. `export_cache` reads them and
writes the contract files.

PROPOSAL for lanes B and C. Your functions only *return* values; the pipeline's `place`, `georef`
and `map` stages call them and write these files, so you never write JSON yourself. Tell lane D
if a shape below does not fit what your function returns:

- `place/poses.json` (`PlaceFile`): lane B's `simulate_flight` and `footprint`, plus the LKP.
- `georef/detections_geo.json` (`GeoFile`): lane B's `georef_detection`, one entry per raw detection.
- `map/map.json`: lane C's `build_map`, written as the contract's `MapFile` (no new model).
- `map/frame_cells.json` (`FrameCellsFile`): lane C's per-frame covered cells, for `simulate`.

Lane A's files (`DetectConfig`, `RawDetectionsFile`, `DetectorMetricsFile`) follow LANE_A_ML.md
section 6.4. Lane D's own files are `RankFile` and `SurveyFrameFile`.
"""

from __future__ import annotations

from pathlib import Path
from typing import Annotated, TypeVar

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    RootModel,
    ValidationError,
    model_validator,
)

from sightline.contract import (
    FRAME_ID,
    Ablation,
    DetectorMetrics,
    LatLon,
    LonLat,
    Pose,
    Probability,
)

Footprint = tuple[LonLat, LonLat, LonLat, LonLat]
FrameId = Annotated[str, Field(pattern=FRAME_ID)]


def _check_box(box: tuple[int, int, int, int]) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = box
    if not (x2 > x1 and y2 > y1):
        raise ValueError(f"box must satisfy x2 > x1 and y2 > y1, got {box}")
    return box


BoxPx = Annotated[tuple[int, int, int, int], AfterValidator(_check_box)]


class _File(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --- lane B (written by the `place` and `georef` stages) --------------------------------------


class PlacedFrame(_File):
    pose: Pose
    footprint: Footprint


class PlaceFile(_File):
    """`work/place/poses.json`."""

    simulated_path: bool
    area_name: str
    lkp: LatLon
    frames: dict[FrameId, PlacedFrame]


class GeoDetection(_File):
    """Position of one raw detection. `box` repeats the raw box so export can check the pairing."""

    box: BoxPx
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    radius_m: float = Field(gt=0)


class GeoFile(_File):
    """`work/georef/detections_geo.json`: same frames, same order as `detections_raw.json`."""

    frames: dict[FrameId, list[GeoDetection]]


# --- lane C (written by the `map` stage) ------------------------------------------------------


class FrameCellsFile(_File):
    """`work/map/frame_cells.json`: frame id -> [idx, pod] for every covered cell, pod unrounded."""

    frames: dict[FrameId, list[tuple[int, Probability]]]


# --- lane A (written on the GPU desktop by `run_survey`) --------------------------------------


class DetectConfig(_File):
    """`work/detect/config.json`."""

    weights: str
    model: str
    candidate_threshold: Probability
    save_threshold: Probability


class RawDetectionEntry(_File):
    box: BoxPx
    conf: Probability


class RawDetectionsFile(_File):
    """`work/detect/detections_raw.json`. Every frame is present, boxes sorted by descending conf."""

    model: str
    save_threshold: Probability
    candidate_threshold: Probability
    frames: dict[FrameId, list[RawDetectionEntry]]

    @model_validator(mode="after")
    def _sorted(self) -> RawDetectionsFile:
        for frame_id, dets in self.frames.items():
            confs = [d.conf for d in dets]
            if confs != sorted(confs, reverse=True):
                raise ValueError(f"{frame_id}: detections must be sorted by descending conf")
        return self


class DetectorMetricsFile(_File):
    """`work/detect/detector_metrics.json`: the contract detector block plus the ablation rows."""

    detector: DetectorMetrics
    ablations: list[Ablation]


# --- lane D (written by the `frames` and `rank` stages) ---------------------------------------


class RankEntry(_File):
    score: Probability
    rank: int = Field(ge=1)
    n_candidates: int = Field(ge=0)


class RankFile(_File):
    """`work/rank/rank.json`."""

    frames: dict[FrameId, RankEntry]

    @model_validator(mode="after")
    def _ranks(self) -> RankFile:
        if sorted(e.rank for e in self.frames.values()) != list(range(1, len(self.frames) + 1)):
            raise ValueError("rank values must be exactly 1..N")
        return self


class SurveyFrameEntry(_File):
    id: FrameId
    flight_index: int = Field(ge=0)
    source_image: str
    x0: int = Field(ge=0)
    y0: int = Field(ge=0)
    path: str


class SurveyFrameFile(RootModel[list[SurveyFrameEntry]]):
    """`data/survey/frames.json`, as written by `write_survey`."""


# --- reading and writing ----------------------------------------------------------------------

T = TypeVar("T", bound=BaseModel)


def write_json(path: Path, model: BaseModel) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(model.model_dump_json(indent=2) + "\n")


def read_json(path: Path, model: type[T], produced_by: str | None = None) -> T:
    """Read and validate an intermediate file, with errors that name the file and its stage."""
    if not path.is_file():
        hint = f" (written by the `{produced_by}` stage)" if produced_by else ""
        raise FileNotFoundError(f"{path} is missing{hint}")
    try:
        return model.model_validate_json(path.read_text())
    except ValidationError as exc:
        first = exc.errors()[0]
        where = ".".join(map(str, first["loc"]))
        raise ValueError(f"{path.name}: {where}: {first['msg']}") from exc
