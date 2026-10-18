"""Writing the cache (`export_cache`) and checking it (`validate_cache`, contract section 11)."""

from __future__ import annotations

import json
import math
import shutil
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any

from pydantic import BaseModel, ValidationError

from sightline.contract import (
    CONTRACT_VERSION,
    Area,
    BaselineHuman,
    Detection,
    Detections,
    Frame,
    Manifest,
    MapFile,
    Metrics,
    Ranking,
    SearchSim,
    StageResult,
    Stages,
    Survey,
    dump_json,
)
from sightline.pipeline.formats import (
    DetectConfig,
    DetectorMetricsFile,
    GeoFile,
    PlaceFile,
    RankFile,
    RawDetectionsFile,
    SurveyFrameFile,
    read_json,
)
from sightline.pipeline.mapmath import replay_steps
from sightline.pipeline.survey import FRAME_H, FRAME_W

# Published numbers (contract section 9). Never change them.
HUMAN_BASELINE = BaselineHuman(
    precision=0.59,
    recall=0.68,
    seconds_per_image=33,
    source="Pyrrö, Naseri & Jung 2021, arXiv:2111.09406",
)

M_PER_DEG_LAT = 111320.0
REPLAY_TOLERANCE = 1e-9
MAX_MESSAGES_PER_FILE = 5

_FILES: dict[str, type[BaseModel]] = {
    "manifest": Manifest,
    "survey": Survey,
    "detections": Detections,
    "map": MapFile,
    "metrics": Metrics,
}

# Ground truth must never reach the cache (contract section 3).
_TRUTH_KEYS = {"truth", "ground_truth", "gt", "gt_boxes", "true_boxes", "is_positive", "has_person"}


class CacheValidationError(ValueError):
    """The cache built by `export_cache` failed `validate_cache`; nothing was written."""

    def __init__(self, errors: list[str]) -> None:
        self.errors = errors
        shown = "; ".join(errors[:10])
        more = f" (and {len(errors) - 10} more)" if len(errors) > 10 else ""
        super().__init__(f"the cache failed validation: {shown}{more}")


def export_cache(
    work: Path,
    out: Path,
    survey_id: str = "seymour-demo",
    *,
    survey_dir: Path | None = None,
    web_out: Path | None = None,
    stages: Stages | None = None,
    notes: str = "",
    git_sha: str | None = None,
    generated_at: datetime | None = None,
) -> None:
    """Build the contract files from `work` (data/work) and `survey_dir` (default data/survey).

    The cache is built in a staging folder, checked with `validate_cache`, and only then moved to
    `out` (and copied to `web_out`). A cache that fails validation is never written. Ground truth is
    never read, so it cannot reach the cache.
    """
    survey_dir = survey_dir or work.parent / "survey"
    specs = read_json(survey_dir / "frames.json", SurveyFrameFile, "frames").root
    place = read_json(work / "place" / "poses.json", PlaceFile, "place")
    config = read_json(work / "detect" / "config.json", DetectConfig, "detect")
    raw = read_json(work / "detect" / "detections_raw.json", RawDetectionsFile, "detect")
    geo = read_json(work / "georef" / "detections_geo.json", GeoFile, "georef")
    rank = read_json(work / "rank" / "rank.json", RankFile, "rank")
    map_file = read_json(work / "map" / "map.json", MapFile, "map")
    # Every file in the cache carries the current version, whatever lane C stamped on the map.
    map_file = map_file.model_copy(update={"contract_version": CONTRACT_VERSION})
    detector = read_json(work / "metrics" / "detector_metrics.json", DetectorMetricsFile, "metrics")
    ranking = read_json(work / "metrics" / "ranking.json", Ranking, "metrics")
    search_sim = read_json(work / "metrics" / "search_sim.json", SearchSim, "metrics")

    _check_same_frames(
        {
            "frames.json": {s.id for s in specs},
            "poses.json": set(place.frames),
            "detections_raw.json": set(raw.frames),
            "detections_geo.json": set(geo.frames),
            "rank.json": set(rank.frames),
        }
    )
    for field in ("model", "candidate_threshold", "save_threshold"):
        if getattr(config, field) != getattr(raw, field):
            raise ValueError(
                f"config.json and detections_raw.json disagree on {field}: "
                f"{getattr(config, field)!r} vs {getattr(raw, field)!r}"
            )

    ordered = sorted(specs, key=lambda s: s.flight_index)
    survey = Survey(
        contract_version=CONTRACT_VERSION,
        survey_id=survey_id,
        simulated_path=place.simulated_path,
        area=Area(name=place.area_name, lkp=place.lkp),
        frames=[
            Frame(
                id=s.id,
                file=f"frames/{s.id}.jpg",
                width_px=FRAME_W,
                height_px=FRAME_H,
                flight_index=s.flight_index,
                source={"image": s.source_image, "x0": s.x0, "y0": s.y0},
                pose=place.frames[s.id].pose,
                footprint=place.frames[s.id].footprint,
                score=rank.frames[s.id].score,
                rank=rank.frames[s.id].rank,
                n_candidates=rank.frames[s.id].n_candidates,
            )
            for s in ordered
        ],
    )
    detections = Detections(
        contract_version=CONTRACT_VERSION,
        model=config.model,
        save_threshold=config.save_threshold,
        candidate_threshold=config.candidate_threshold,
        frames={
            s.id: _frame_detections(s.id, raw, geo, config.candidate_threshold) for s in ordered
        },
    )
    metrics = Metrics(
        contract_version=CONTRACT_VERSION,
        detector=detector.detector,
        baseline_human=HUMAN_BASELINE,
        ablations=detector.ablations,
        ranking=ranking,
        search_sim=search_sim,
    )
    manifest = Manifest(
        contract_version=CONTRACT_VERSION,
        survey_id=survey_id,
        generated_at=generated_at or datetime.now(UTC).replace(microsecond=0),
        git_sha=git_sha,
        simulated_path=place.simulated_path,
        n_frames=len(ordered),
        stages=stages
        or Stages(**{n: StageResult(ok=True, seconds=0.0) for n in Stages.model_fields}),
        notes=notes,
    )

    staging = out.parent / f".{out.name}.staging"
    shutil.rmtree(staging, ignore_errors=True)
    try:
        _write_staged(
            staging,
            work,
            survey_dir,
            ordered,
            detections,
            (survey, detections, map_file, metrics, manifest),
        )
        errors = validate_cache(staging)
        if errors:
            raise CacheValidationError(errors)
        _replace(staging, out, move=True)
        if web_out is not None:
            _replace(out, web_out, move=False)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def _check_same_frames(sources: dict[str, set[str]]) -> None:
    reference = sources["frames.json"]
    for name, ids in sources.items():
        if name == "frames.json" or ids == reference:
            continue
        missing, extra = sorted(reference - ids), sorted(ids - reference)
        detail = []
        if missing:
            detail.append(f"{', '.join(missing[:5])} in frames.json but missing from {name}")
        if extra:
            detail.append(f"{', '.join(extra[:5])} in {name} but not in frames.json")
        raise ValueError("; ".join(detail))


def _frame_detections(
    frame_id: str, raw: RawDetectionsFile, geo: GeoFile, candidate_threshold: float
) -> list[Detection]:
    raw_dets, geo_dets = raw.frames[frame_id], geo.frames[frame_id]
    if len(raw_dets) != len(geo_dets):
        raise ValueError(
            f"{frame_id}: {len(raw_dets)} raw detections but {len(geo_dets)} positions in detections_geo.json"
        )
    result = []
    for n, (r, g) in enumerate(zip(raw_dets, geo_dets, strict=True), start=1):
        if r.box != g.box:
            raise ValueError(
                f"{frame_id}: box of detection {n} in detections_geo.json {g.box} differs "
                f"from detections_raw.json {r.box}"
            )
        detection_id = f"{frame_id}-d{n:02d}"
        result.append(
            Detection(
                id=detection_id,
                box_px=r.box,
                conf=r.conf,
                crop=f"crops/{detection_id}.jpg" if r.conf >= candidate_threshold else None,
                lat=g.lat,
                lon=g.lon,
                radius_m=g.radius_m,
            )
        )
    return result


def _write_staged(
    staging: Path,
    work: Path,
    survey_dir: Path,
    frames: list[Any],
    detections: Detections,
    files: tuple[BaseModel, ...],
) -> None:
    (staging / "frames").mkdir(parents=True)
    (staging / "crops").mkdir()
    for spec in frames:
        _copy_if_exists(
            survey_dir / "frames" / f"{spec.id}.jpg", staging / "frames" / f"{spec.id}.jpg"
        )
    for dets in detections.frames.values():
        for d in dets:
            if d.crop:
                _copy_if_exists(work / "detect" / d.crop, staging / d.crop)
    names = ("survey", "detections", "map", "metrics", "manifest")  # manifest last
    for name, model in zip(names, files, strict=True):
        (staging / f"{name}.json").write_text(dump_json(model))


def _copy_if_exists(source: Path, target: Path) -> None:
    if source.is_file():  # a missing file is reported by validate_cache, with its cache path
        shutil.copyfile(source, target)


def _replace(source: Path, dest: Path, *, move: bool) -> None:
    """Put `source` at `dest`, replacing an old cache. Refuses a non-empty folder that is no cache."""
    if dest.exists():
        if any(dest.iterdir()) and not (dest / "manifest.json").exists():
            raise ValueError(
                f"{dest} is not empty and is not a cache folder; refusing to replace it"
            )
        shutil.rmtree(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if move:
        source.rename(dest)
    else:
        shutil.copytree(source, dest)


def validate_cache(path: Path) -> list[str]:
    """Return one message per failed check; an empty list means the cache is valid."""
    errors = _check_no_truth(path)
    loaded: dict[str, Any] = {}
    for name, model in _FILES.items():
        file = path / f"{name}.json"
        if not file.is_file():
            errors.append(f"{name}.json: missing")
            continue
        try:
            loaded[name] = model.model_validate_json(file.read_text())
        except ValidationError as exc:
            shown = exc.errors()[:MAX_MESSAGES_PER_FILE]
            for err in shown:
                errors.append(f"{name}.json: {'.'.join(map(str, err['loc']))}: {err['msg']}")
            if len(exc.errors()) > len(shown):
                errors.append(f"{name}.json: ... {len(exc.errors()) - len(shown)} more")

    survey: Survey | None = loaded.get("survey")
    detections: Detections | None = loaded.get("detections")
    map_file: MapFile | None = loaded.get("map")
    manifest: Manifest | None = loaded.get("manifest")

    if survey and manifest and len(survey.frames) != manifest.n_frames:
        errors.append(
            f"manifest.json: n_frames is {manifest.n_frames} but survey.json has {len(survey.frames)} frames"
        )
    if survey:
        errors += _check_paths(path, [(f.id, f.file) for f in survey.frames], "survey.json")
    if detections:
        crops = [(d.id, d.crop) for dets in detections.frames.values() for d in dets if d.crop]
        errors += _check_paths(path, crops, "detections.json")
    if survey and detections:
        survey_ids = {f.id for f in survey.frames}
        for frame_id in sorted(survey_ids - detections.frames.keys()):
            errors.append(f"detections.json: no entry for frame {frame_id} (use [] when empty)")
        for frame_id in sorted(detections.frames.keys() - survey_ids):
            errors.append(f"detections.json: frame {frame_id} is not in survey.json")
    if survey and map_file:
        errors += _check_steps_match_frames(survey, map_file)
        errors += _check_footprints_touch_grid(survey, map_file)
    if map_file:
        errors += _check_replay(map_file)
    return errors


def _check_no_truth(path: Path) -> list[str]:
    errors = []
    if not path.is_dir():
        return [f"{path}: not a directory"]
    for item in sorted(path.rglob("*")):
        if "truth" in item.name.lower():
            errors.append(f"{item.relative_to(path)}: ground truth must not be in the cache")
        if item.suffix == ".json" and item.is_file():
            try:
                data = json.loads(item.read_text())
            except ValueError:
                continue  # unparseable JSON is reported by the model checks
            for key in sorted(_truth_keys(data)):
                errors.append(
                    f"{item.relative_to(path)}: ground-truth field '{key}' must not be in the cache"
                )
    return errors


def _truth_keys(node: Any) -> set[str]:
    if isinstance(node, dict):
        found = {k for k in node if k.lower() in _TRUTH_KEYS}
        for value in node.values():
            found |= _truth_keys(value)
        return found
    if isinstance(node, list):
        return set().union(*(_truth_keys(v) for v in node)) if node else set()
    return set()


def _check_paths(root: Path, items: list[tuple[str, str]], source: str) -> list[str]:
    errors = []
    for owner, rel in items:
        parts = PurePosixPath(rel)
        if parts.is_absolute() or ".." in parts.parts:
            errors.append(f"{source}: {owner}: path {rel} must stay inside the cache folder")
        elif not (root / rel).is_file():
            errors.append(f"{source}: {owner}: file {rel} does not exist")
    return errors


def _check_steps_match_frames(survey: Survey, map_file: MapFile) -> list[str]:
    step_ids = [s.frame_id for s in map_file.steps]
    frame_ids = [f.id for f in survey.frames]
    if step_ids != frame_ids:
        message = (
            f"map.json: steps must be one per frame in flight order: {len(step_ids)} steps "
            f"for {len(frame_ids)} frames"
        )
        return [message]
    return []


def _check_footprints_touch_grid(survey: Survey, map_file: MapFile) -> list[str]:
    """Bounding box of each footprint must overlap the grid (exact for headings 90 and 270)."""
    g = map_file.grid
    north, west = g.origin_nw.lat, g.origin_nw.lon
    south = north - g.rows * g.cell_m / M_PER_DEG_LAT
    east = west + g.cols * g.cell_m / (M_PER_DEG_LAT * math.cos(math.radians(north)))
    errors = []
    for frame in survey.frames:
        lons = [c[0] for c in frame.footprint]
        lats = [c[1] for c in frame.footprint]
        if max(lats) < south or min(lats) > north or max(lons) < west or min(lons) > east:
            errors.append(f"survey.json: {frame.id}: footprint lies outside the search grid")
    return errors


def _check_replay(map_file: MapFile) -> list[str]:
    """Replay `steps` (pods as written) on the prior; it must reproduce `final` (contract 8)."""
    try:
        p, outside = replay_steps(map_file.prior.p, map_file.prior.outside, map_file.steps)
    except ValueError as error:
        return [f"map.json: replay failed: {error}"]
    worst = max(abs(a - b) for a, b in zip(p, map_file.final.p, strict=True))
    worst = max(worst, abs(outside - map_file.final.outside))
    if worst > REPLAY_TOLERANCE:
        return [f"map.json: replay of steps differs from final by {worst:.3g} (limit 1e-9)"]
    return []
