"""run_pipeline: all stages in order, timings, skips, failures, and the manifest."""

from __future__ import annotations

import itertools
import json
import subprocess
from pathlib import Path

import pytest
from PIL import Image

from sightline.contract import Manifest
from sightline.pipeline.export import validate_cache
from sightline.pipeline.formats import RawDetectionsFile, write_json
from sightline.pipeline.lanes import Lanes
from sightline.pipeline.placeholders import placeholder_detections
from sightline.pipeline.runner import STAGE_ORDER, StageFailed, current_git_sha, run_pipeline
from sightline.pipeline.stages import Context

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
    lane_overrides = {name: None for name in LANE_NAMES} | overrides
    return Context(
        data=tmp_path / "data",
        lanes=Lanes(overrides=lane_overrides),
        n_frames=N_FRAMES,
        n_positive=N_POSITIVE,
    )


def ticking_clock():
    """Every call returns 1 s later, so each stage takes exactly 1 s."""
    counter = itertools.count()
    return lambda: float(next(counter))


def manifest_of(out: Path) -> Manifest:
    return Manifest.model_validate_json((out / "manifest.json").read_text())


# ---------------------------------------------------------------- the full run


def test_stage_order_is_the_eight_pipeline_stages():
    assert STAGE_ORDER == (
        "frames",
        "place",
        "detect",
        "georef",
        "rank",
        "map",
        "metrics",
        "export",
    )


def test_a_full_run_builds_a_valid_cache_and_copies_it_to_the_web_folder(tmp_path):
    ctx = make_context(tmp_path)
    out, web = tmp_path / "cache" / "demo", tmp_path / "web" / "public" / "cache" / "demo"

    run_pipeline(ctx, out=out, survey_id="demo", web_out=web)

    assert validate_cache(out) == [] and validate_cache(web) == []


def test_the_manifest_lists_all_eight_stages_with_their_timings(tmp_path):
    ctx = make_context(tmp_path)
    out = tmp_path / "cache" / "demo"

    run_pipeline(ctx, out=out, survey_id="demo", clock=ticking_clock())

    stages = manifest_of(out).stages
    for name in STAGE_ORDER:
        assert getattr(stages, name).ok is True
        assert getattr(stages, name).seconds == 1.0


def test_the_manifest_carries_the_git_sha_and_the_survey_id(tmp_path):
    ctx = make_context(tmp_path)
    out = tmp_path / "cache" / "demo"

    run_pipeline(ctx, out=out, survey_id="demo", git_sha="a1b2c3d")

    manifest = manifest_of(out)
    assert (manifest.git_sha, manifest.survey_id, manifest.n_frames) == (
        "a1b2c3d",
        "demo",
        N_FRAMES,
    )


def test_the_web_copy_has_the_same_manifest_as_the_cache(tmp_path):
    ctx = make_context(tmp_path)
    out, web = tmp_path / "cache" / "demo", tmp_path / "web" / "demo"

    run_pipeline(ctx, out=out, survey_id="demo", web_out=web, clock=ticking_clock())

    assert (web / "manifest.json").read_text() == (out / "manifest.json").read_text()


def test_the_manifest_notes_name_the_placeholders(tmp_path):
    ctx = make_context(tmp_path)
    out = tmp_path / "cache" / "demo"

    run_pipeline(ctx, out=out, survey_id="demo")

    assert "build_map" in manifest_of(out).notes


# ---------------------------------------------------------------- skipping and subsets


def test_skipping_detect_reuses_copied_files_and_records_it(tmp_path):
    ctx = make_context(tmp_path, run_survey=lambda *a: pytest.fail("detect must be skipped"))
    out = tmp_path / "cache" / "demo"
    run_pipeline(ctx, stages=["frames", "place"], out=out)
    raw, config = placeholder_detections(IDS, 0.25)  # as if copied from the GPU desktop
    write_json(ctx.work / "detect" / "detections_raw.json", raw)
    write_json(ctx.work / "detect" / "config.json", config)
    (ctx.work / "detect" / "crops").mkdir(parents=True, exist_ok=True)

    run_pipeline(ctx, skip=["detect"], out=out, survey_id="demo")

    manifest = manifest_of(out)
    assert (manifest.stages.detect.ok, manifest.stages.detect.seconds) == (True, 0.0)
    assert "detect" in manifest.notes and "skipped" in manifest.notes
    assert validate_cache(out) == []


def test_a_subset_of_stages_runs_only_those_and_writes_no_cache(tmp_path):
    ctx = make_context(tmp_path)
    out = tmp_path / "cache" / "demo"

    results = run_pipeline(ctx, stages=["frames", "place"], out=out)

    assert [r.stage for r in results] == ["frames", "place"]
    assert (ctx.work / "place" / "poses.json").is_file()
    assert not (ctx.work / "rank").exists() and not out.exists()


def test_exporting_alone_notes_which_stages_were_not_run_here(tmp_path):
    ctx = make_context(tmp_path)
    out = tmp_path / "cache" / "demo"
    run_pipeline(ctx, stages=list(STAGE_ORDER[:-1]), out=out)

    run_pipeline(ctx, stages=["export"], out=out, survey_id="demo")

    assert "not run in this invocation" in manifest_of(out).notes


def test_stages_run_in_pipeline_order_whatever_order_they_are_listed(tmp_path):
    ctx = make_context(tmp_path)

    results = run_pipeline(ctx, stages=["place", "frames"], out=tmp_path / "c")

    assert [r.stage for r in results] == ["frames", "place"]


def test_an_unknown_stage_name_lists_the_valid_ones(tmp_path):
    ctx = make_context(tmp_path)

    with pytest.raises(ValueError, match="nope.*frames, place, detect"):
        run_pipeline(ctx, stages=["nope"], out=tmp_path / "c")
    with pytest.raises(ValueError, match="nope"):
        run_pipeline(ctx, skip=["nope"], out=tmp_path / "c")


# ---------------------------------------------------------------- failure


def test_a_failing_stage_stops_the_run_and_names_the_stage(tmp_path):
    def boom(n, seed):
        raise RuntimeError("boom")

    ctx = make_context(tmp_path, simulate_flight=boom)
    out = tmp_path / "cache" / "demo"

    with pytest.raises(StageFailed, match="place.*boom"):
        run_pipeline(ctx, out=out)

    assert not (ctx.work / "rank").exists() and not out.exists()


def test_the_failed_stage_is_reported_on_the_exception(tmp_path):
    ctx = make_context(
        tmp_path, simulate_flight=lambda n, seed: (_ for _ in ()).throw(RuntimeError("boom"))
    )

    with pytest.raises(StageFailed) as caught:
        run_pipeline(ctx, out=tmp_path / "c")

    assert caught.value.stage == "place" and isinstance(caught.value.__cause__, RuntimeError)


# ---------------------------------------------------------------- progress and git sha


def test_progress_is_reported_through_the_echo_callback(tmp_path):
    ctx = make_context(tmp_path)
    lines: list[str] = []

    run_pipeline(ctx, out=tmp_path / "cache" / "demo", echo=lines.append, clock=ticking_clock())

    assert any("frames" in line and "1.0 s" in line for line in lines)
    assert len(lines) >= len(STAGE_ORDER)


def test_current_git_sha_is_none_outside_a_repository(tmp_path):
    assert current_git_sha(tmp_path) is None


def test_current_git_sha_is_the_short_hash_of_head(tmp_path):
    env = {
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@t",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@t",
        "PATH": "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
    }
    for args in (["init", "-q"], ["commit", "-q", "--allow-empty", "-m", "x"]):
        subprocess.run(["git", *args], cwd=tmp_path, check=True, env=env)
    full = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        env=env,
        check=True,
    ).stdout.strip()

    sha = current_git_sha(tmp_path)

    assert sha is not None and full.startswith(sha) and 7 <= len(sha) <= 12


def test_manifest_json_is_valid_json_with_the_contract_version(tmp_path):
    ctx = make_context(tmp_path)
    out = tmp_path / "cache" / "demo"

    run_pipeline(ctx, out=out, survey_id="demo")

    assert json.loads((out / "manifest.json").read_text())["contract_version"] == "1.0"


def test_raw_detection_files_stay_out_of_the_cache(tmp_path):
    ctx = make_context(tmp_path)
    out = tmp_path / "cache" / "demo"

    run_pipeline(ctx, out=out, survey_id="demo")

    assert not (out / "detections_raw.json").exists()
    assert isinstance(
        RawDetectionsFile.model_validate_json(
            (ctx.work / "detect" / "detections_raw.json").read_text()
        ),
        RawDetectionsFile,
    )
