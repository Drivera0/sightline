"""Stages rank, map, metrics and export, and the whole chain on placeholders."""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from PIL import Image

from sightline.contract import LatLon, MapFile, Metrics, SearchSim
from sightline.pipeline.export import CacheValidationError, validate_cache
from sightline.pipeline.formats import (
    DetectorMetricsFile,
    FrameCellsFile,
    PlaceFile,
    RankFile,
    RawDetectionsFile,
    read_json,
    write_json,
)
from sightline.pipeline.lanes import Lanes, MapFrame
from sightline.pipeline.mapmath import normalise_map
from sightline.pipeline.placeholders import (
    placeholder_detections,
    placeholder_detector_metrics,
    placeholder_map,
    placeholder_search_sim,
)
from sightline.pipeline.stages import (
    Context,
    detect_stage,
    export_stage,
    frames_stage,
    georef_stage,
    map_stage,
    metrics_stage,
    place_stage,
    rank_stage,
)

N_FRAMES, N_POSITIVE = 40, 3
IDS = [f"f{i:04d}" for i in range(1, N_FRAMES + 1)]


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


def make_context(tmp_path: Path, lanes: Lanes | None = None) -> Context:
    split = tmp_path / "data" / "heridal" / "yolo_full" / "test"
    if not split.exists():
        (split / "images").mkdir(parents=True)
        (split / "labels").mkdir()
        for i in range(6):
            Image.new("RGB", (4000, 3000), (80 + i, 110, 70)).save(
                split / "images" / f"test_{i}.jpg"
            )
            (split / "labels" / f"test_{i}.txt").write_text("0 0.3 0.4 0.0125 0.02\n")
    return Context(
        data=tmp_path / "data", lanes=lanes or no_lanes(), n_frames=N_FRAMES, n_positive=N_POSITIVE
    )


@pytest.fixture
def ctx(tmp_path) -> Context:
    return make_context(tmp_path)


def write_detections(
    ctx: Context, detections: dict, threshold: float = 0.25, crops: bool = True
) -> None:
    """Write lane A's files as run_survey would: raw detections, config and one crop per candidate."""
    raw, config = placeholder_detections(IDS, threshold)
    raw = RawDetectionsFile.model_validate(
        {
            **raw.model_dump(),
            "frames": {f: detections.get(f, []) for f in IDS},
            "model": "yolo-test",
        }
    )
    config = config.model_copy(update={"model": "yolo-test"})
    write_json(ctx.work / "detect" / "detections_raw.json", raw)
    write_json(ctx.work / "detect" / "config.json", config)
    (ctx.work / "detect" / "crops").mkdir(parents=True, exist_ok=True)
    if crops:
        for frame_id, dets in detections.items():
            for n, d in enumerate(dets, start=1):
                if d["conf"] >= threshold:
                    Image.new("RGB", (256, 256), (200, 90, 40)).save(
                        ctx.work / "detect" / "crops" / f"{frame_id}-d{n:02d}.jpg"
                    )


DETECTIONS = {
    "f0010": [{"box": [512, 300, 560, 362], "conf": 0.9}],
    "f0003": [
        {"box": [100, 100, 140, 160], "conf": 0.6},
        {"box": [300, 300, 330, 340], "conf": 0.3},
    ],
    "f0020": [{"box": [700, 400, 740, 460], "conf": 0.6}],
}


# ---------------------------------------------------------------- rank


def test_rank_stage_ranks_frames_by_score_then_candidates_then_flight_order(ctx):
    frames_stage(ctx)
    write_detections(ctx, DETECTIONS)

    rank_stage(ctx)

    rank = read_json(ctx.work / "rank" / "rank.json", RankFile)
    assert rank.frames["f0010"].rank == 1
    assert (rank.frames["f0003"].rank, rank.frames["f0003"].n_candidates) == (2, 2)
    assert (rank.frames["f0020"].rank, rank.frames["f0020"].n_candidates) == (3, 1)
    assert rank.frames["f0001"].rank == 4 and rank.frames["f0001"].score == 0.0


def test_rank_stage_takes_the_candidate_threshold_from_the_detect_config(ctx):
    frames_stage(ctx)
    write_detections(ctx, DETECTIONS, threshold=0.5)

    rank_stage(ctx)

    assert read_json(ctx.work / "rank" / "rank.json", RankFile).frames["f0003"].n_candidates == 1


def test_rank_stage_needs_the_detect_stage(ctx):
    frames_stage(ctx)

    with pytest.raises(FileNotFoundError, match="`detect`"):
        rank_stage(ctx)


# ---------------------------------------------------------------- map


def prepare_for_map(ctx: Context) -> None:
    frames_stage(ctx)
    place_stage(ctx)
    detect_stage(ctx)


def test_map_stage_without_lane_c_writes_a_placeholder_map_with_one_step_per_frame(ctx):
    prepare_for_map(ctx)

    map_stage(ctx)

    map_file = read_json(ctx.work / "map" / "map.json", MapFile)
    assert [s.frame_id for s in map_file.steps] == IDS
    assert map_file.params.recall == 0.80
    assert "build_map" in ctx.lanes.placeholder_notes()


def test_map_stage_takes_recall_from_the_detector_metrics_when_lane_a_wrote_them(ctx):
    prepare_for_map(ctx)
    metrics = placeholder_detector_metrics(0.25).model_dump()
    metrics["detector"]["recall"] = metrics["detector"]["voc"]["recall"] = 0.75
    write_json(
        ctx.work / "detect" / "detector_metrics.json", DetectorMetricsFile.model_validate(metrics)
    )

    map_stage(ctx)

    assert read_json(ctx.work / "map" / "map.json", MapFile).params.recall == 0.75


def test_map_stage_hands_lane_c_the_frames_the_lkp_and_the_recall(ctx):
    prepare_for_map(ctx)
    seen = {}

    def build_map(frames, lkp, recall):
        seen.update(frames=frames, lkp=lkp, recall=recall)
        return placeholder_map([f.id for f in frames], lkp, recall)[0]

    lane_ctx = make_context(ctx.data.parent, Lanes(overrides={"build_map": build_map}))

    map_stage(lane_ctx)

    place = read_json(ctx.work / "place" / "poses.json", PlaceFile)
    frames: list[MapFrame] = seen["frames"]
    assert [f.id for f in frames] == IDS
    assert frames[0].image_path == ctx.survey_dir / "frames" / "f0001.jpg"
    assert frames[0].pose == place.frames["f0001"].pose
    assert frames[0].footprint == place.frames["f0001"].footprint
    assert [f.flight_index for f in frames] == list(range(N_FRAMES))
    assert seen["lkp"] == place.lkp and seen["recall"] == 0.80
    assert lane_ctx.lanes.placeholder_notes() == {}


def test_map_stage_makes_whatever_lane_c_returns_obey_the_contract(ctx):
    prepare_for_map(ctx)
    base, _ = placeholder_map(IDS, LatLon(lat=49.37, lon=-122.945), 0.8)
    data = base.model_dump()
    data["steps"] = [{"frame_id": f, "cells": [(10, 0.123456), (11, 0.0004)]} for f in IDS]
    messy = MapFile.model_validate(data)
    lane_ctx = make_context(
        ctx.data.parent, Lanes(overrides={"build_map": lambda frames, lkp, recall: messy})
    )

    map_stage(lane_ctx)

    written = read_json(ctx.work / "map" / "map.json", MapFile)
    assert written == normalise_map(messy)
    assert written.steps[0].cells == [(10, 0.1235)]


def test_map_stage_also_writes_the_covered_cells_for_the_simulation(ctx):
    prepare_for_map(ctx)
    base, _ = placeholder_map(IDS, LatLon(lat=49.37, lon=-122.945), 0.8)
    pair = (base, {f: [(10, 0.123456)] for f in IDS})
    lane_ctx = make_context(
        ctx.data.parent, Lanes(overrides={"build_map": lambda frames, lkp, recall: pair})
    )

    map_stage(lane_ctx)

    cells = read_json(ctx.work / "map" / "frame_cells.json", FrameCellsFile)
    assert cells.frames["f0001"] == [(10, 0.123456)]


def test_map_stage_needs_the_place_stage(ctx):
    frames_stage(ctx)

    with pytest.raises(FileNotFoundError, match="`place`"):
        map_stage(ctx)


# ---------------------------------------------------------------- metrics


def prepare_for_metrics(ctx: Context) -> None:
    prepare_for_map(ctx)
    rank_stage(ctx)
    map_stage(ctx)


def test_metrics_stage_without_lane_a_metrics_writes_labelled_zeros(ctx):
    prepare_for_metrics(ctx)

    metrics_stage(ctx)

    detector = read_json(ctx.work / "metrics" / "detector_metrics.json", DetectorMetricsFile)
    assert detector.detector.model == "PLACEHOLDER"
    assert "detector_metrics" in ctx.lanes.placeholder_notes()


def test_metrics_stage_copies_lane_a_metrics_when_they_exist(ctx):
    prepare_for_metrics(ctx)
    real = placeholder_detector_metrics(0.31).model_dump()
    real["detector"].update(model="yolo-real", test_images=101)
    write_json(
        ctx.work / "detect" / "detector_metrics.json", DetectorMetricsFile.model_validate(real)
    )

    metrics_stage(ctx)

    copied = read_json(ctx.work / "metrics" / "detector_metrics.json", DetectorMetricsFile)
    assert copied.detector.model == "yolo-real" and copied.detector.test_images == 101
    assert "detector_metrics" not in ctx.lanes.placeholder_notes()


def test_metrics_stage_measures_ranking_against_the_hidden_truth(ctx):
    prepare_for_metrics(ctx)  # no detections, so ranked order equals flight order

    metrics_stage(ctx)

    ranking = json.loads((ctx.work / "metrics" / "ranking.json").read_text())
    assert (ranking["n_frames"], ranking["n_positive"]) == (N_FRAMES, N_POSITIVE)
    assert ranking["ranked"] == ranking["flight_order"]
    assert ranking["expected_first_hit_random_order"] == pytest.approx(
        (N_FRAMES + 1) / (N_POSITIVE + 1)
    )


def test_ranking_improves_when_the_detector_finds_the_people(ctx):
    frames_stage(ctx)
    place_stage(ctx)
    truth = json.loads((ctx.survey_dir / "truth.json").read_text())
    positives = [f for f, boxes in truth.items() if boxes]
    late = max(positives)  # the positive frame that is last in flight order
    write_detections(ctx, {late: [{"box": truth[late][0], "conf": 0.95}]})
    georef_stage(ctx)
    rank_stage(ctx)
    map_stage(ctx)

    metrics_stage(ctx)

    ranking = json.loads((ctx.work / "metrics" / "ranking.json").read_text())
    assert ranking["ranked"]["frames_to_first_hit"] == 1
    assert ranking["flight_order"]["frames_to_first_hit"] > 1


def test_metrics_stage_without_lane_c_writes_the_labelled_placeholder_simulation(ctx):
    prepare_for_metrics(ctx)

    metrics_stage(ctx)

    sim = read_json(ctx.work / "metrics" / "search_sim.json", SearchSim)
    assert sim == placeholder_search_sim()
    assert "simulate" in ctx.lanes.placeholder_notes()


def test_metrics_stage_uses_lane_c_simulation_when_it_exists(ctx):
    prepare_for_metrics(ctx)
    real = placeholder_search_sim().model_dump()
    real.update(trials=1000, found_by_drone_rate=0.5)
    lane_ctx = make_context(
        ctx.data.parent, Lanes(overrides={"simulate": lambda m, c: real, "run_survey": None})
    )

    metrics_stage(lane_ctx)

    assert read_json(ctx.work / "metrics" / "search_sim.json", SearchSim).trials == 1000


def test_metrics_stage_needs_the_rank_and_map_stages(ctx):
    prepare_for_map(ctx)

    with pytest.raises(FileNotFoundError, match="`rank`"):
        metrics_stage(ctx)


# ---------------------------------------------------------------- export, and the whole chain


def run_chain(ctx: Context) -> None:
    for stage in (
        frames_stage,
        place_stage,
        detect_stage,
        georef_stage,
        rank_stage,
        map_stage,
        metrics_stage,
    ):
        stage(ctx)


def test_the_whole_chain_on_placeholders_gives_a_valid_cache(ctx, tmp_path):
    out = tmp_path / "cache" / "demo"
    run_chain(ctx)

    export_stage(ctx, out, survey_id="demo")

    assert validate_cache(out) == []
    metrics = Metrics.model_validate_json((out / "metrics.json").read_text())
    assert metrics.detector.model == "PLACEHOLDER"


def test_the_manifest_says_which_lanes_were_placeholders(ctx, tmp_path):
    out = tmp_path / "cache" / "demo"
    run_chain(ctx)

    export_stage(ctx, out, survey_id="demo")

    notes = json.loads((out / "manifest.json").read_text())["notes"]
    for name in ("simulate_flight", "build_map", "simulate", "detector_metrics", "run_survey"):
        assert name in notes


def test_the_whole_chain_with_detections_and_crops_gives_a_valid_cache(ctx, tmp_path):
    out = tmp_path / "cache" / "demo"
    for stage in (frames_stage, place_stage):
        stage(ctx)
    write_detections(ctx, DETECTIONS)
    for stage in (georef_stage, rank_stage, map_stage, metrics_stage):
        stage(ctx)

    export_stage(ctx, out, survey_id="demo")

    assert validate_cache(out) == []
    detections = json.loads((out / "detections.json").read_text())
    assert detections["frames"]["f0010"][0]["crop"] == "crops/f0010-d01.jpg"
    assert (out / "crops" / "f0010-d01.jpg").is_file()


def test_a_missing_crop_stops_the_export(ctx, tmp_path):
    out = tmp_path / "cache" / "demo"
    for stage in (frames_stage, place_stage):
        stage(ctx)
    write_detections(ctx, DETECTIONS, crops=False)
    for stage in (georef_stage, rank_stage, map_stage, metrics_stage):
        stage(ctx)

    with pytest.raises(CacheValidationError, match="crops/f0010-d01.jpg"):
        export_stage(ctx, out, survey_id="demo")

    assert not out.exists()


def test_the_exported_cache_never_contains_ground_truth(ctx, tmp_path):
    out = tmp_path / "cache" / "demo"
    run_chain(ctx)

    export_stage(ctx, out, survey_id="demo")

    assert not list(out.rglob("*truth*"))
    assert (
        ctx.survey_dir / "truth.json"
    ).is_file()  # it exists beside the survey, just not in the cache


def test_export_stage_copies_to_the_web_folder_when_asked(ctx, tmp_path):
    out, web = tmp_path / "cache" / "demo", tmp_path / "web" / "public" / "cache" / "demo"
    run_chain(ctx)

    export_stage(ctx, out, survey_id="demo", web_out=web)

    assert validate_cache(web) == []
