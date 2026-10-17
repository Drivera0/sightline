"""Cache validation: the checklist in contract section 11."""

from __future__ import annotations

import json
import math
from pathlib import Path, PurePosixPath
from typing import Any

from pydantic import BaseModel, ValidationError

from sightline.contract import Detections, Manifest, MapFile, Metrics, Survey

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
    p = list(map_file.prior.p)
    outside = map_file.prior.outside
    for step in map_file.steps:
        denominator = 1 - math.fsum(p[idx] * pod for idx, pod in step.cells)
        if denominator <= 0:
            return [f"map.json: replay of {step.frame_id} leaves no probability mass"]
        for idx, pod in step.cells:
            p[idx] *= 1 - pod
        p = [x / denominator for x in p]
        outside /= denominator
    worst = max(abs(a - b) for a, b in zip(p, map_file.final.p, strict=True))
    worst = max(worst, abs(outside - map_file.final.outside))
    if worst > REPLAY_TOLERANCE:
        return [f"map.json: replay of steps differs from final by {worst:.3g} (limit 1e-9)"]
    return []
