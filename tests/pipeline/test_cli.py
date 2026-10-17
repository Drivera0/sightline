"""The command line: python -m sightline.pipeline <command>."""

from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image
from typer.testing import CliRunner

from sightline.pipeline import __main__ as cli
from sightline.pipeline.export import validate_cache
from sightline.pipeline.lanes import Lanes

runner = CliRunner()
LANE_NAMES = [
    "simulate_flight",
    "footprint",
    "georef_detection",
    "run_survey",
    "load_split",
    "build_map",
    "simulate",
]
COMMON = ["--n-frames", "40", "--n-positive", "3"]


@pytest.fixture(autouse=True)
def no_lane_functions(monkeypatch):
    """Whatever lanes exist, these tests use placeholders so they stay the same when lanes land."""
    monkeypatch.setattr(cli, "make_lanes", lambda: Lanes(overrides={n: None for n in LANE_NAMES}))


@pytest.fixture
def data(tmp_path) -> Path:
    split = tmp_path / "data" / "heridal" / "yolo_full" / "test"
    (split / "images").mkdir(parents=True)
    (split / "labels").mkdir()
    for i in range(6):
        Image.new("RGB", (4000, 3000), (80 + i, 110, 70)).save(split / "images" / f"test_{i}.jpg")
        (split / "labels" / f"test_{i}.txt").write_text("0 0.3 0.4 0.0125 0.02\n")
    return tmp_path / "data"


def invoke(*args: str):
    return runner.invoke(cli.app, list(args))


def test_help_lists_every_command():
    result = invoke("--help")

    assert result.exit_code == 0
    for name in (
        "frames",
        "place",
        "detect",
        "georef",
        "rank",
        "map",
        "metrics",
        "export",
        "validate",
        "sample",
        "run",
    ):
        assert name in result.output


def test_run_builds_a_valid_cache_and_reports_each_stage(data, tmp_path):
    out, web = tmp_path / "cache" / "demo", tmp_path / "web" / "demo"

    result = invoke("run", "--data", str(data), "--out", str(out), "--web-out", str(web), *COMMON)

    assert result.exit_code == 0, result.output
    for stage in ("frames", "place", "detect", "georef", "rank", "map", "metrics", "export"):
        assert f"{stage}: done" in result.output
    assert validate_cache(out) == [] and validate_cache(web) == []


def test_run_tells_the_user_which_lane_functions_were_placeholders(data, tmp_path):
    result = invoke(
        "run",
        "--data",
        str(data),
        "--out",
        str(tmp_path / "c"),
        "--web-out",
        str(tmp_path / "w"),
        *COMMON,
    )

    assert "placeholder" in result.output.lower() and "build_map" in result.output


def test_run_takes_a_stage_list_and_a_skip_list(data, tmp_path):
    result = invoke(
        "run",
        "--data",
        str(data),
        "--stages",
        "frames,place",
        "--out",
        str(tmp_path / "c"),
        *COMMON,
    )

    assert result.exit_code == 0 and "place: done" in result.output and "rank" not in result.output


def test_run_skip_marks_a_stage_skipped(data, tmp_path):
    invoke(
        "run",
        "--data",
        str(data),
        "--out",
        str(tmp_path / "c"),
        "--web-out",
        str(tmp_path / "w"),
        *COMMON,
    )

    result = invoke(
        "run",
        "--data",
        str(data),
        "--skip",
        "detect",
        "--out",
        str(tmp_path / "c"),
        "--web-out",
        str(tmp_path / "w"),
        *COMMON,
    )

    assert result.exit_code == 0 and "detect: skipped" in result.output


def test_run_with_an_unknown_stage_is_a_usage_error_that_lists_the_valid_ones(data, tmp_path):
    result = invoke("run", "--data", str(data), "--stages", "nope", "--out", str(tmp_path / "c"))

    assert result.exit_code == 2
    assert "nope" in result.output and "frames, place, detect" in result.output


def test_a_failing_stage_exits_with_1_and_names_it(data, tmp_path):
    # no `frames` stage was run, so `place` cannot find frames.json
    result = invoke("run", "--data", str(data), "--stages", "place", "--out", str(tmp_path / "c"))

    assert result.exit_code == 1
    assert "place" in result.output and "frames" in result.output


def test_each_stage_can_be_run_on_its_own_in_order(data, tmp_path):
    for stage in ("frames", "place", "detect", "georef", "rank", "map", "metrics"):
        result = invoke(stage, "--data", str(data), *COMMON)
        assert result.exit_code == 0, f"{stage}: {result.output}"
    out = tmp_path / "cache" / "demo"

    result = invoke("export", "--data", str(data), "--out", str(out), "--survey-id", "demo")

    assert result.exit_code == 0, result.output
    assert validate_cache(out) == []


def test_detect_on_its_own_reports_that_it_used_placeholders(data):
    invoke("frames", "--data", str(data), *COMMON)

    result = invoke("detect", "--data", str(data), *COMMON)

    assert "placeholder" in result.output.lower()


def test_validate_exits_with_1_and_lists_each_failed_check(tmp_path):
    result = invoke("validate", str(tmp_path))

    assert result.exit_code == 1 and "manifest.json: missing" in result.output


def test_sample_writes_the_sample_cache_and_its_web_copy(tmp_path):
    out, web = tmp_path / "cache" / "sample", tmp_path / "web" / "sample"

    result = invoke("sample", "--out", str(out), "--web-out", str(web))

    assert result.exit_code == 0 and validate_cache(out) == [] and validate_cache(web) == []
