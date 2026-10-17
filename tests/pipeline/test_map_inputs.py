"""Lane C request 1: build_map receives each frame's candidate detections (conf >= candidate_threshold)."""

from __future__ import annotations

from dataclasses import fields
from pathlib import Path

import pytest
from PIL import Image

from sightline.contract import Pose
from sightline.pipeline.formats import GeoDetection, GeoFile, RawDetectionsFile, write_json
from sightline.pipeline.lanes import Lanes, MapFrame
from sightline.pipeline.placeholders import placeholder_detections, placeholder_map
from sightline.pipeline.stages import Context, detect_stage, frames_stage, map_stage, place_stage

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


def write_detect_files(ctx: Context, detections: dict, threshold: float = 0.25) -> None:
    raw, config = placeholder_detections(IDS, threshold)
    raw = RawDetectionsFile.model_validate(
        {**raw.model_dump(), "frames": {f: detections.get(f, []) for f in IDS}}
    )
    write_json(ctx.work / "detect" / "detections_raw.json", raw)
    write_json(ctx.work / "detect" / "config.json", config)


def write_geo_files(ctx: Context, positions: dict) -> None:
    geo = GeoFile(
        frames={
            f: [
                GeoDetection(box=b, lat=lat, lon=lon, radius_m=r)
                for b, lat, lon, r in positions.get(f, [])
            ]
            for f in IDS
        }
    )
    write_json(ctx.work / "georef" / "detections_geo.json", geo)


def capture_build_map(seen: dict):
    def build_map(frames, lkp, recall, *rest):
        seen["frames"] = list(frames)
        return placeholder_map([f.id for f in frames], lkp, recall)

    return build_map


RAW = {
    "f0005": [
        {"box": [512, 300, 560, 362], "conf": 0.9},
        {"box": [88, 610, 120, 641], "conf": 0.1},
    ],
    "f0012": [{"box": [100, 100, 140, 160], "conf": 0.25}],
}
GEO = {
    "f0005": [
        ((512, 300, 560, 362), 49.3701, -122.9441, 10.0),
        ((88, 610, 120, 641), 49.3702, -122.9442, 10.0),
    ],
    "f0012": [((100, 100, 140, 160), 49.3711, -122.9451, 7.5)],
}


# ---------------------------------------------------------------- the MapFrame itself


def test_a_map_frame_has_a_candidates_field_that_defaults_to_none():
    frame = MapFrame(
        id="f0001",
        image_path=Path("f0001.jpg"),
        pose=POSE,
        footprint=((0.0, 0.0),) * 4,
        flight_index=0,
    )

    assert "candidates" in [f.name for f in fields(MapFrame)]
    assert frame.candidates == ()


# ---------------------------------------------------------------- what the map stage passes


def run_map_stage(tmp_path: Path, raw: dict, geo: dict, threshold: float = 0.25) -> list[MapFrame]:
    seen: dict = {}
    ctx = make_context(tmp_path, build_map=capture_build_map(seen))
    frames_stage(ctx)
    place_stage(ctx)
    write_detect_files(ctx, raw, threshold)
    write_geo_files(ctx, geo)
    map_stage(ctx)
    return seen["frames"]


def test_candidates_are_the_georeferenced_detections_at_or_above_the_threshold(tmp_path):
    frames = {f.id: f for f in run_map_stage(tmp_path, RAW, GEO)}

    assert frames["f0005"].candidates == (
        (49.3701, -122.9441, 10.0),
    )  # the 0.1 detection is left out
    assert frames["f0012"].candidates == ((49.3711, -122.9451, 7.5),)  # conf exactly 0.25 counts


def test_frames_without_candidates_get_an_empty_tuple(tmp_path):
    frames = {f.id: f for f in run_map_stage(tmp_path, RAW, GEO)}

    assert frames["f0001"].candidates == ()


def test_the_threshold_comes_from_the_detect_config(tmp_path):
    frames = {f.id: f for f in run_map_stage(tmp_path, RAW, GEO, threshold=0.95)}

    assert all(f.candidates == () for f in frames.values())


def test_a_frame_keeps_all_of_its_candidates_in_confidence_order(tmp_path):
    raw = {
        "f0005": [
            {"box": [512, 300, 560, 362], "conf": 0.9},
            {"box": [88, 610, 120, 641], "conf": 0.4},
        ]
    }
    geo = {
        "f0005": [
            ((512, 300, 560, 362), 49.3701, -122.9441, 10.0),
            ((88, 610, 120, 641), 49.3702, -122.9442, 10.0),
        ]
    }

    frames = {f.id: f for f in run_map_stage(tmp_path, raw, geo)}

    assert frames["f0005"].candidates == ((49.3701, -122.9441, 10.0), (49.3702, -122.9442, 10.0))


def test_other_map_frame_fields_are_unchanged(tmp_path):
    frame = run_map_stage(tmp_path, RAW, GEO)[0]

    assert frame.id == "f0001" and frame.flight_index == 0 and frame.image_path.name == "f0001.jpg"


# ---------------------------------------------------------------- missing inputs


def test_the_map_stage_needs_the_detect_stage(tmp_path):
    ctx = make_context(tmp_path)
    frames_stage(ctx)
    place_stage(ctx)

    with pytest.raises(FileNotFoundError, match="`detect`"):
        map_stage(ctx)


def test_candidates_without_the_georef_stage_are_an_error_not_a_silent_gap(tmp_path):
    ctx = make_context(tmp_path)
    frames_stage(ctx)
    place_stage(ctx)
    write_detect_files(ctx, RAW)

    with pytest.raises(FileNotFoundError, match="`georef`"):
        map_stage(ctx)


def test_no_candidates_means_georef_is_not_needed(tmp_path):
    ctx = make_context(tmp_path)
    frames_stage(ctx)
    place_stage(ctx)
    detect_stage(ctx)  # placeholder detect: no detections at all

    map_stage(ctx)  # no georef file, and nothing to georeference

    assert (ctx.work / "map" / "map.json").is_file()


def test_raw_and_georef_files_that_do_not_pair_up_are_an_error(tmp_path):
    ctx = make_context(tmp_path)
    frames_stage(ctx)
    place_stage(ctx)
    write_detect_files(ctx, RAW)
    write_geo_files(ctx, {"f0005": GEO["f0005"][:1]})  # f0005 has 2 raw detections but 1 position

    with pytest.raises(ValueError, match=r"f0005.*2 raw.*1 position"):
        map_stage(ctx)
