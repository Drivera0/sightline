"""Intermediate files under data/work/ and data/survey/ (the inputs of export_cache)."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from sightline.pipeline.formats import (
    DetectConfig,
    DetectorMetricsFile,
    FrameCellsFile,
    GeoFile,
    PlaceFile,
    RankFile,
    RawDetectionsFile,
    SurveyFrameFile,
    read_json,
    write_json,
)

FOOTPRINT = [
    [-122.946027, 49.369902],
    [-122.946027, 49.369722],
    [-122.946233, 49.369722],
    [-122.946233, 49.369902],
]


def place_example() -> dict:
    return {
        "simulated_path": True,
        "area_name": "Mount Seymour, North Vancouver (simulated flight path)",
        "lkp": {"lat": 49.37, "lon": -122.945},
        "frames": {
            "f0001": {
                "pose": {
                    "lat": 49.369812,
                    "lon": -122.94613,
                    "alt_agl_m": None,
                    "heading_deg": 90.0,
                    "gsd_m": 0.02,
                },
                "footprint": FOOTPRINT,
            }
        },
    }


def test_place_file_holds_pose_and_footprint_per_frame_plus_the_area():
    place = PlaceFile.model_validate(place_example())

    assert place.frames["f0001"].pose.heading_deg == 90.0
    assert place.frames["f0001"].footprint[0] == (-122.946027, 49.369902)
    assert place.lkp.lat == 49.37


def test_place_file_rejects_a_footprint_with_three_corners():
    data = place_example()
    data["frames"]["f0001"]["footprint"] = FOOTPRINT[:3]

    with pytest.raises(ValidationError):
        PlaceFile.model_validate(data)


def test_geo_file_gives_a_position_for_each_raw_detection_with_its_box():
    geo = GeoFile.model_validate(
        {
            "frames": {
                "f0001": [
                    {
                        "box": [512, 300, 560, 362],
                        "lat": 49.369806,
                        "lon": -122.946118,
                        "radius_m": 10.0,
                    }
                ],
                "f0002": [],
            }
        }
    )

    assert geo.frames["f0001"][0].radius_m == 10.0 and geo.frames["f0002"] == []


def test_geo_file_rejects_a_degenerate_box():
    with pytest.raises(ValidationError, match="x2 > x1"):
        GeoFile.model_validate(
            {
                "frames": {
                    "f0001": [{"box": [5, 5, 5, 9], "lat": 49.0, "lon": -122.0, "radius_m": 10.0}]
                }
            }
        )


def test_raw_detections_file_parses_lane_a_documented_example():
    raw = RawDetectionsFile.model_validate(
        {
            "model": "yolo11s-heridal-tiled",
            "save_threshold": 0.05,
            "candidate_threshold": 0.31,
            "frames": {"f0001": [{"box": [512, 300, 560, 362], "conf": 0.874}], "f0002": []},
        }
    )

    assert raw.frames["f0001"][0].conf == 0.874 and raw.frames["f0002"] == []


def test_raw_detections_must_be_sorted_by_descending_confidence():
    with pytest.raises(ValidationError, match="descending"):
        RawDetectionsFile.model_validate(
            {
                "model": "m",
                "save_threshold": 0.05,
                "candidate_threshold": 0.3,
                "frames": {
                    "f0001": [
                        {"box": [1, 1, 9, 9], "conf": 0.2},
                        {"box": [1, 1, 9, 9], "conf": 0.6},
                    ]
                },
            }
        )


def test_detect_config_parses_lane_a_documented_example():
    config = DetectConfig.model_validate(
        {
            "weights": "data/weights/best.pt",
            "model": "yolo11s-heridal-tiled",
            "candidate_threshold": 0.31,
            "save_threshold": 0.05,
        }
    )

    assert config.candidate_threshold == 0.31


def test_detector_metrics_file_holds_the_detector_block_and_ablations():
    voc = {"precision": 0.8, "recall": 0.75, "ap50": 0.7}
    file = DetectorMetricsFile.model_validate(
        {
            "detector": {
                "model": "m",
                "test_images": 101,
                "tiled": True,
                "threshold": 0.31,
                "voc": voc,
                "sar": {"precision": 0.8, "recall": 0.8, "ap": 0.7},
                "recall": 0.75,
                "seconds_per_image": 0.9,
            },
            "ablations": [{"name": "Fine-tuned + tiling", "voc": voc}],
        }
    )

    assert file.detector.recall == 0.75 and file.ablations[0].name == "Fine-tuned + tiling"


def test_rank_file_stores_score_rank_and_candidates_per_frame():
    rank = RankFile.model_validate(
        {
            "frames": {
                "f0001": {"score": 0.9, "rank": 1, "n_candidates": 1},
                "f0002": {"score": 0.0, "rank": 2, "n_candidates": 0},
            }
        }
    )

    assert rank.frames["f0002"].rank == 2


def test_rank_file_ranks_must_be_one_to_n():
    with pytest.raises(ValidationError, match="1..N"):
        RankFile.model_validate(
            {
                "frames": {
                    "f0001": {"score": 0.9, "rank": 1, "n_candidates": 1},
                    "f0002": {"score": 0.0, "rank": 3, "n_candidates": 0},
                }
            }
        )


def test_frame_cells_file_lists_covered_cells_with_unrounded_pod():
    cells = FrameCellsFile.model_validate({"frames": {"f0001": [[1234, 0.21044], [1235, 0.0004]]}})

    assert cells.frames["f0001"][1] == (1235, 0.0004)


def test_frame_cells_pod_must_be_a_probability():
    with pytest.raises(ValidationError):
        FrameCellsFile.model_validate({"frames": {"f0001": [[1, 1.5]]}})


def test_survey_frame_file_matches_what_write_survey_writes():
    frames = SurveyFrameFile.model_validate(
        [
            {
                "id": "f0001",
                "flight_index": 0,
                "source_image": "a.jpg",
                "x0": 1000,
                "y0": 750,
                "path": "data/survey/frames/f0001.jpg",
            }
        ]
    )

    assert frames.root[0].source_image == "a.jpg"


def test_write_then_read_round_trips(tmp_path):
    place = PlaceFile.model_validate(place_example())

    write_json(tmp_path / "place" / "poses.json", place)

    assert read_json(tmp_path / "place" / "poses.json", PlaceFile) == place


def test_unknown_fields_are_rejected():
    data = place_example()
    data["frames"]["f0001"]["speed_m_s"] = 5

    with pytest.raises(ValidationError, match="speed_m_s"):
        PlaceFile.model_validate(data)


def test_reading_a_missing_file_names_the_file_and_the_stage_that_makes_it(tmp_path):
    with pytest.raises(FileNotFoundError, match=r"poses\.json.*place"):
        read_json(tmp_path / "place" / "poses.json", PlaceFile, produced_by="place")


def test_reading_a_malformed_file_names_the_file(tmp_path):
    path = tmp_path / "rank.json"
    path.write_text('{"frames": {"f0001": {"score": "high"}}}')

    with pytest.raises(ValueError, match=r"rank\.json"):
        read_json(path, RankFile)
