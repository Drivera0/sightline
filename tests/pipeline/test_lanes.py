"""Lanes: finds lane A/B/C functions when they exist, adapts what they return, else placeholders.

The fake lane functions below are the DRAFT of what lanes B and C are expected to provide. If a
real function differs, only sightline/pipeline/lanes.py changes.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import pytest

from sightline.contract import LatLon, MapFile, Pose, SearchSim
from sightline.pipeline.lanes import Lanes, MapFrame
from sightline.pipeline.placeholders import placeholder_map, placeholder_search_sim

LKP = LatLon(lat=49.37, lon=-122.945)
POSE = Pose(lat=49.369812, lon=-122.94613, alt_agl_m=None, heading_deg=90.0, gsd_m=0.02)


def none_available() -> Lanes:
    """Every lane function missing, whatever is installed."""
    names = [
        "simulate_flight",
        "footprint",
        "georef_detection",
        "run_survey",
        "load_split",
        "build_map",
        "simulate",
    ]
    return Lanes(overrides={name: None for name in names})


# ---------------------------------------------------------------- finding functions


def test_a_function_that_cannot_be_imported_is_reported_unavailable_with_a_reason():
    lanes = Lanes(registry={"x": ("sightline.no_such_lane", "f")})

    assert lanes.get("x") is None
    assert "sightline.no_such_lane" in lanes.unavailable["x"]


def test_a_module_without_the_function_is_reported_unavailable():
    lanes = Lanes(registry={"x": ("json", "no_such_function")})

    assert lanes.get("x") is None
    assert "no_such_function" in lanes.unavailable["x"]


def test_an_existing_function_is_found():
    lanes = Lanes(registry={"x": ("json", "dumps")})

    assert lanes.get("x") is not None and lanes.get("x")({"a": 1}) == '{"a": 1}'


def test_overrides_win_over_the_registry():
    lanes = Lanes(overrides={"simulate_flight": lambda n, seed: []})

    assert lanes.get("simulate_flight") is not None


def test_placeholder_use_is_recorded_once_per_function():
    lanes = none_available()

    lanes.flight(20, seed=7)
    lanes.flight(20, seed=7)

    assert lanes.placeholder_notes() == {
        "simulate_flight": "lane B function not available, used the placeholder flight path"
    }


# ---------------------------------------------------------------- lane B: flight, footprint, georef


def test_without_lane_b_the_flight_is_the_placeholder_lawnmower_around_the_default_lkp():
    flight = none_available().flight(500, seed=7)

    assert len(flight.poses) == 500
    assert flight.lkp == LatLon(lat=49.37, lon=-122.945)
    assert "simulated flight path" in flight.area_name


def test_flight_accepts_an_object_with_poses_lkp_and_area_name():
    @dataclass
    class Result:
        poses: list
        lkp: LatLon
        area_name: str

    lkp = LatLon(lat=49.4, lon=-122.9)
    lanes = Lanes(
        overrides={"simulate_flight": lambda n, seed: Result([POSE] * n, lkp, "Somewhere")}
    )

    flight = lanes.flight(3, seed=1)

    assert flight.poses == [POSE] * 3 and flight.lkp == lkp and flight.area_name == "Somewhere"
    assert lanes.placeholder_notes() == {}


def test_flight_accepts_a_dict_with_pose_dicts():
    result = {
        "poses": [POSE.model_dump()] * 2,
        "lkp": {"lat": 49.4, "lon": -122.9},
        "area_name": "A",
    }
    lanes = Lanes(overrides={"simulate_flight": lambda n, seed: result})

    flight = lanes.flight(2, seed=1)

    assert flight.poses[0] == POSE and flight.lkp.lat == 49.4


def test_flight_accepts_a_plain_list_of_poses_and_uses_the_default_area():
    lanes = Lanes(overrides={"simulate_flight": lambda n, seed: [POSE] * n})

    flight = lanes.flight(4, seed=1)

    assert flight.poses == [POSE] * 4 and flight.lkp == LKP


def test_flight_with_the_wrong_number_of_poses_is_rejected():
    lanes = Lanes(overrides={"simulate_flight": lambda n, seed: [POSE] * (n - 1)})

    with pytest.raises(ValueError, match="3 poses.*4 frames"):
        lanes.flight(4, seed=1)


def test_without_lane_b_the_footprint_comes_from_the_geometry_helpers():
    corners = none_available().footprint(POSE)

    assert corners[0] == pytest.approx((-122.946027, 49.369902), abs=1e-6)


def test_footprint_from_lane_b_is_normalised_to_four_lon_lat_tuples():
    lanes = Lanes(
        overrides={
            "footprint": lambda pose, width_px, height_px: [
                [1.0, 2.0],
                [3.0, 4.0],
                [5.0, 6.0],
                [7.0, 8.0],
            ]
        }
    )

    assert lanes.footprint(POSE) == ((1.0, 2.0), (3.0, 4.0), (5.0, 6.0), (7.0, 8.0))


def test_footprint_with_the_wrong_number_of_corners_is_rejected():
    lanes = Lanes(overrides={"footprint": lambda pose, width_px, height_px: [[1.0, 2.0]] * 3})

    with pytest.raises(ValueError, match="4 corners"):
        lanes.footprint(POSE)


def test_without_lane_b_georef_uses_pixel_geometry_and_a_10_m_radius():
    lat, lon, radius = none_available().georef(POSE, (512, 300, 560, 362))

    assert (lat, lon, radius) == pytest.approx((49.369806, -122.946118, 10.0), abs=1e-6)


@pytest.mark.parametrize(
    "result",
    [
        (49.1, -122.1, 7.5),
        {"lat": 49.1, "lon": -122.1, "radius_m": 7.5},
        type("R", (), {"lat": 49.1, "lon": -122.1, "radius_m": 7.5})(),
    ],
    ids=["tuple", "dict", "object"],
)
def test_georef_from_lane_b_accepts_a_tuple_a_dict_or_an_object(result):
    lanes = Lanes(overrides={"georef_detection": lambda pose, box_px, width_px, height_px: result})

    assert lanes.georef(POSE, (1, 1, 9, 9)) == (49.1, -122.1, 7.5)


# ---------------------------------------------------------------- lane A: detect


def test_without_lane_a_detect_writes_empty_detections_and_a_placeholder_config(tmp_path):
    frames = tmp_path / "frames"
    frames.mkdir()
    out = tmp_path / "detect"

    none_available().detect(
        frames, ["f0001", "f0002"], out, weights=None, candidate_threshold=0.25, model_name="m"
    )

    assert '"f0001": []' in (out / "detections_raw.json").read_text()
    assert '"PLACEHOLDER"' in (out / "config.json").read_text()


def test_lane_a_run_survey_is_called_with_its_documented_arguments(tmp_path):
    calls = []

    def run_survey(
        frames_dir, weights, out_dir, candidate_threshold, model_name, save_threshold=0.05
    ):
        calls.append(
            (frames_dir, weights, out_dir, candidate_threshold, model_name, save_threshold)
        )

    lanes = Lanes(overrides={"run_survey": run_survey})

    lanes.detect(
        tmp_path / "frames",
        ["f0001"],
        tmp_path / "detect",
        weights=Path("w.pt"),
        candidate_threshold=0.31,
        model_name="yolo",
    )

    assert calls == [(tmp_path / "frames", Path("w.pt"), tmp_path / "detect", 0.31, "yolo", 0.05)]
    assert lanes.placeholder_notes() == {}


def test_lane_a_without_weights_falls_back_with_a_note(tmp_path):
    lanes = Lanes(
        overrides={"run_survey": lambda *a, **k: pytest.fail("must not run without weights")}
    )

    lanes.detect(
        tmp_path / "frames",
        ["f0001"],
        tmp_path / "detect",
        weights=None,
        candidate_threshold=0.25,
        model_name="m",
    )

    assert "weights" in lanes.placeholder_notes()["run_survey"]


# ---------------------------------------------------------------- lane C: map and simulation


def map_frames() -> list[MapFrame]:
    return [
        MapFrame(
            id="f0001",
            image_path=Path("f0001.jpg"),
            pose=POSE,
            footprint=((0.0, 0.0),) * 4,
            flight_index=0,
        )
    ]


def test_without_lane_c_the_map_is_the_uniform_placeholder():
    map_file, cells = none_available().build_map(map_frames(), LKP, recall=0.8)

    assert map_file.steps[0].cells == [] and cells == {"f0001": []}


def test_map_from_lane_c_may_be_a_map_file_alone_with_cells_taken_from_its_steps():
    placeholder, _ = placeholder_map(["f0001"], LKP, 0.8)
    lanes = Lanes(overrides={"build_map": lambda frames, lkp, recall: placeholder})

    map_file, cells = lanes.build_map(map_frames(), LKP, recall=0.8)

    assert isinstance(map_file, MapFile) and cells == {"f0001": []}


def test_map_from_lane_c_may_be_a_map_file_and_frame_cells_pair():
    placeholder, _ = placeholder_map(["f0001"], LKP, 0.8)
    pair = (placeholder, {"f0001": [(5, 0.31234, 2.0)]})
    lanes = Lanes(overrides={"build_map": lambda frames, lkp, recall: pair})

    _, cells = lanes.build_map(map_frames(), LKP, recall=0.8)

    assert cells == {"f0001": [(5, 0.31234, 2.0)]}


def test_map_from_lane_c_may_be_an_object_with_map_and_frame_cells():
    placeholder, _ = placeholder_map(["f0001"], LKP, 0.8)
    result = type("R", (), {"map": placeholder, "frame_cells": {"f0001": [(1, 0.5, 1.0)]}})()
    lanes = Lanes(overrides={"build_map": lambda frames, lkp, recall: result})

    map_file, cells = lanes.build_map(map_frames(), LKP, recall=0.8)

    assert cells == {"f0001": [(1, 0.5, 1.0)]} and map_file is placeholder


def test_without_lane_c_the_search_simulation_is_the_labelled_placeholder():
    placeholder, cells = placeholder_map(["f0001"], LKP, 0.8)

    sim = none_available().simulate(placeholder, cells)

    assert sim == placeholder_search_sim()


def test_simulation_from_lane_c_accepts_a_search_sim_or_a_dict():
    placeholder, cells = placeholder_map(["f0001"], LKP, 0.8)
    expected = placeholder_search_sim()
    as_dict = expected.model_dump()

    for result in (expected, as_dict):
        lanes = Lanes(overrides={"simulate": lambda map_file, frame_cells, result=result: result})
        sim = lanes.simulate(placeholder, cells)
        assert isinstance(sim, SearchSim) and sim == expected


# ---------------------------------------------------------------- lane A: reading test images


def test_without_lane_a_test_images_are_read_from_the_yolo_folder(tmp_path):
    from PIL import Image

    split = tmp_path / "test"
    (split / "images").mkdir(parents=True)
    (split / "labels").mkdir()
    Image.new("RGB", (4000, 3000)).save(split / "images" / "a.jpg")
    (split / "labels" / "a.txt").write_text("0 0.5 0.5 0.1 0.2\n0 0.25 0.25 0.05 0.05\n")

    images = none_available().test_images(split)

    assert [(i.path.name, i.width, i.height) for i in images] == [("a.jpg", 4000, 3000)]
    box = images[0].boxes[0]
    assert (box.x1, box.y1, box.x2, box.y2) == (1800, 1200, 2200, 1800)
    assert len(images[0].boxes) == 2


def test_stages_can_record_their_own_placeholders():
    lanes = none_available()

    lanes.note_placeholder(
        "detector_metrics", "lane A detector_metrics.json is missing, used zeros"
    )

    assert lanes.placeholder_notes() == {
        "detector_metrics": "lane A detector_metrics.json is missing, used zeros"
    }


# ---------------------------------------------------------------- lane A load_split reads the folder we give it


def test_load_split_from_lane_a_is_told_which_folder_to_read(tmp_path):
    calls = []

    def load_split(split, root=Path("data/heridal/yolo_full")):
        calls.append((split, root))
        return []

    lanes = Lanes(overrides={"load_split": load_split})

    lanes.test_images(tmp_path / "somewhere" / "yolo_full" / "test")

    assert calls == [("test", tmp_path / "somewhere" / "yolo_full")]
    assert lanes.placeholder_notes() == {}


def test_a_load_split_that_takes_no_root_is_called_with_the_split_only(tmp_path):
    calls = []
    lanes = Lanes(overrides={"load_split": lambda split: calls.append(split) or []})

    lanes.test_images(tmp_path / "yolo_full" / "test")

    assert calls == ["test"]


def test_lane_a_reads_exactly_the_folder_given_even_when_it_is_not_called_test(tmp_path):
    calls = []

    def load_split(split, root=None):
        calls.append((split, root))
        return []

    lanes = Lanes(overrides={"load_split": load_split})

    lanes.test_images(tmp_path / "my_photos")

    assert calls == [("my_photos", tmp_path)]


def test_grid_cell_size_is_configurable_and_always_covers_1_km():
    lkp = LatLon(lat=49.37, lon=-122.95)
    default = Lanes()._grid(lkp)
    fine = Lanes()._grid(lkp, 10.0)
    assert (default.rows, default.cols, default.cell_m) == (50, 50, 20.0)
    assert (fine.rows, fine.cols, fine.cell_m) == (100, 100, 10.0)
    # Same 1 km square: the north-west corner does not move.
    assert fine.origin_nw.lat == pytest.approx(default.origin_nw.lat)
    assert fine.origin_nw.lon == pytest.approx(default.origin_nw.lon)


def test_grid_fallback_without_lane_c_also_honours_the_cell_size():
    lanes = Lanes(overrides={"make_grid": None})
    fine = lanes._grid(LatLon(lat=49.37, lon=-122.95), 10.0)
    assert (fine.rows, fine.cols, fine.cell_m) == (100, 100, 10.0)


def test_the_pipeline_default_grid_is_5_m_cells():
    """`run`, single stages, the upload API and the real-GPS build share Context's default."""
    import inspect

    from sightline.pipeline import __main__ as cli
    from sightline.pipeline.stages import DEFAULT_CELL_M, Context

    assert DEFAULT_CELL_M == 5.0
    assert Context().cell_m == DEFAULT_CELL_M
    assert inspect.signature(cli.run).parameters["cell_m"].default == DEFAULT_CELL_M
    grid = Lanes()._grid(LatLon(lat=49.37, lon=-122.95), DEFAULT_CELL_M)
    assert (grid.rows, grid.cols) == (200, 200)
