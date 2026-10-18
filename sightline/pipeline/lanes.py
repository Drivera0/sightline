"""The seam between lane D's pipeline and the other lanes' functions.

For each function a stage needs from lane A, B or C, `Lanes` looks it up (`sightline.ml`,
`sightline.geo`, `sightline.search`), calls it, and turns whatever it returns into the pipeline's own
types. If the function does not exist yet, a placeholder is used instead (LANE_D section 8) and the
fact is recorded, so `manifest.json` can say so.

The expected signatures below are DRAFTS, written before lanes B and C published theirs. If a real
function differs, change only the matching method here; no stage needs to change. Return values are
accepted in several shapes on purpose (object with attributes, dict, tuple, plain list).

    lane B   simulate_flight(n_frames: int, seed: int) -> poses [+ lkp, area_name]
             footprint(pose: Pose, width_px: int, height_px: int) -> 4 corners [lon, lat]
             georef_detection(pose: Pose, box_px, width_px: int, height_px: int) -> (lat, lon, radius_m)
    lane C   build_map(frames: list[MapFrame], lkp: LatLon, recall: float, recall_source: str)
                 -> MapFile [+ frame cells]
             simulate(map_file: MapFile, frame_cells) -> SearchSim
             ...or lane C's own signatures from docs/LANE_C_SEARCH.md (build_map(grid, lkp, prior,
             frames, recall, recall_source), simulate(map_file, frame_cells, trials, ...)),
             recognised by parameter names (see docs/LANE_INTERFACES.md).
    lane A   run_survey(frames_dir, weights, out_dir, candidate_threshold, model_name, save_threshold)
             load_split(split) -> list[LabeledImage]            (documented in LANE_A_ML.md)
"""

from __future__ import annotations

import importlib
import inspect
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sightline.contract import Grid, LatLon, MapFile, Pose, SearchSim
from sightline.pipeline import geometry
from sightline.pipeline.formats import write_json
from sightline.pipeline.geometry import FRAME_H_PX, FRAME_W_PX
from sightline.pipeline.placeholders import (
    PRIOR_FROM_PLACEHOLDER,
    PRIOR_OUTSIDE,
    placeholder_detections,
    placeholder_map,
    placeholder_search_sim,
)
from sightline.pipeline.survey import read_yolo_split

# Where to find each lane function: one (module, name), or several to try in order (lane C may
# export from the package or from its submodules).
Place = tuple[str, str]
REGISTRY: dict[str, Place | list[Place]] = {
    "simulate_flight": ("sightline.geo", "simulate_flight"),
    "footprint": ("sightline.geo", "footprint"),
    "georef_detection": ("sightline.geo", "georef_detection"),
    "run_survey": ("sightline.ml", "run_survey"),
    "load_split": ("sightline.ml", "load_split"),
    "build_map": [("sightline.search", "build_map"), ("sightline.search.build", "build_map")],
    "simulate": [("sightline.search", "simulate"), ("sightline.search.sim", "simulate")],
    "make_grid": [("sightline.search", "make_grid"), ("sightline.search.grid", "make_grid")],
    "placeholder_prior": [
        ("sightline.search", "placeholder_prior"),
        ("sightline.search.prior", "placeholder_prior"),
    ],
    "frame_input": [("sightline.search", "FrameInput"), ("sightline.search.pod", "FrameInput")],
}
_LANE = {
    "simulate_flight": "B",
    "footprint": "B",
    "georef_detection": "B",
    "run_survey": "A",
    "load_split": "A",
    "build_map": "C",
    "simulate": "C",
    "make_grid": "C",
    "placeholder_prior": "C",
    "frame_input": "C",
}

DEFAULT_LKP = LatLon(lat=49.37, lon=-122.945)
DEFAULT_AREA_NAME = "Mount Seymour, North Vancouver (simulated flight path)"
RECALL_FROM_DETECTOR = "metrics.detector.recall"
PLACEHOLDER_RADIUS_M = 10.0  # the stated position-uncertainty assumption on the simulated path

Footprint = tuple[
    tuple[float, float], tuple[float, float], tuple[float, float], tuple[float, float]
]
# frame id -> [(cell idx, canopy fraction or None, overlap)] for every cell the frame covers
FrameCells = dict[str, list[tuple[int, float | None, float]]]


@dataclass(frozen=True)
class Flight:
    poses: list[Pose]
    lkp: LatLon
    area_name: str


@dataclass(frozen=True)
class MapFrame:
    """What lane C's `build_map` is expected to receive for each frame."""

    id: str
    image_path: Path
    pose: Pose
    footprint: Footprint
    flight_index: int
    # (lat, lon, radius_m) of each candidate detection in the frame (conf >= candidate_threshold),
    # so lane C can hold those cells for review (pod = 0 near a detection).
    candidates: tuple[tuple[float, float, float], ...] = ()


@dataclass(frozen=True)
class NativeFrameInput:
    """Same fields as lane C's `FrameInput` (docs/LANE_C_SEARCH.md), used when lane C's own class
    is not importable. Lane C's code only reads these attributes."""

    frame_id: str
    pose: Pose
    width_px: int
    height_px: int
    image: Path
    candidates: list[tuple[LatLon, float]]


def _first_parameter(function: Callable[..., Any]) -> str | None:
    try:
        names = list(inspect.signature(function).parameters)
    except (TypeError, ValueError):
        return None
    return names[0] if names else None


def _is_native_simulate(function: Callable[..., Any]) -> bool:
    """Lane C's native `simulate(map_file, frame_cells, trials, seed, vis_noise)` has these extras."""
    try:
        names = inspect.signature(function).parameters
    except (TypeError, ValueError):
        return False
    return "trials" in names or "vis_noise" in names


def _accepts_positional(function: Callable[..., Any], count: int) -> bool:
    """True if `function` can be called with `count` positional arguments."""
    try:
        parameters = inspect.signature(function).parameters.values()
    except (TypeError, ValueError):
        return False
    if any(p.kind is inspect.Parameter.VAR_POSITIONAL for p in parameters):
        return True
    positional = [p for p in parameters if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)]
    return len(positional) >= count


def _as_cells(raw_cells: Mapping[str, Sequence[Sequence[Any]]]) -> FrameCells:
    """Frame cells from lane C as (idx, canopy, overlap) triples; anything else is an error."""
    cells: FrameCells = {}
    for frame_id, frame_cells in raw_cells.items():
        converted = []
        for cell in frame_cells:
            if len(cell) != 3:
                raise ValueError(
                    f"{frame_id}: frame cells must be (idx, canopy, overlap), got {tuple(cell)}"
                )
            idx, canopy, overlap = cell
            converted.append((int(idx), None if canopy is None else float(canopy), float(overlap)))
        cells[frame_id] = converted
    return cells


def _field(obj: Any, name: str, default: Any = None) -> Any:
    if isinstance(obj, Mapping):
        return obj.get(name, default)
    return getattr(obj, name, default)


class Lanes:
    """Resolves lane functions once, and records every placeholder that had to stand in."""

    def __init__(
        self,
        registry: Mapping[str, Place | Sequence[Place]] | None = None,
        overrides: Mapping[str, Callable[..., Any] | None] | None = None,
    ) -> None:
        self._registry = dict(REGISTRY if registry is None else registry)
        self._overrides = dict(overrides or {})
        self._cache: dict[str, Callable[..., Any] | None] = {}
        self.unavailable: dict[str, str] = {}
        self._notes: dict[str, str] = {}
        self._used_placeholder_prior = False

    # --- bookkeeping --------------------------------------------------------------------------

    def get(self, name: str) -> Callable[..., Any] | None:
        if name in self._overrides:
            function = self._overrides[name]
            if function is None:
                self.unavailable[name] = "disabled"
            return function
        if name not in self._cache:
            self._cache[name] = self._import(name)
        return self._cache[name]

    def _import(self, name: str) -> Callable[..., Any] | None:
        entry = self._registry[name]
        places: Sequence[Place] = [entry] if isinstance(entry[0], str) else entry  # type: ignore[list-item]
        reasons = []
        for module_name, attribute in places:
            try:
                module = importlib.import_module(module_name)
            except ImportError as error:
                reasons.append(f"cannot import {module_name}: {error}")
                continue
            function = getattr(module, attribute, None)
            if function is not None:
                return function
            reasons.append(f"{module_name} has no function {attribute}")
        self.unavailable[name] = "; ".join(reasons)
        return None

    def placeholder_notes(self) -> dict[str, str]:
        """Function name -> what stood in for it. Empty when every lane function was real."""
        return dict(self._notes)

    def note_placeholder(self, key: str, text: str) -> None:
        """Let a stage record a placeholder of its own (for example a missing lane A file)."""
        self._notes[key] = text

    def _fallback(self, name: str, used: str) -> None:
        self.note_placeholder(name, f"lane {_LANE[name]} function not available, used {used}")

    # --- lane B -------------------------------------------------------------------------------

    def flight(self, n_frames: int, seed: int = 7) -> Flight:
        function = self.get("simulate_flight")
        if function is None:
            self._fallback("simulate_flight", "the placeholder flight path")
            return Flight(
                geometry.placeholder_flight(n_frames, DEFAULT_LKP), DEFAULT_LKP, DEFAULT_AREA_NAME
            )
        result = function(n_frames, seed)
        poses_raw = result if isinstance(result, (list, tuple)) else _field(result, "poses")
        poses = [
            p if isinstance(p, Pose) else Pose.model_validate(p, from_attributes=True)
            for p in poses_raw
        ]
        if len(poses) != n_frames:
            raise ValueError(f"simulate_flight returned {len(poses)} poses for {n_frames} frames")
        lkp_raw = None if isinstance(result, (list, tuple)) else _field(result, "lkp")
        lkp = (
            DEFAULT_LKP if lkp_raw is None else LatLon.model_validate(lkp_raw, from_attributes=True)
        )
        area_name = (
            None if isinstance(result, (list, tuple)) else _field(result, "area_name")
        ) or DEFAULT_AREA_NAME
        return Flight(poses, lkp, area_name)

    def footprint(
        self, pose: Pose, width_px: int = FRAME_W_PX, height_px: int = FRAME_H_PX
    ) -> Footprint:
        function = self.get("footprint")
        if function is None:
            self._fallback("footprint", "the placeholder footprint math")
            return geometry.footprint(pose, width_px, height_px)  # type: ignore[return-value]
        corners = [(float(c[0]), float(c[1])) for c in function(pose, width_px, height_px)]
        if len(corners) != 4:
            raise ValueError(f"footprint returned {len(corners)} corners, expected 4 corners")
        return tuple(corners)  # type: ignore[return-value]

    def georef(
        self,
        pose: Pose,
        box_px: tuple[int, int, int, int],
        width_px: int = FRAME_W_PX,
        height_px: int = FRAME_H_PX,
    ) -> tuple[float, float, float]:
        """(lat, lon, radius_m) of a detection box centre."""
        function = self.get("georef_detection")
        if function is None:
            self._fallback("georef_detection", "pixel geometry with a 10 m radius")
            cx, cy = (box_px[0] + box_px[2]) / 2, (box_px[1] + box_px[3]) / 2
            lat, lon = geometry.pixel_to_latlon(pose, cx, cy, width_px, height_px)
            return lat, lon, PLACEHOLDER_RADIUS_M
        result = function(pose, box_px, width_px, height_px)
        if isinstance(result, (list, tuple)):
            lat, lon, radius = result[:3]
        else:
            lat, lon = _field(result, "lat"), _field(result, "lon")
            radius = _field(result, "radius_m", _field(result, "radius"))
        return float(lat), float(lon), float(radius)

    # --- lane A -------------------------------------------------------------------------------

    def detect(
        self,
        frames_dir: Path,
        frame_ids: Sequence[str],
        out_dir: Path,
        weights: Path | None,
        candidate_threshold: float,
        model_name: str,
        save_threshold: float = 0.05,
    ) -> None:
        function = self.get("run_survey")
        if function is not None and weights is not None:
            function(frames_dir, weights, out_dir, candidate_threshold, model_name, save_threshold)
            return
        if function is None:
            self._fallback("run_survey", "empty placeholder detections")
        else:
            self._notes["run_survey"] = (
                "lane A run_survey skipped: no weights given, used empty placeholder detections"
            )
        raw, config = placeholder_detections(frame_ids, candidate_threshold, save_threshold)
        (out_dir / "crops").mkdir(parents=True, exist_ok=True)
        write_json(out_dir / "detections_raw.json", raw)
        write_json(out_dir / "config.json", config)

    def test_images(self, split_dir: Path) -> list[Any]:
        """The HERIDAL test photos with their boxes, read from `split_dir` (`images/` and `labels/`,
        YOLO format). Lane A's `load_split(<folder name>, root=<parent>)` reads exactly that folder;
        a `load_split` without `root` reads its own default folder."""
        function = self.get("load_split")
        if function is None:
            self._fallback("load_split", "the built-in YOLO reader")
            return list(read_yolo_split(split_dir))
        if "root" in inspect.signature(function).parameters:
            return list(function(split_dir.name, root=split_dir.parent))
        return list(function("test"))

    # --- lane C -------------------------------------------------------------------------------

    def build_map(
        self,
        frames: Sequence[MapFrame],
        lkp: LatLon,
        recall: float,
        recall_source: str = RECALL_FROM_DETECTOR,
        cell_m: float = geometry.CELL_M,
    ) -> tuple[MapFile, FrameCells]:
        """`recall_source` says where `recall` comes from (the detector metrics or the placeholder).
        `cell_m` is the grid cell size; the grid always covers 1 km, so 10 m gives 100 x 100 cells."""
        function = self.get("build_map")
        if function is None:
            self._fallback("build_map", "a uniform prior with empty steps")
            return placeholder_map([f.id for f in frames], lkp, recall, recall_source)
        if _first_parameter(function) == "grid":  # lane C's native signature
            result = self._native_build_map(function, frames, lkp, recall, recall_source, cell_m)
        elif _accepts_positional(function, 4):
            result = function(list(frames), lkp, recall, recall_source)
        else:
            result = function(list(frames), lkp, recall)  # an older build_map without recall_source
        if isinstance(result, tuple):
            raw_map, raw_cells = result
        elif isinstance(result, MapFile):
            raw_map, raw_cells = result, None
        else:
            raw_map, raw_cells = _field(result, "map"), _field(result, "frame_cells")
        map_file = raw_map if isinstance(raw_map, MapFile) else MapFile.model_validate(raw_map)
        map_file = self._stamp_prior_source(map_file)
        if raw_cells is None:
            cells = self._cells_from_steps(map_file)
        else:
            cells = _as_cells(raw_cells)
        return map_file, cells

    def _native_build_map(
        self,
        function: Callable[..., Any],
        frames: Sequence[MapFrame],
        lkp: LatLon,
        recall: float,
        recall_source: str,
        cell_m: float = geometry.CELL_M,
    ) -> tuple[Any, FrameCells | None]:
        """Call lane C's `build_map(grid, lkp, prior, frames, recall, recall_source)` and turn its
        per-frame `{idx: (canopy, overlap)}` lists into cells keyed by frame id."""
        grid = self._grid(lkp, cell_m)
        prior = self._prior(grid)
        frame_class = self.get("frame_input") or NativeFrameInput
        inputs = [
            frame_class(
                frame_id=f.id,
                pose=f.pose,
                width_px=FRAME_W_PX,
                height_px=FRAME_H_PX,
                image=f.image_path,
                candidates=[
                    (LatLon(lat=lat, lon=lon), radius) for lat, lon, radius in f.candidates
                ],
            )
            for f in frames
        ]
        result = function(grid, lkp, prior, inputs, recall, recall_source)
        if not isinstance(result, tuple):
            return result, None  # a map only; the cells are derived from its steps
        raw_map, per_frame = result
        if len(per_frame) != len(frames):
            raise ValueError(
                f"build_map returned {len(per_frame)} frame-cell lists for {len(frames)} frames"
            )
        cells: FrameCells = {
            frame.id: [
                (int(idx), float(canopy), float(overlap))
                for idx, (canopy, overlap) in sorted(cells_of_frame.items())
            ]
            for frame, cells_of_frame in zip(frames, per_frame, strict=True)
        }
        return raw_map, cells

    def _grid(self, lkp: LatLon, cell_m: float = geometry.CELL_M) -> Grid:
        """Lane C's `make_grid(lkp, cell_m=...)`, or the same 1 km grid built here."""
        make_grid = self.get("make_grid")
        if make_grid is not None:
            return make_grid(lkp) if cell_m == geometry.CELL_M else make_grid(lkp, cell_m=cell_m)
        n = round(geometry.GRID_ROWS * geometry.CELL_M / cell_m)
        return Grid(
            origin_nw=geometry.grid_origin_nw(lkp, rows=n, cols=n, cell_m=cell_m),
            cell_m=cell_m,
            rows=n,
            cols=n,
        )

    def _stamp_prior_source(self, map_file: MapFile) -> MapFile:
        """Contract 1.1 `params.prior_source`: "placeholder" when `_prior` handed lane C the
        placeholder prior. Otherwise keep what lane C wrote (the citation of its prior); a map
        that names no source and wasn't given ours stays null."""
        if not self._used_placeholder_prior:
            return map_file
        params = map_file.params.model_copy(update={"prior_source": PRIOR_FROM_PLACEHOLDER})
        return map_file.model_copy(update={"params": params})

    def _prior(self, grid: Grid) -> tuple[Any, float]:
        """A placeholder prior (probabilities per cell, probability outside the grid). The real
        prior needs the distance statistics for a lost hiker, which we do not have yet."""
        import numpy as np

        self.note_placeholder("prior", "no real search prior yet, used a uniform placeholder prior")
        self._used_placeholder_prior = True
        placeholder_prior = self.get("placeholder_prior")
        if placeholder_prior is not None:
            return placeholder_prior(grid)
        cells = grid.rows * grid.cols
        return np.full(cells, (1 - PRIOR_OUTSIDE) / cells), PRIOR_OUTSIDE

    def _cells_from_steps(self, map_file: MapFile) -> FrameCells:
        """When lane C returns only a MapFile: the cells each step covered, with the map's canopy and
        an overlap of 1.0 (a single look). Real overlap needs lane C's own `frame_cells`."""
        cells: FrameCells = {
            step.frame_id: [(idx, map_file.canopy[idx], 1.0) for idx, _pod in step.cells]
            for step in map_file.steps
        }
        if any(cells.values()):
            self.note_placeholder(
                "frame_cells",
                "lane C gave no frame_cells, derived them from the steps (overlap 1.0)",
            )
        return cells

    def simulate(self, map_file: MapFile, frame_cells: FrameCells) -> SearchSim:
        function = self.get("simulate")
        if function is None:
            self._fallback("simulate", "a labelled placeholder (zeros, 0 trials)")
            return placeholder_search_sim()
        if _is_native_simulate(function):
            ordered = [frame_cells[frame_id] for frame_id in sorted(frame_cells)]
            result = function(
                map_file,
                [
                    {
                        idx: (0.0 if canopy is None else canopy, overlap)
                        for idx, canopy, overlap in cells
                    }
                    for cells in ordered
                ],
            )
        else:
            result = function(map_file, frame_cells)
        return result if isinstance(result, SearchSim) else SearchSim.model_validate(result)
