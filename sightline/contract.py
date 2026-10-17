"""Pydantic v2 models of docs/01_CONTRACT.md (v1.0). The doc wins if the two disagree.

Only lane D edits this file. Rounding (contract section 2) happens at write time in `dump_json`,
never inside the models.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

CONTRACT_VERSION = "1.0"

Probability = Annotated[float, Field(ge=0.0, le=1.0)]
FRAME_ID = r"^f\d{4}$"
DETECTION_ID = r"^f\d{4}-d\d{2}$"
SUM_TOLERANCE = 1e-6


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class LatLon(_Model):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)


# --- survey.json ---------------------------------------------------------------------------

LonLat = tuple[float, float]  # GeoJSON order


class Pose(_Model):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    alt_agl_m: float | None
    heading_deg: float = Field(ge=0, le=360)
    gsd_m: float = Field(gt=0)


class Source(_Model):
    image: str
    x0: int = Field(ge=0)
    y0: int = Field(ge=0)


class Frame(_Model):
    id: str = Field(pattern=FRAME_ID)
    file: str
    width_px: int = Field(gt=0)
    height_px: int = Field(gt=0)
    flight_index: int = Field(ge=0)
    source: Source
    pose: Pose
    footprint: tuple[LonLat, LonLat, LonLat, LonLat]
    score: Probability
    rank: int = Field(ge=1)
    n_candidates: int = Field(ge=0)

    @model_validator(mode="after")
    def _check(self) -> Frame:
        if self.id != f"f{self.flight_index + 1:04d}":
            raise ValueError(f"id {self.id} does not match flight_index {self.flight_index}")
        if self.footprint[0] == self.footprint[-1]:
            raise ValueError("footprint must not be closed (first corner equals last)")
        return self


class Area(_Model):
    name: str
    lkp: LatLon


class Survey(_Model):
    contract_version: Literal["1.0"]
    survey_id: str
    simulated_path: bool
    area: Area
    frames: list[Frame]

    @model_validator(mode="after")
    def _check(self) -> Survey:
        n = len(self.frames)
        if [f.flight_index for f in self.frames] != list(range(n)):
            raise ValueError("frames must be in flight order with flight_index 0..N-1, no gaps")
        if sorted(f.rank for f in self.frames) != list(range(1, n + 1)):
            raise ValueError("rank values must be exactly 1..N")
        return self


# --- detections.json -----------------------------------------------------------------------


class Detection(_Model):
    id: str = Field(pattern=DETECTION_ID)
    box_px: tuple[int, int, int, int]
    conf: Probability
    crop: str | None
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    radius_m: float = Field(gt=0)

    @model_validator(mode="after")
    def _check(self) -> Detection:
        x1, y1, x2, y2 = self.box_px
        if not (x2 > x1 and y2 > y1):
            raise ValueError(f"box_px must satisfy x2 > x1 and y2 > y1, got {self.box_px}")
        return self


class Detections(_Model):
    contract_version: Literal["1.0"]
    model: str
    save_threshold: Probability
    candidate_threshold: Probability
    frames: dict[Annotated[str, Field(pattern=FRAME_ID)], list[Detection]]

    @model_validator(mode="after")
    def _check(self) -> Detections:
        for frame_id, dets in self.frames.items():
            confs = [d.conf for d in dets]
            if confs != sorted(confs, reverse=True):
                raise ValueError(f"{frame_id}: detections must be sorted by descending conf")
            for i, d in enumerate(dets, start=1):
                if d.id != f"{frame_id}-d{i:02d}":
                    raise ValueError(f"{frame_id}: expected id {frame_id}-d{i:02d}, got {d.id}")
                is_candidate = d.conf >= self.candidate_threshold
                if is_candidate != (d.crop is not None):
                    raise ValueError(
                        f"{d.id}: crop must be non-null exactly when conf >= candidate_threshold"
                    )
        return self


# --- map.json ------------------------------------------------------------------------------


class Grid(_Model):
    origin_nw: LatLon
    cell_m: float = Field(gt=0)
    rows: int = Field(gt=0)
    cols: int = Field(gt=0)


class Params(_Model):
    recall: Probability
    recall_source: str
    pod_cap: Probability
    review_pod: Probability


class Distribution(_Model):
    """Per-cell probabilities plus the mass outside the grid; used for `prior` and `final`."""

    p: list[Probability]
    outside: Probability


class Step(_Model):
    frame_id: str = Field(pattern=FRAME_ID)
    cells: list[tuple[int, Probability]]  # [idx, pod]


class TopCell(_Model):
    idx: int = Field(ge=0)
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    p: Probability
    canopy: Probability | None


class MapFile(_Model):
    contract_version: Literal["1.0"]
    grid: Grid
    lkp: LatLon
    params: Params
    prior: Distribution
    canopy: list[Probability | None]
    steps: list[Step]
    final: Distribution
    top_cells: list[TopCell]

    @model_validator(mode="after")
    def _check(self) -> MapFile:
        n = self.grid.rows * self.grid.cols
        for name, arr in (
            ("prior.p", self.prior.p),
            ("canopy", self.canopy),
            ("final.p", self.final.p),
        ):
            if len(arr) != n:
                raise ValueError(f"{name} has {len(arr)} values, expected rows*cols = {n}")
        for name, dist in (("prior", self.prior), ("final", self.final)):
            total = math.fsum(dist.p) + dist.outside
            if abs(total - 1.0) > SUM_TOLERANCE:
                raise ValueError(
                    f"sum({name}.p) + {name}.outside = {total}, expected 1 within 1e-6"
                )
        frame_ids = [s.frame_id for s in self.steps]
        if len(set(frame_ids)) != len(frame_ids):
            raise ValueError("steps must have unique frame_ids")
        for s in self.steps:
            for idx, pod in s.cells:
                if not 0 <= idx < n:
                    raise ValueError(f"{s.frame_id}: cell idx {idx} outside 0..{n - 1}")
                if pod > self.params.pod_cap + 1e-9:
                    raise ValueError(
                        f"{s.frame_id}: pod {pod} exceeds pod_cap {self.params.pod_cap}"
                    )
        if len(self.top_cells) > 5:
            raise ValueError("top_cells holds at most 5 cells")
        ps = [c.p for c in self.top_cells]
        if ps != sorted(ps, reverse=True):
            raise ValueError("top_cells must be sorted by descending p")
        if any(c.idx >= n for c in self.top_cells):
            raise ValueError("top_cells idx outside the grid")
        return self


# --- metrics.json --------------------------------------------------------------------------


class VocScores(_Model):
    precision: Probability
    recall: Probability
    ap50: Probability


class SarScores(_Model):
    precision: Probability
    recall: Probability
    ap: Probability


class DetectorMetrics(_Model):
    model: str
    test_images: int = Field(ge=0)
    tiled: bool
    threshold: Probability
    voc: VocScores
    sar: SarScores
    recall: Probability
    seconds_per_image: float = Field(ge=0)

    @model_validator(mode="after")
    def _check(self) -> DetectorMetrics:
        if self.recall != self.voc.recall:
            raise ValueError("recall must be a copy of voc.recall")
        return self


class BaselineHuman(_Model):
    precision: Probability
    recall: Probability
    seconds_per_image: float = Field(ge=0)
    source: str


class Ablation(_Model):
    name: str
    voc: VocScores


class HitPositions(_Model):
    frames_to_first_hit: int = Field(ge=0)
    frames_to_all_hits: int = Field(ge=0)


class MinutesAtHumanPace(_Model):
    flight_order_first: float = Field(ge=0)
    ranked_first: float = Field(ge=0)


class Ranking(_Model):
    n_frames: int = Field(ge=0)
    n_positive: int = Field(ge=0)
    flight_order: HitPositions
    ranked: HitPositions
    expected_first_hit_random_order: float = Field(ge=0)
    minutes_at_human_pace: MinutesAtHumanPace
    note: str

    @model_validator(mode="after")
    def _check(self) -> Ranking:
        if self.n_positive > self.n_frames:
            raise ValueError("n_positive cannot exceed n_frames")
        return self


class SearchMethod(_Model):
    name: str
    median_cells: float = Field(ge=0)
    p90_cells: float = Field(ge=0)


class SearchSim(_Model):
    simulated: bool
    trials: int = Field(ge=0)
    seed: int
    found_by_drone_rate: Probability
    methods: list[SearchMethod]


class Metrics(_Model):
    contract_version: Literal["1.0"]
    detector: DetectorMetrics
    baseline_human: BaselineHuman
    ablations: list[Ablation]
    ranking: Ranking
    search_sim: SearchSim


# --- manifest.json -------------------------------------------------------------------------


class StageResult(_Model):
    ok: bool
    seconds: float = Field(ge=0)


class Stages(_Model):
    """Exactly the eight pipeline stages, in order."""

    frames: StageResult
    place: StageResult
    detect: StageResult
    georef: StageResult
    rank: StageResult
    map: StageResult
    metrics: StageResult
    export: StageResult


class Manifest(_Model):
    contract_version: Literal["1.0"]
    survey_id: str
    generated_at: AwareDatetime
    git_sha: str | None
    simulated_path: bool
    n_frames: int = Field(ge=0)
    stages: Stages
    notes: str


# --- JSON schema and writing ---------------------------------------------------------------


class CacheBundle(_Model):
    """Root type used only to export one JSON Schema covering every cache file."""

    manifest: Manifest
    survey: Survey
    detections: Detections
    map: MapFile
    metrics: Metrics


def _for_json2ts(node: Any, named: bool = False) -> Any:
    """Reshape Pydantic's JSON Schema so json-schema-to-typescript emits clean types.

    Tuples use `prefixItems`, which json2ts ignores (it wants an `items` list), and per-field
    `title`s make it invent aliases like `Lat1`; only named definitions keep their title.
    """
    if isinstance(node, list):
        return [_for_json2ts(v) for v in node]
    if not isinstance(node, dict):
        return node
    out: dict[str, Any] = {}
    for key, value in node.items():
        if key == "title" and not named:
            continue
        if key == "prefixItems":
            out["items"] = [_for_json2ts(v) for v in value]
            out["additionalItems"] = False
        elif key == "$defs":
            out[key] = {name: _for_json2ts(d, named=True) for name, d in value.items()}
        else:
            out[key] = _for_json2ts(value)
    return out


def export_json_schema(out: Path) -> None:
    out.parent.mkdir(parents=True, exist_ok=True)
    schema = _for_json2ts(CacheBundle.model_json_schema(), named=True)
    out.write_text(json.dumps(schema, indent=2) + "\n")


def _decimals(path: tuple[str, ...]) -> int | None:
    """Decimal places for the float at `path` (contract section 2); None = leave unrounded."""
    if path[0] in ("prior", "final"):
        return None
    if path[-1] in ("lat", "lon") or "footprint" in path:
        return 6
    if path[0] in ("steps", "canopy") or (path[0] == "top_cells" and path[-1] in ("p", "canopy")):
        return 4
    return 3


def _round(node: Any, path: tuple[str, ...]) -> Any:
    if isinstance(node, dict):
        return {k: _round(v, (*path, k)) for k, v in node.items()}
    if isinstance(node, list):
        return [_round(v, path) for v in node]
    if isinstance(node, float):
        places = _decimals(path)
        return node if places is None else round(node, places)
    return node


def dump_json(model: BaseModel) -> str:
    """Serialise a top-level contract file with the contract's float precision. Rejects NaN."""
    data = model.model_dump(mode="json")
    return json.dumps(_round(data, ()), indent=2, allow_nan=False) + "\n"


def _cli() -> None:
    parser = argparse.ArgumentParser(prog="python -m sightline.contract")
    sub = parser.add_subparsers(dest="command", required=True)
    schema = sub.add_parser("schema", help="write the JSON Schema of every cache file")
    schema.add_argument("out", type=Path)
    args = parser.parse_args()
    if args.command == "schema":
        export_json_schema(args.out)


if __name__ == "__main__":
    _cli()
