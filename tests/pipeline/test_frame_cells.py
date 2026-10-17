"""Lane C request 2: frame cells are (idx, canopy, overlap), which is what simulate needs."""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image
from pydantic import ValidationError

from sightline.contract import LatLon, MapFile, Step
from sightline.pipeline.formats import FrameCellsFile, read_json, write_json
from sightline.pipeline.lanes import Lanes, MapFrame
from sightline.pipeline.placeholders import (
    placeholder_map,
    placeholder_search_sim,
)
from sightline.pipeline.stages import (
    Context,
    detect_stage,
    frames_stage,
    map_stage,
    metrics_stage,
    place_stage,
    rank_stage,
)

LKP = LatLon(lat=49.37, lon=-122.945)
N_FRAMES, N_POSITIVE = 40, 3
LANE_NAMES = [
    "simulate_flight",
    "footprint",
    "georef_detection",
    "run_survey",
    "load_split",
    "build_map",
    "simulate",
]


def none_available() -> Lanes:
    return Lanes(overrides={name: None for name in LANE_NAMES})


def map_frames(ids=("f0001",)) -> list[MapFrame]:
    from sightline.contract import Pose

    pose = Pose(lat=49.37, lon=-122.945, alt_agl_m=None, heading_deg=90.0, gsd_m=0.02)
    return [
        MapFrame(
            id=i,
            image_path=Path(f"{i}.jpg"),
            pose=pose,
            footprint=((0.0, 0.0),) * 4,
            flight_index=n,
        )
        for n, i in enumerate(ids)
    ]


# ---------------------------------------------------------------- the file format


def test_frame_cells_hold_cell_index_canopy_and_overlap_per_frame():
    cells = FrameCellsFile.model_validate(
        {"frames": {"f0001": [[1234, 0.62, 2.0], [1235, None, 1.0]]}}
    )

    assert cells.frames["f0001"] == [(1234, 0.62, 2.0), (1235, None, 1.0)]


def test_canopy_must_be_a_fraction():
    with pytest.raises(ValidationError):
        FrameCellsFile.model_validate({"frames": {"f0001": [[1, 1.5, 1.0]]}})


def test_overlap_cannot_be_negative():
    with pytest.raises(ValidationError):
        FrameCellsFile.model_validate({"frames": {"f0001": [[1, 0.5, -1.0]]}})


def test_the_old_idx_and_pod_pairs_are_rejected():
    with pytest.raises(ValidationError):
        FrameCellsFile.model_validate({"frames": {"f0001": [[1234, 0.21]]}})


def test_values_are_stored_unrounded(tmp_path):
    cells = FrameCellsFile.model_validate({"frames": {"f0001": [[7, 0.123456789, 1.987654321]]}})

    write_json(tmp_path / "frame_cells.json", cells)

    assert read_json(tmp_path / "frame_cells.json", FrameCellsFile).frames["f0001"] == [
        (7, 0.123456789, 1.987654321)
    ]


# ---------------------------------------------------------------- what lane C may return


def test_a_pair_of_map_and_triples_is_accepted():
    placeholder, _ = placeholder_map(["f0001"], LKP, 0.8)
    lanes = Lanes(
        overrides={
            "build_map": lambda frames, lkp, recall: (
                placeholder,
                {"f0001": [(5, 0.31234, 2.0), (6, None, 1.0)]},
            )
        }
    )

    _, cells = lanes.build_map(map_frames(), LKP, recall=0.8)

    assert cells == {"f0001": [(5, 0.31234, 2.0), (6, None, 1.0)]}
    assert lanes.placeholder_notes() == {}


def test_an_object_with_map_and_frame_cells_is_accepted():
    placeholder, _ = placeholder_map(["f0001"], LKP, 0.8)
    result = type("R", (), {"map": placeholder, "frame_cells": {"f0001": [[1, 0.5, 1.0]]}})()
    lanes = Lanes(overrides={"build_map": lambda frames, lkp, recall: result})

    _, cells = lanes.build_map(map_frames(), LKP, recall=0.8)

    assert cells == {"f0001": [(1, 0.5, 1.0)]}


def test_old_style_pairs_from_lane_c_are_an_error_that_says_what_is_expected():
    placeholder, _ = placeholder_map(["f0001"], LKP, 0.8)
    lanes = Lanes(
        overrides={
            "build_map": lambda frames, lkp, recall: (placeholder, {"f0001": [(5, 0.31234)]})
        }
    )

    with pytest.raises(ValueError, match=r"idx, canopy, overlap"):
        lanes.build_map(map_frames(), LKP, recall=0.8)


def test_a_map_file_alone_gets_cells_derived_from_its_steps_with_a_note():
    base, _ = placeholder_map(["f0001"], LKP, 0.8)
    data = base.model_dump()
    data["canopy"][10] = 0.4
    data["steps"] = [Step(frame_id="f0001", cells=[(10, 0.5), (11, 0.25)]).model_dump()]
    lanes = Lanes(overrides={"build_map": lambda frames, lkp, recall: MapFile.model_validate(data)})

    _, cells = lanes.build_map(map_frames(), LKP, recall=0.8)

    assert cells == {"f0001": [(10, 0.4, 1.0), (11, None, 1.0)]}
    assert "frame_cells" in lanes.placeholder_notes()


def test_a_map_file_alone_with_no_covered_cells_needs_no_note():
    placeholder, _ = placeholder_map(["f0001"], LKP, 0.8)
    lanes = Lanes(overrides={"build_map": lambda frames, lkp, recall: placeholder})

    _, cells = lanes.build_map(map_frames(), LKP, recall=0.8)

    assert cells == {"f0001": []} and lanes.placeholder_notes() == {}


# ---------------------------------------------------------------- through the stages


def make_context(tmp_path: Path, **overrides) -> Context:
    split = tmp_path / "data" / "heridal" / "yolo_full" / "test"
    if not split.exists():
        (split / "images").mkdir(parents=True)
        (split / "labels").mkdir()
        for i in range(6):
            Image.new("RGB", (4000, 3000), (80 + i, 110, 70)).save(
                split / "images" / f"test_{i}.jpg"
            )
            (split / "labels" / f"test_{i}.txt").write_text("0 0.3 0.4 0.0125 0.02\n")
    lanes = Lanes(overrides={name: None for name in LANE_NAMES} | overrides)
    return Context(data=tmp_path / "data", lanes=lanes, n_frames=N_FRAMES, n_positive=N_POSITIVE)


def test_the_map_stage_writes_the_cells_lane_c_returned_unrounded(tmp_path):
    ids = [f"f{i:04d}" for i in range(1, N_FRAMES + 1)]
    base, _ = placeholder_map(ids, LKP, 0.8)
    cells = {i: [(10, 0.123456, 2.5)] for i in ids}
    ctx = make_context(tmp_path, build_map=lambda frames, lkp, recall: (base, cells))
    for stage in (frames_stage, place_stage, detect_stage):
        stage(ctx)

    map_stage(ctx)

    written = read_json(ctx.work / "map" / "frame_cells.json", FrameCellsFile)
    assert written.frames["f0001"] == [(10, 0.123456, 2.5)]


def test_the_metrics_stage_hands_simulate_the_new_cells(tmp_path):
    seen = {}

    def simulate(map_file, frame_cells):
        seen["cells"] = frame_cells
        return placeholder_search_sim()

    ids = [f"f{i:04d}" for i in range(1, N_FRAMES + 1)]
    base, _ = placeholder_map(ids, LKP, 0.8)
    ctx = make_context(
        tmp_path,
        build_map=lambda frames, lkp, recall: (base, {i: [(3, 0.5, 1.5)] for i in ids}),
        simulate=simulate,
    )
    for stage in (frames_stage, place_stage, detect_stage, rank_stage, map_stage):
        stage(ctx)

    metrics_stage(ctx)

    assert seen["cells"]["f0002"] == [(3, 0.5, 1.5)]


def test_placeholder_map_still_returns_empty_cells_for_every_frame():
    _, cells = placeholder_map(["f0001", "f0002"], LKP, 0.8)

    assert cells == {"f0001": [], "f0002": []}
