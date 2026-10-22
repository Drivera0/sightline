"""Lane C's planned native signatures (docs/LANE_C_SEARCH.md), through Lanes.build_map and Lanes.simulate.

The fakes below follow that doc, so they show what the adapter must accept once lane C's code lands.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from sightline.contract import Grid, LatLon, MapFile, Pose, Step
from sightline.pipeline.formats import FrameCellsFile, read_json
from sightline.pipeline.lanes import Lanes, MapFrame
from sightline.pipeline.placeholders import placeholder_map
from sightline.pipeline.stages import (
    Context,
    detect_stage,
    frames_stage,
    map_stage,
    place_stage,
)

LKP = LatLon(lat=49.37, lon=-122.945)
POSE = Pose(lat=49.37, lon=-122.945, alt_agl_m=None, heading_deg=90.0, gsd_m=0.02)
LANE_NAMES = [
    "simulate_flight",
    "footprint",
    "georef_detection",
    "run_survey",
    "load_split",
    "build_map",
    "simulate",
]
HELPERS = ["make_grid", "placeholder_prior", "frame_input"]


@dataclass
class FrameInput:  # the shape in the lane C doc
    frame_id: str
    pose: Pose
    width_px: int
    height_px: int
    image: Path
    candidates: list[tuple[LatLon, float]]


def no_c_helpers(**overrides) -> Lanes:
    names = LANE_NAMES + HELPERS
    return Lanes(overrides={name: None for name in names} | overrides)


def frames(n: int = 3, candidates: dict | None = None) -> list[MapFrame]:
    candidates = candidates or {}
    return [
        MapFrame(
            id=f"f{i + 1:04d}",
            image_path=Path(f"f{i + 1:04d}.jpg"),
            pose=POSE,
            footprint=((0.0, 0.0),) * 4,
            flight_index=i,
            candidates=candidates.get(f"f{i + 1:04d}", ()),
        )
        for i in range(n)
    ]


class Recorder:
    """A native build_map that records what it is given and returns a valid map."""

    def __init__(self, cells=None, steps=None):
        self.calls = []
        self.cells = cells
        self.steps = steps

    def __call__(self, grid, lkp, prior, frames, recall, recall_source):
        self.calls.append((grid, lkp, prior, frames, recall, recall_source))
        map_file, _ = placeholder_map([f.frame_id for f in frames], lkp, recall, recall_source)
        if self.steps:
            data = map_file.model_dump()
            data["steps"] = [
                Step(frame_id=f.frame_id, cells=self.steps.get(f.frame_id, [])).model_dump()
                for f in frames
            ]
            map_file = MapFile.model_validate(data)
        cells = self.cells if self.cells is not None else [{} for _ in frames]
        return map_file, cells


# ---------------------------------------------------------------- what build_map is given


def test_a_build_map_whose_first_argument_is_grid_is_called_the_native_way():
    recorder = Recorder()

    no_c_helpers(build_map=recorder).build_map(frames(), LKP, 0.8, "placeholder")

    grid, lkp, _prior, inputs, recall, recall_source = recorder.calls[0]
    assert isinstance(grid, Grid) and (grid.rows, grid.cols, grid.cell_m) == (50, 50, 20)
    assert lkp == LKP and recall == 0.8 and recall_source == "placeholder"
    assert len(inputs) == 3


def test_without_lane_c_helpers_the_grid_is_centred_on_the_lkp_and_the_prior_is_uniform():
    recorder = Recorder()

    no_c_helpers(build_map=recorder).build_map(frames(), LKP, 0.8, "placeholder")

    grid, _, (probabilities, outside), *_ = recorder.calls[0]
    assert grid.origin_nw.lat > LKP.lat and grid.origin_nw.lon < LKP.lon
    assert isinstance(probabilities, np.ndarray) and probabilities.shape == (2500,)
    assert len(set(probabilities.tolist())) == 1
    assert probabilities.sum() + outside == pytest.approx(1.0)


def test_lane_c_make_grid_and_placeholder_prior_are_used_when_they_exist():
    recorder = Recorder()
    marker_grid = Grid(origin_nw=LatLon(lat=49.4, lon=-123.0), cell_m=20, rows=50, cols=50)
    marker_prior = (np.full(2500, 0.0002), 0.5)
    seen = {}
    lanes = no_c_helpers(
        build_map=recorder,
        make_grid=lambda lkp, size_m=1000.0, cell_m=20.0: marker_grid,
        placeholder_prior=lambda grid: seen.setdefault("grid", grid) and marker_prior,
    )

    lanes.build_map(frames(), LKP, 0.8, "placeholder")

    grid, _, prior, *_ = recorder.calls[0]
    assert grid is marker_grid and prior is marker_prior and seen["grid"] is marker_grid


def test_frames_become_frame_inputs_with_the_fields_in_the_doc():
    recorder = Recorder()
    candidates = {"f0002": ((49.3701, -122.9441, 10.0), (49.3702, -122.9442, 7.5))}

    no_c_helpers(build_map=recorder).build_map(
        frames(candidates=candidates), LKP, 0.8, "placeholder"
    )

    inputs = recorder.calls[0][3]
    assert [f.frame_id for f in inputs] == ["f0001", "f0002", "f0003"]
    second = inputs[1]
    assert (second.width_px, second.height_px) == (1000, 750)
    assert second.image == Path("f0002.jpg") and second.pose == POSE
    assert second.candidates == [
        (LatLon(lat=49.3701, lon=-122.9441), 10.0),
        (LatLon(lat=49.3702, lon=-122.9442), 7.5),
    ]
    assert inputs[0].candidates == []


def test_the_detector_gsd_reaches_lane_c_frame_inputs():
    from dataclasses import replace

    from sightline.search.pod import FrameInput as LaneCFrameInput

    given = [replace(f, detector_gsd_m=0.014 if f.id == "f0002" else None) for f in frames()]
    for frame_input in (None, LaneCFrameInput):  # the stand-in class and lane C's own
        recorder = Recorder()
        no_c_helpers(build_map=recorder, frame_input=frame_input).build_map(
            given, LKP, 0.8, "placeholder"
        )
        assert [f.detector_gsd_m for f in recorder.calls[0][3]] == [None, 0.014, None]


def test_the_place_stage_gives_each_frame_its_source_photo_gsd(tmp_path, monkeypatch):
    from types import SimpleNamespace

    import sightline.geo.pose as pose_module
    from sightline.pipeline.stages import _source_gsd

    images = tmp_path / "test" / "images"
    images.mkdir(parents=True)
    for name in ("with_pose.jpg", "no_pose.jpg"):
        Image.new("RGB", (8, 6)).save(images / name)
    monkeypatch.setattr(
        pose_module,
        "read_pose",
        lambda path: (
            SimpleNamespace(pose=SimpleNamespace(gsd_m=0.0141))
            if path.name == "with_pose.jpg"
            else None
        ),
    )
    test_dir = tmp_path / "test"
    assert _source_gsd(test_dir, "with_pose.jpg") == 0.0141
    assert _source_gsd(test_dir, "no_pose.jpg") is None
    assert _source_gsd(test_dir, "missing.jpg") is None


def test_lane_c_own_frame_input_class_is_used_when_it_exists():
    recorder = Recorder()

    no_c_helpers(build_map=recorder, frame_input=FrameInput).build_map(
        frames(), LKP, 0.8, "placeholder"
    )

    assert all(isinstance(f, FrameInput) for f in recorder.calls[0][3])


def test_frames_are_passed_in_the_order_given_so_cell_lists_line_up_by_position():
    recorder = Recorder()
    ordered = list(reversed(frames()))

    no_c_helpers(build_map=recorder).build_map(ordered, LKP, 0.8, "placeholder")

    assert [f.frame_id for f in recorder.calls[0][3]] == [f.id for f in ordered]


# ---------------------------------------------------------------- what comes back


def test_per_frame_cell_lists_become_cells_keyed_by_frame_id_sorted_by_cell():
    recorder = Recorder(cells=[{10: (0.4, 2.0), 3: (0.1, 1.0)}, {}, {7: (0.9, 1.5)}])

    _, cells = no_c_helpers(build_map=recorder).build_map(frames(), LKP, 0.8, "placeholder")

    assert cells == {
        "f0001": [(3, 0.1, 1.0), (10, 0.4, 2.0)],
        "f0002": [],
        "f0003": [(7, 0.9, 1.5)],
    }


def test_the_number_of_cell_lists_must_match_the_number_of_frames():
    recorder = Recorder(cells=[{}, {}])

    with pytest.raises(ValueError, match="2 frame-cell lists for 3 frames"):
        no_c_helpers(build_map=recorder).build_map(frames(), LKP, 0.8, "placeholder")


def test_a_native_build_map_that_returns_only_a_map_gets_cells_from_its_steps():
    base, _ = placeholder_map(["f0001", "f0002", "f0003"], LKP, 0.8)

    lanes = no_c_helpers(build_map=lambda grid, lkp, prior, frames, recall, recall_source: base)
    map_file, cells = lanes.build_map(frames(), LKP, 0.8, "placeholder")

    assert isinstance(map_file, MapFile) and cells == {"f0001": [], "f0002": [], "f0003": []}


def test_using_a_placeholder_prior_is_recorded_for_the_manifest():
    lanes = no_c_helpers(build_map=Recorder())

    lanes.build_map(frames(), LKP, 0.8, "placeholder")

    assert "prior" in lanes.placeholder_notes()


def test_a_native_build_map_is_not_a_placeholder_for_build_map_itself():
    lanes = no_c_helpers(build_map=Recorder())

    lanes.build_map(frames(), LKP, 0.8, "placeholder")

    assert "build_map" not in lanes.placeholder_notes()


# ---------------------------------------------------------------- the older shape still works


def test_the_older_frames_lkp_recall_shape_is_still_called_the_old_way():
    calls = []

    def build_map(frames, lkp, recall, recall_source):
        calls.append((frames, lkp, recall, recall_source))
        return placeholder_map([f.id for f in frames], lkp, recall, recall_source)[0]

    no_c_helpers(build_map=build_map).build_map(frames(), LKP, 0.8, "placeholder")

    assert calls[0][1] == LKP and isinstance(calls[0][0][0], MapFrame)


# ---------------------------------------------------------------- through the map stage


def make_context(tmp_path: Path, lanes: Lanes) -> Context:
    split = tmp_path / "data" / "heridal" / "yolo_full" / "test"
    if not split.exists():
        (split / "images").mkdir(parents=True)
        (split / "labels").mkdir()
        for i in range(6):
            Image.new("RGB", (4000, 3000), (80 + i, 110, 70)).save(
                split / "images" / f"test_{i}.jpg"
            )
            (split / "labels" / f"test_{i}.txt").write_text("0 0.3 0.4 0.0125 0.02\n")
    return Context(data=tmp_path / "data", lanes=lanes, n_frames=40, n_positive=3)


def test_the_map_stage_works_with_a_native_build_map(tmp_path):
    ids = [f"f{i:04d}" for i in range(1, 41)]
    recorder = Recorder(
        cells=[{12: (0.5, 2.0)} for _ in ids], steps={i: [(12, 0.31234567)] for i in ids}
    )
    ctx = make_context(tmp_path, no_c_helpers(build_map=recorder))
    for stage in (frames_stage, place_stage, detect_stage):
        stage(ctx)

    map_stage(ctx)

    written = read_json(ctx.work / "map" / "map.json", MapFile)
    assert written.steps[0].cells == [(12, 0.3123)]  # rounded by the pipeline, as before
    cells = read_json(ctx.work / "map" / "frame_cells.json", FrameCellsFile)
    assert cells.frames["f0001"] == [(12, 0.5, 2.0)] and len(cells.frames) == 40
    assert recorder.calls[0][5] == "placeholder"  # no detector metrics yet
