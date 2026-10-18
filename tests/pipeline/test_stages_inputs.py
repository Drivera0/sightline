"""Stages frames, place, detect and georef, run against a tiny fake HERIDAL test split."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from PIL import Image

from sightline.contract import Pose
from sightline.pipeline.formats import (
    DetectConfig,
    GeoFile,
    PlaceFile,
    RawDetectionsFile,
    SurveyFrameFile,
    read_json,
    write_json,
)
from sightline.pipeline.lanes import Lanes
from sightline.pipeline.stages import Context, detect_stage, frames_stage, georef_stage, place_stage

N_FRAMES, N_POSITIVE = 40, 3


def no_lanes() -> Lanes:
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


@pytest.fixture
def ctx(tmp_path) -> Context:
    """Six 4000x3000 photos, each with one person in frame (row 1, col 1)."""
    split = tmp_path / "data" / "heridal" / "yolo_full" / "test"
    (split / "images").mkdir(parents=True)
    (split / "labels").mkdir()
    for i in range(6):
        Image.new("RGB", (4000, 3000), (80 + i, 110, 70)).save(split / "images" / f"test_{i}.jpg")
        (split / "labels" / f"test_{i}.txt").write_text("0 0.3 0.4 0.0125 0.02\n")
    return Context(
        data=tmp_path / "data", lanes=no_lanes(), n_frames=N_FRAMES, n_positive=N_POSITIVE
    )


def frame_ids() -> list[str]:
    return [f"f{i:04d}" for i in range(1, N_FRAMES + 1)]


# ---------------------------------------------------------------- frames


def test_frames_stage_writes_jpegs_frame_list_and_truth(ctx):
    frames_stage(ctx)

    jpegs = sorted((ctx.survey_dir / "frames").glob("*.jpg"))
    assert [p.stem for p in jpegs] == frame_ids()
    assert Image.open(jpegs[0]).size == (1000, 750)
    listed = read_json(ctx.survey_dir / "frames.json", SurveyFrameFile).root
    assert [f.id for f in listed] == frame_ids()
    truth = json.loads((ctx.survey_dir / "truth.json").read_text())
    assert sum(1 for boxes in truth.values() if boxes) == N_POSITIVE


def test_frames_stage_is_deterministic(ctx):
    frames_stage(ctx)
    first = (
        (ctx.survey_dir / "frames.json").read_text(),
        (ctx.survey_dir / "truth.json").read_text(),
    )

    frames_stage(ctx)

    assert (
        (ctx.survey_dir / "frames.json").read_text(),
        (ctx.survey_dir / "truth.json").read_text(),
    ) == first


def test_frames_stage_uses_lane_a_when_it_has_load_split(ctx, tmp_path):
    from sightline.pipeline.survey import read_yolo_split

    photos = read_yolo_split(ctx.test_dir)
    lanes = Lanes(overrides={"load_split": lambda split: photos})
    lanes_ctx = Context(
        data=ctx.data,
        lanes=lanes,
        n_frames=N_FRAMES,
        n_positive=N_POSITIVE,
        test_dir=tmp_path / "nowhere",
    )

    frames_stage(lanes_ctx)

    assert len(list((lanes_ctx.survey_dir / "frames").glob("*.jpg"))) == N_FRAMES


# ---------------------------------------------------------------- place


def test_place_stage_gives_every_frame_a_pose_and_footprint(ctx):
    frames_stage(ctx)

    place_stage(ctx)

    place = read_json(ctx.work / "place" / "poses.json", PlaceFile)
    assert list(place.frames) == frame_ids()
    assert place.simulated_path is True
    assert place.lkp.lat == pytest.approx(49.37)


def test_place_stage_reports_the_stage_that_must_run_first(ctx):
    with pytest.raises(FileNotFoundError, match="`frames`"):
        place_stage(ctx)


def test_place_stage_uses_lane_b_when_it_exists(ctx):
    frames_stage(ctx)
    pose = Pose(lat=49.4, lon=-122.9, alt_agl_m=None, heading_deg=270.0, gsd_m=0.02)
    lanes = Lanes(
        overrides={
            "simulate_flight": lambda n, seed: [pose] * n,
            "footprint": lambda p, w, h: [[1.0, 2.0], [3.0, 4.0], [5.0, 6.0], [7.0, 8.0]],
        }
    )
    lane_ctx = Context(data=ctx.data, lanes=lanes, n_frames=N_FRAMES, n_positive=N_POSITIVE)

    place_stage(lane_ctx)

    place = read_json(ctx.work / "place" / "poses.json", PlaceFile)
    assert place.frames["f0001"].pose == pose
    assert place.frames["f0001"].footprint[0] == (1.0, 2.0)
    assert lanes.placeholder_notes().get("simulate_flight") is None


def test_place_stage_rejects_a_flight_with_a_different_frame_count(ctx):
    frames_stage(ctx)
    pose = Pose(lat=49.4, lon=-122.9, alt_agl_m=None, heading_deg=90.0, gsd_m=0.02)
    lanes = Lanes(overrides={"simulate_flight": lambda n, seed: [pose] * (n + 1)})
    lane_ctx = Context(data=ctx.data, lanes=lanes, n_frames=N_FRAMES, n_positive=N_POSITIVE)

    with pytest.raises(ValueError, match="41 poses.*40 frames"):
        place_stage(lane_ctx)


# ---------------------------------------------------------------- detect


def test_detect_stage_without_lane_a_writes_empty_placeholder_detections(ctx):
    frames_stage(ctx)

    detect_stage(ctx)

    raw = read_json(ctx.work / "detect" / "detections_raw.json", RawDetectionsFile)
    config = read_json(ctx.work / "detect" / "config.json", DetectConfig)
    assert list(raw.frames) == frame_ids() and all(v == [] for v in raw.frames.values())
    assert config.model == "PLACEHOLDER"
    assert "run_survey" in ctx.lanes.placeholder_notes()


def test_detect_stage_hands_lane_a_the_survey_frames_and_settings(ctx):
    frames_stage(ctx)
    calls = []
    lanes = Lanes(overrides={"run_survey": lambda *args: calls.append(args)})
    lane_ctx = Context(
        data=ctx.data,
        lanes=lanes,
        n_frames=N_FRAMES,
        n_positive=N_POSITIVE,
        weights=Path("data/weights/best.pt"),
        candidate_threshold=0.31,
        model_name="yolo11s-heridal-tiled",
    )

    detect_stage(lane_ctx)

    assert calls == [
        (
            ctx.survey_dir / "frames",
            Path("data/weights/best.pt"),
            ctx.work / "detect",
            0.31,
            "yolo11s-heridal-tiled",
            0.05,
        )
    ]


# ---------------------------------------------------------------- georef


def write_raw(ctx: Context, frames: dict) -> None:
    raw = RawDetectionsFile.model_validate(
        {
            "model": "m",
            "save_threshold": 0.05,
            "candidate_threshold": 0.25,
            "frames": {f: frames.get(f, []) for f in frame_ids()},
        }
    )
    write_json(ctx.work / "detect" / "detections_raw.json", raw)


def test_georef_stage_pairs_each_raw_detection_with_a_position_and_its_box(ctx):
    frames_stage(ctx)
    place_stage(ctx)
    write_raw(
        ctx,
        {
            "f0005": [
                {"box": [512, 300, 560, 362], "conf": 0.9},
                {"box": [88, 610, 120, 641], "conf": 0.1},
            ]
        },
    )

    georef_stage(ctx)

    geo = read_json(ctx.work / "georef" / "detections_geo.json", GeoFile)
    assert [d.box for d in geo.frames["f0005"]] == [(512, 300, 560, 362), (88, 610, 120, 641)]
    assert all(d.radius_m == 10.0 for d in geo.frames["f0005"])
    assert geo.frames["f0006"] == [] and list(geo.frames) == frame_ids()


def test_georef_position_is_where_the_pixel_is_on_the_ground(ctx):
    frames_stage(ctx)
    place_stage(ctx)
    pose = read_json(ctx.work / "place" / "poses.json", PlaceFile).frames["f0005"].pose
    write_raw(
        ctx, {"f0005": [{"box": [480, 355, 520, 395], "conf": 0.9}]}
    )  # centred on pixel (500, 375)

    georef_stage(ctx)

    detection = read_json(ctx.work / "georef" / "detections_geo.json", GeoFile).frames["f0005"][0]
    assert (detection.lat, detection.lon) == pytest.approx((pose.lat, pose.lon), abs=1e-9)


def test_georef_stage_needs_the_detect_and_place_stages(ctx):
    frames_stage(ctx)

    with pytest.raises(FileNotFoundError, match="`place`|`detect`"):
        georef_stage(ctx)


def test_georef_stage_uses_lane_b_when_it_exists(ctx):
    frames_stage(ctx)
    place_stage(ctx)
    write_raw(ctx, {"f0005": [{"box": [512, 300, 560, 362], "conf": 0.9}]})
    lanes = Lanes(overrides={"georef_detection": lambda pose, box, w, h: (49.1, -122.1, 7.5)})
    lane_ctx = Context(data=ctx.data, lanes=lanes, n_frames=N_FRAMES, n_positive=N_POSITIVE)

    georef_stage(lane_ctx)

    detection = read_json(ctx.work / "georef" / "detections_geo.json", GeoFile).frames["f0005"][0]
    assert (detection.lat, detection.lon, detection.radius_m) == (49.1, -122.1, 7.5)
