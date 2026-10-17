"""write_sample (LANE_D section 6.1, step 3)."""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image

from sightline.contract import Detections, MapFile, Metrics, Survey
from sightline.pipeline.export import validate_cache
from sightline.pipeline.sample import write_sample


def read(cache: Path, name: str) -> str:
    return (cache / name).read_text()


def test_sample_has_twenty_frames_in_flight_order(tmp_path):
    write_sample(tmp_path / "sample", web_out=None)

    survey = Survey.model_validate_json(read(tmp_path / "sample", "survey.json"))

    assert [f.id for f in survey.frames] == [f"f{i:04d}" for i in range(1, 21)]
    assert survey.simulated_path is True


def test_sample_marks_itself_as_sample(tmp_path):
    write_sample(tmp_path / "sample", web_out=None)

    detections = Detections.model_validate_json(read(tmp_path / "sample", "detections.json"))
    metrics = Metrics.model_validate_json(read(tmp_path / "sample", "metrics.json"))

    assert detections.model == "SAMPLE"
    assert metrics.detector.model == "SAMPLE"


def test_sample_has_one_empty_step_per_frame_and_a_uniform_prior(tmp_path):
    write_sample(tmp_path / "sample", web_out=None)

    map_file = MapFile.model_validate_json(read(tmp_path / "sample", "map.json"))

    assert len(map_file.steps) == 20
    assert all(step.cells == [] for step in map_file.steps)
    assert len(set(map_file.prior.p)) == 1
    assert map_file.final == map_file.prior


def test_sample_has_candidates_with_crops_and_weak_detections_without(tmp_path):
    out = tmp_path / "sample"
    write_sample(out, web_out=None)

    detections = Detections.model_validate_json(read(out, "detections.json"))
    flat = [d for dets in detections.frames.values() for d in dets]

    candidates = [d for d in flat if d.conf >= detections.candidate_threshold]
    weak = [d for d in flat if d.conf < detections.candidate_threshold]
    assert candidates and weak
    assert all(d.crop and Image.open(out / d.crop).size == (256, 256) for d in candidates)
    assert all(d.crop is None for d in weak)
    assert Image.open(out / "frames" / "f0001.jpg").size == (1000, 750)


def test_ranks_follow_score_then_candidates_then_flight_order(tmp_path):
    write_sample(tmp_path / "sample", web_out=None)

    survey = Survey.model_validate_json(read(tmp_path / "sample", "survey.json"))
    by_rank = sorted(survey.frames, key=lambda f: f.rank)

    keys = [(-f.score, -f.n_candidates, f.flight_index) for f in by_rank]
    assert keys == sorted(keys)
    assert by_rank[0].score > 0


def test_sample_is_deterministic(tmp_path):
    write_sample(tmp_path / "a", web_out=None)
    write_sample(tmp_path / "b", web_out=None)

    for path in sorted((tmp_path / "a").rglob("*")):
        if path.is_file():
            assert (
                path.read_bytes()
                == (tmp_path / "b" / path.relative_to(tmp_path / "a")).read_bytes()
            )


def test_sample_is_copied_to_the_web_folder(tmp_path):
    out, web = tmp_path / "cache" / "sample", tmp_path / "web" / "public" / "cache" / "sample"

    write_sample(out, web_out=web)

    files = sorted(p.relative_to(out) for p in out.rglob("*") if p.is_file())
    assert files and files == sorted(p.relative_to(web) for p in web.rglob("*") if p.is_file())
    assert validate_cache(web) == []


def test_frames_are_cut_from_given_images(tmp_path):
    source = tmp_path / "test_SB_0001.jpg"
    Image.new("RGB", (4000, 3000), (90, 120, 80)).save(source)
    out = tmp_path / "sample"

    write_sample(out, web_out=None, images=[source])

    survey = Survey.model_validate_json(read(out, "survey.json"))
    assert {f.source.image for f in survey.frames} == {"test_SB_0001.jpg"}
    assert all(f.source.x0 % 1000 == 0 and f.source.y0 % 750 == 0 for f in survey.frames)
    assert validate_cache(out) == []


def test_sample_json_has_no_nan_and_a_contract_version(tmp_path):
    write_sample(tmp_path / "sample", web_out=None)

    for name in ("manifest", "survey", "detections", "map", "metrics"):
        data = json.loads(read(tmp_path / "sample", f"{name}.json"))
        assert data["contract_version"] == "1.0"
