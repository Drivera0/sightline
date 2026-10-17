"""Test 5 (LANE_D section 7): validate_cache passes on the sample and catches broken copies."""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from sightline.pipeline.export import validate_cache
from sightline.pipeline.sample import write_sample


@pytest.fixture(scope="module")
def pristine(tmp_path_factory) -> Path:
    out = tmp_path_factory.mktemp("pristine") / "sample"
    write_sample(out, web_out=None)
    return out


@pytest.fixture
def cache(pristine, tmp_path) -> Path:
    """A fresh, writable copy of the valid sample for one test to break."""
    copy = tmp_path / "cache"
    shutil.copytree(pristine, copy)
    return copy


def edit(cache: Path, name: str, change) -> None:
    path = cache / name
    data = json.loads(path.read_text())
    change(data)
    path.write_text(json.dumps(data))


def test_sample_cache_is_valid(pristine):
    assert validate_cache(pristine) == []


def test_missing_crop_file_is_reported(cache):
    crop = next((cache / "crops").glob("*.jpg"))
    crop.unlink()

    errors = validate_cache(cache)

    assert any(f"crops/{crop.name}" in e for e in errors)


def test_missing_frame_file_is_reported(cache):
    (cache / "frames" / "f0003.jpg").unlink()

    errors = validate_cache(cache)

    assert any("frames/f0003.jpg" in e for e in errors)


def test_prior_that_does_not_sum_to_one_is_reported(cache):
    edit(cache, "map.json", lambda d: d["prior"].update(outside=0.5))

    errors = validate_cache(cache)

    assert any("map.json" in e and "prior" in e for e in errors)


def test_duplicate_rank_is_reported(cache):
    def duplicate(d):
        d["frames"][1]["rank"] = d["frames"][0]["rank"]

    edit(cache, "survey.json", duplicate)

    errors = validate_cache(cache)

    assert any("survey.json" in e and "rank" in e for e in errors)


def test_truth_field_in_survey_is_reported(cache):
    edit(cache, "survey.json", lambda d: d["frames"][0].update(ground_truth=[[1, 2, 3, 4]]))

    errors = validate_cache(cache)

    assert any("ground_truth" in e for e in errors)


def test_truth_field_is_caught_even_when_the_file_no_longer_parses(cache):
    edit(cache, "detections.json", lambda d: d.update(truth={"f0005": [[1, 2, 3, 4]]}))

    errors = validate_cache(cache)

    assert any("truth" in e and "detections.json" in e for e in errors)


def test_truth_file_in_cache_is_reported(cache):
    (cache / "truth.json").write_text("{}")

    errors = validate_cache(cache)

    assert any("truth.json" in e for e in errors)


def test_missing_cache_file_is_reported(cache):
    (cache / "metrics.json").unlink()

    assert any("metrics.json" in e and "missing" in e for e in validate_cache(cache))


def test_manifest_frame_count_must_match_survey(cache):
    edit(cache, "manifest.json", lambda d: d.update(n_frames=500))

    assert any("n_frames" in e for e in validate_cache(cache))


def test_detections_must_list_every_survey_frame(cache):
    edit(cache, "detections.json", lambda d: d["frames"].pop("f0010"))

    assert any("f0010" in e and "detections" in e for e in validate_cache(cache))


def test_detections_for_unknown_frame_are_reported(cache):
    edit(cache, "detections.json", lambda d: d["frames"].update(f0099=[]))

    assert any("f0099" in e for e in validate_cache(cache))


def test_steps_must_cover_every_frame_in_flight_order(cache):
    edit(cache, "map.json", lambda d: d["steps"].pop())

    assert any("steps" in e for e in validate_cache(cache))


def test_final_that_differs_from_replayed_steps_is_reported(cache):
    def nudge(d):
        d["final"]["p"][0] += 1e-6
        d["final"]["outside"] -= 1e-6  # keep the sum valid so only the replay check can fire

    edit(cache, "map.json", nudge)

    errors = validate_cache(cache)

    assert any("replay" in e for e in errors)


def test_correct_nonempty_step_replays_to_final(cache):
    """Independent re-derivation of the update rule in contract section 8."""

    def with_one_step(d):
        p = list(d["prior"]["p"])
        outside = d["prior"]["outside"]
        cells = [(0, 0.5), (1, 0.25)]
        denominator = 1 - sum(p[i] * pod for i, pod in cells)
        for i, pod in cells:
            p[i] *= 1 - pod
        d["steps"][0]["cells"] = [list(c) for c in cells]
        d["final"] = {"p": [x / denominator for x in p], "outside": outside / denominator}
        d["top_cells"] = []

    edit(cache, "map.json", with_one_step)

    assert validate_cache(cache) == []


def test_footprint_far_from_the_grid_is_reported(cache):
    def move_away(d):
        d["frames"][0]["footprint"] = [[-120.0 + i * 1e-4, 40.0] for i in range(4)]

    edit(cache, "survey.json", move_away)

    assert any("footprint" in e and "f0001" in e for e in validate_cache(cache))


def test_path_escaping_the_cache_is_reported(cache):
    edit(cache, "survey.json", lambda d: d["frames"][0].update(file="../outside.jpg"))

    assert any("../outside.jpg" in e for e in validate_cache(cache))
