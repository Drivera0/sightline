"""Lane C request 3: build_map is told where the recall comes from (real detector metrics or the 0.80 placeholder)."""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

from sightline.contract import LatLon, MapFile, Pose
from sightline.pipeline.formats import DetectorMetricsFile, read_json, write_json
from sightline.pipeline.lanes import Lanes, MapFrame
from sightline.pipeline.placeholders import placeholder_detector_metrics, placeholder_map
from sightline.pipeline.stages import Context, detect_stage, frames_stage, map_stage, place_stage

LKP = LatLon(lat=49.37, lon=-122.945)
N_FRAMES, N_POSITIVE = 40, 3
IDS = [f"f{i:04d}" for i in range(1, N_FRAMES + 1)]
LANE_NAMES = [
    "simulate_flight",
    "footprint",
    "georef_detection",
    "run_survey",
    "load_split",
    "build_map",
    "simulate",
]
POSE = Pose(lat=49.37, lon=-122.945, alt_agl_m=None, heading_deg=90.0, gsd_m=0.02)


def one_frame() -> list[MapFrame]:
    return [
        MapFrame(
            id="f0001",
            image_path=Path("f0001.jpg"),
            pose=POSE,
            footprint=((0.0, 0.0),) * 4,
            flight_index=0,
        )
    ]


def placeholder_for(frames, lkp, recall, source="metrics.detector.recall"):
    return placeholder_map([f.id for f in frames], lkp, recall, source)


# ---------------------------------------------------------------- placeholder_map


def test_placeholder_map_records_the_recall_source_it_is_given():
    map_file, _ = placeholder_map(["f0001"], LKP, 0.8, "placeholder")

    assert map_file.params.recall_source == "placeholder"


def test_placeholder_map_keeps_its_old_default_source():
    map_file, _ = placeholder_map(["f0001"], LKP, 0.8)

    assert map_file.params.recall_source == "metrics.detector.recall"


# ---------------------------------------------------------------- the Lanes adapter


def test_a_build_map_that_takes_four_arguments_gets_the_recall_source_fourth():
    calls = []

    def build_map(frames, lkp, recall, recall_source):
        calls.append((lkp, recall, recall_source))
        return placeholder_for(frames, lkp, recall, recall_source)[0]

    Lanes(overrides={"build_map": build_map}).build_map(
        one_frame(), LKP, 0.75, "metrics.detector.recall"
    )

    assert calls == [(LKP, 0.75, "metrics.detector.recall")]


def test_a_build_map_that_takes_three_arguments_still_works_without_it():
    calls = []

    def build_map(frames, lkp, recall):
        calls.append(recall)
        return placeholder_for(frames, lkp, recall)[0]

    map_file, _ = Lanes(overrides={"build_map": build_map}).build_map(
        one_frame(), LKP, 0.8, "placeholder"
    )

    assert calls == [0.8] and isinstance(map_file, MapFile)


def test_a_build_map_with_star_args_gets_the_recall_source():
    seen = []

    def build_map(*args):
        seen.append(args[3:])
        return placeholder_for(args[0], args[1], args[2])[0]

    Lanes(overrides={"build_map": build_map}).build_map(one_frame(), LKP, 0.8, "placeholder")

    assert seen == [("placeholder",)]


def test_the_recall_source_defaults_to_the_detector_metrics_name():
    seen = []

    def build_map(frames, lkp, recall, recall_source):
        seen.append(recall_source)
        return placeholder_for(frames, lkp, recall, recall_source)[0]

    Lanes(overrides={"build_map": build_map}).build_map(one_frame(), LKP, 0.8)

    assert seen == ["metrics.detector.recall"]


def test_without_lane_c_the_placeholder_map_carries_the_source():
    lanes = Lanes(overrides={"build_map": None})

    map_file, _ = lanes.build_map(one_frame(), LKP, 0.8, "placeholder")

    assert map_file.params.recall_source == "placeholder"


# ---------------------------------------------------------------- the map stage


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


def write_real_detector_metrics(ctx: Context, recall: float) -> None:
    data = placeholder_detector_metrics(0.25).model_dump()
    data["detector"]["recall"] = data["detector"]["voc"]["recall"] = recall
    write_json(
        ctx.work / "detect" / "detector_metrics.json", DetectorMetricsFile.model_validate(data)
    )


def test_the_map_stage_says_the_recall_is_the_detectors_when_lane_a_wrote_metrics(tmp_path):
    seen = {}

    def build_map(frames, lkp, recall, recall_source):
        seen.update(recall=recall, source=recall_source)
        return placeholder_for(frames, lkp, recall, recall_source)[0]

    ctx = make_context(tmp_path, build_map=build_map)
    for stage in (frames_stage, place_stage, detect_stage):
        stage(ctx)
    write_real_detector_metrics(ctx, 0.62)

    map_stage(ctx)

    assert seen == {"recall": 0.62, "source": "metrics.detector.recall"}


def test_the_map_stage_says_placeholder_when_there_are_no_detector_metrics(tmp_path):
    seen = {}

    def build_map(frames, lkp, recall, recall_source):
        seen.update(recall=recall, source=recall_source)
        return placeholder_for(frames, lkp, recall, recall_source)[0]

    ctx = make_context(tmp_path, build_map=build_map)
    for stage in (frames_stage, place_stage, detect_stage):
        stage(ctx)

    map_stage(ctx)

    assert seen == {"recall": 0.80, "source": "placeholder"}


@pytest.mark.parametrize(
    ("with_metrics", "expected"), [(True, "metrics.detector.recall"), (False, "placeholder")]
)
def test_map_json_records_the_source_even_without_lane_c(tmp_path, with_metrics, expected):
    ctx = make_context(tmp_path)
    for stage in (frames_stage, place_stage, detect_stage):
        stage(ctx)
    if with_metrics:
        write_real_detector_metrics(ctx, 0.62)

    map_stage(ctx)

    assert read_json(ctx.work / "map" / "map.json", MapFile).params.recall_source == expected
