"""Lanes.simulate with lane C's planned native signature: simulate(map_file, [{idx: (canopy, overlap)}, ...])."""

from __future__ import annotations

from PIL import Image

from sightline.contract import LatLon, SearchSim
from sightline.pipeline.formats import read_json
from sightline.pipeline.lanes import Lanes
from sightline.pipeline.placeholders import placeholder_map, placeholder_search_sim
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


def lanes_with(**overrides) -> Lanes:
    return Lanes(overrides={name: None for name in LANE_NAMES + HELPERS} | overrides)


class NativeSimulate:
    """Same parameters as the lane C doc: simulate(map_file, frame_cells, trials, seed, vis_noise)."""

    def __init__(self, result=None):
        self.calls = []
        self.result = result if result is not None else placeholder_search_sim()

    def __call__(self, map_file, frame_cells, trials=1000, seed=7, vis_noise=0.15):
        self.calls.append((map_file, frame_cells, trials, seed, vis_noise))
        return self.result


def base_map():
    return placeholder_map(["f0001", "f0002", "f0003"], LKP, 0.8)[0]


CELLS = {
    "f0002": [(5, 0.2, 1.0)],
    "f0001": [(10, 0.4, 2.0), (3, 0.1, 1.0)],
    "f0003": [],
}


def test_native_simulate_gets_one_dict_per_frame_in_frame_order():
    native = NativeSimulate()

    lanes_with(simulate=native).simulate(base_map(), CELLS)

    _, per_frame, *_ = native.calls[0]
    assert per_frame == [{10: (0.4, 2.0), 3: (0.1, 1.0)}, {5: (0.2, 1.0)}, {}]


def test_native_simulate_uses_its_own_defaults_for_trials_seed_and_noise():
    native = NativeSimulate()

    lanes_with(simulate=native).simulate(base_map(), CELLS)

    assert native.calls[0][2:] == (1000, 7, 0.15)


def test_unknown_canopy_is_given_as_zero_because_the_native_function_expects_floats():
    native = NativeSimulate()

    lanes_with(simulate=native).simulate(base_map(), {"f0001": [(1, None, 1.0)]})

    assert native.calls[0][1] == [{1: (0.0, 1.0)}]


def test_the_search_sim_it_returns_is_passed_back():
    expected = placeholder_search_sim().model_copy(
        update={"trials": 1000, "found_by_drone_rate": 0.5}
    )

    sim = lanes_with(simulate=NativeSimulate(expected)).simulate(base_map(), CELLS)

    assert isinstance(sim, SearchSim) and sim.trials == 1000 and sim.found_by_drone_rate == 0.5


def test_a_dict_result_is_validated_into_a_search_sim():
    sim = lanes_with(simulate=NativeSimulate(placeholder_search_sim().model_dump())).simulate(
        base_map(), CELLS
    )

    assert sim == placeholder_search_sim()


def test_native_simulate_is_recognised_by_its_trials_parameter_alone():
    seen = []

    def simulate(map_file, frame_cells, trials=10):
        seen.append(frame_cells)
        return placeholder_search_sim()

    lanes_with(simulate=simulate).simulate(base_map(), CELLS)

    assert isinstance(seen[0], list)


def test_the_older_two_argument_simulate_still_gets_the_dict_keyed_by_frame_id():
    seen = []

    def simulate(map_file, frame_cells):
        seen.append(frame_cells)
        return placeholder_search_sim()

    lanes_with(simulate=simulate).simulate(base_map(), CELLS)

    assert seen[0] == CELLS


def test_without_lane_c_simulate_is_still_the_labelled_placeholder():
    lanes = lanes_with()

    assert lanes.simulate(base_map(), CELLS) == placeholder_search_sim()
    assert "simulate" in lanes.placeholder_notes()


# ---------------------------------------------------------------- through the metrics stage


def test_the_metrics_stage_works_with_a_native_build_map_and_simulate(tmp_path):
    split = tmp_path / "data" / "heridal" / "yolo_full" / "test"
    (split / "images").mkdir(parents=True)
    (split / "labels").mkdir()
    for i in range(6):
        Image.new("RGB", (4000, 3000), (80 + i, 110, 70)).save(split / "images" / f"test_{i}.jpg")
        (split / "labels" / f"test_{i}.txt").write_text("0 0.3 0.4 0.0125 0.02\n")

    def build_map(grid, lkp, prior, frames, recall, recall_source):
        map_file, _ = placeholder_map([f.frame_id for f in frames], lkp, recall, recall_source)
        return map_file, [{7: (0.3, 1.0 + n % 3)} for n, _ in enumerate(frames)]

    native = NativeSimulate(placeholder_search_sim().model_copy(update={"trials": 1000}))
    ctx = Context(
        data=tmp_path / "data",
        lanes=lanes_with(build_map=build_map, simulate=native),
        n_frames=40,
        n_positive=3,
    )
    for stage in (frames_stage, place_stage, detect_stage, rank_stage, map_stage):
        stage(ctx)

    metrics_stage(ctx)

    per_frame = native.calls[0][1]
    assert (
        len(per_frame) == 40 and per_frame[0] == {7: (0.3, 1.0)} and per_frame[1] == {7: (0.3, 2.0)}
    )
    assert read_json(ctx.work / "metrics" / "search_sim.json", SearchSim).trials == 1000
