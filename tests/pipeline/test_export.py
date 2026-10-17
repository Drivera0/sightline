"""export_cache: turn data/work/ + data/survey/ into a validated cache folder."""

from __future__ import annotations

import json
import shutil
from datetime import UTC, datetime
from pathlib import Path

import pytest

from sightline.contract import (
    Detections,
    DetectorMetrics,
    Manifest,
    MapFile,
    Metrics,
    Ranking,
    SearchSim,
    StageResult,
    Stages,
    Survey,
)
from sightline.pipeline.export import CacheValidationError, export_cache, validate_cache
from sightline.pipeline.formats import (
    DetectConfig,
    DetectorMetricsFile,
    GeoDetection,
    GeoFile,
    PlacedFrame,
    PlaceFile,
    RankEntry,
    RankFile,
    RawDetectionEntry,
    RawDetectionsFile,
    SurveyFrameEntry,
    SurveyFrameFile,
    write_json,
)
from sightline.pipeline.sample import write_sample


class Tree:
    """A data/ folder (survey + work) rebuilt from the sample cache, plus the sample itself."""

    def __init__(self, root: Path) -> None:
        self.sample = root / "sample"
        write_sample(self.sample, web_out=None)
        self.data = root / "data"
        self.work = self.data / "work"
        self.survey_dir = self.data / "survey"
        self.out = root / "cache" / "sample"
        self._build()

    def _build(self) -> None:
        s = self.sample
        survey = Survey.model_validate_json((s / "survey.json").read_text())
        detections = Detections.model_validate_json((s / "detections.json").read_text())
        metrics = Metrics.model_validate_json((s / "metrics.json").read_text())

        (self.survey_dir / "frames").mkdir(parents=True)
        entries = []
        for f in survey.frames:
            shutil.copy(s / f.file, self.survey_dir / f.file)
            entries.append(
                SurveyFrameEntry(
                    id=f.id,
                    flight_index=f.flight_index,
                    source_image=f.source.image,
                    x0=f.source.x0,
                    y0=f.source.y0,
                    path=str(self.survey_dir / f.file),
                )
            )
        write_json(self.survey_dir / "frames.json", SurveyFrameFile(entries))

        write_json(
            self.work / "place" / "poses.json",
            PlaceFile(
                simulated_path=survey.simulated_path,
                area_name=survey.area.name,
                lkp=survey.area.lkp,
                frames={
                    f.id: PlacedFrame(pose=f.pose, footprint=f.footprint) for f in survey.frames
                },
            ),
        )

        write_json(
            self.work / "detect" / "config.json",
            DetectConfig(
                weights="data/weights/sample.pt",
                model=detections.model,
                candidate_threshold=detections.candidate_threshold,
                save_threshold=detections.save_threshold,
            ),
        )
        write_json(
            self.work / "detect" / "detections_raw.json",
            RawDetectionsFile(
                model=detections.model,
                save_threshold=detections.save_threshold,
                candidate_threshold=detections.candidate_threshold,
                frames={
                    fid: [RawDetectionEntry(box=d.box_px, conf=d.conf) for d in dets]
                    for fid, dets in detections.frames.items()
                },
            ),
        )
        (self.work / "detect" / "crops").mkdir()
        for crop in (s / "crops").glob("*.jpg"):
            shutil.copy(crop, self.work / "detect" / "crops" / crop.name)
        write_json(
            self.work / "georef" / "detections_geo.json",
            GeoFile(
                frames={
                    fid: [
                        GeoDetection(box=d.box_px, lat=d.lat, lon=d.lon, radius_m=d.radius_m)
                        for d in dets
                    ]
                    for fid, dets in detections.frames.items()
                }
            ),
        )
        write_json(
            self.work / "rank" / "rank.json",
            RankFile(
                frames={
                    f.id: RankEntry(score=f.score, rank=f.rank, n_candidates=f.n_candidates)
                    for f in survey.frames
                }
            ),
        )
        (self.work / "map").mkdir()
        shutil.copy(s / "map.json", self.work / "map" / "map.json")
        write_json(
            self.work / "metrics" / "detector_metrics.json",
            DetectorMetricsFile(detector=metrics.detector, ablations=metrics.ablations),
        )
        write_json(self.work / "metrics" / "ranking.json", metrics.ranking)
        write_json(self.work / "metrics" / "search_sim.json", metrics.search_sim)

    def edit(self, relative: str, change) -> None:
        path = self.work / relative
        data = json.loads(path.read_text())
        change(data)
        path.write_text(json.dumps(data))


@pytest.fixture
def tree(tmp_path) -> Tree:
    return Tree(tmp_path)


def export(tree: Tree, **kwargs) -> None:
    export_cache(tree.work, tree.out, survey_id="sample", **kwargs)


def load(path: Path) -> dict:
    return json.loads(path.read_text())


# ---------------------------------------------------------------- the happy path


def test_exported_cache_passes_every_check(tree):
    export(tree)

    assert validate_cache(tree.out) == []


@pytest.mark.parametrize("name", ["survey", "detections", "map", "metrics"])
def test_exported_contract_files_match_the_sample_they_were_built_from(tree, name):
    export(tree)

    assert load(tree.out / f"{name}.json") == load(tree.sample / f"{name}.json")


def test_frames_and_crops_are_copied_unchanged(tree):
    export(tree)

    for original in (*tree.sample.glob("frames/*.jpg"), *tree.sample.glob("crops/*.jpg")):
        assert (tree.out / original.relative_to(tree.sample)).read_bytes() == original.read_bytes()


def test_frames_are_listed_in_flight_order_whatever_the_order_in_frames_json(tree):
    path = tree.survey_dir / "frames.json"
    entries = json.loads(path.read_text())
    path.write_text(json.dumps(list(reversed(entries))))

    export(tree)

    assert [f["flight_index"] for f in load(tree.out / "survey.json")["frames"]] == list(range(20))


def test_default_data_folder_is_next_to_work(tree):
    export_cache(tree.work, tree.out, survey_id="sample")  # no survey_dir argument

    assert validate_cache(tree.out) == []


# ---------------------------------------------------------------- manifest


def test_manifest_reports_the_survey_and_defaults_every_stage_to_ok(tree):
    export(tree)

    manifest = Manifest.model_validate_json((tree.out / "manifest.json").read_text())

    assert (manifest.survey_id, manifest.n_frames, manifest.simulated_path) == ("sample", 20, True)
    assert all(getattr(manifest.stages, name).ok for name in Stages.model_fields)


def test_manifest_carries_the_stages_notes_sha_and_time_it_is_given(tree):
    stages = Stages(**{name: StageResult(ok=True, seconds=1.5) for name in Stages.model_fields})
    when = datetime(2026, 11, 7, 18, 30, tzinfo=UTC)

    export(
        tree,
        stages=stages,
        notes="detect copied from desktop",
        git_sha="a1b2c3d",
        generated_at=when,
    )

    manifest = Manifest.model_validate_json((tree.out / "manifest.json").read_text())
    assert manifest.stages.detect.seconds == 1.5
    assert (manifest.notes, manifest.git_sha, manifest.generated_at) == (
        "detect copied from desktop",
        "a1b2c3d",
        when,
    )


# ---------------------------------------------------------------- never write a bad cache


def test_a_cache_that_fails_validation_is_not_written(tree):
    (tree.work / "detect" / "crops" / "f0005-d01.jpg").unlink()

    with pytest.raises(CacheValidationError, match=r"crops/f0005-d01\.jpg"):
        export(tree)

    assert not tree.out.exists()
    assert not list(tree.out.parent.glob(".*"))  # no half-written staging folder left


def test_a_failed_export_leaves_the_previous_cache_untouched(tree):
    export(tree)
    before = (tree.out / "survey.json").read_bytes()
    (tree.work / "detect" / "crops" / "f0005-d01.jpg").unlink()

    with pytest.raises(CacheValidationError):
        export(tree)

    assert (tree.out / "survey.json").read_bytes() == before


def test_a_new_export_replaces_the_old_cache_and_drops_stale_files(tree):
    export(tree)
    (tree.out / "crops" / "stale.jpg").write_bytes(b"old")

    export(tree)

    assert not (tree.out / "crops" / "stale.jpg").exists()


def test_export_refuses_to_replace_a_folder_that_is_not_a_cache(tree):
    tree.out.mkdir(parents=True)
    (tree.out / "my-notes.txt").write_text("keep me")

    with pytest.raises(ValueError, match="not a cache"):
        export(tree)

    assert (tree.out / "my-notes.txt").read_text() == "keep me"


def test_export_writes_into_an_empty_existing_folder(tree):
    tree.out.mkdir(parents=True)

    export(tree)

    assert validate_cache(tree.out) == []


# ---------------------------------------------------------------- web copy


def test_cache_is_copied_to_the_web_folder_when_asked(tree, tmp_path):
    web = tmp_path / "web" / "public" / "cache" / "sample"

    export(tree, web_out=web)

    assert validate_cache(web) == []
    assert (web / "survey.json").read_bytes() == (tree.out / "survey.json").read_bytes()


def test_no_web_copy_is_made_when_validation_fails(tree, tmp_path):
    web = tmp_path / "web" / "public" / "cache" / "sample"
    (tree.work / "detect" / "crops" / "f0005-d01.jpg").unlink()

    with pytest.raises(CacheValidationError):
        export(tree, web_out=web)

    assert not web.exists()


# ---------------------------------------------------------------- truth stays out


def test_ground_truth_beside_the_inputs_never_reaches_the_cache(tree):
    (tree.survey_dir / "truth.json").write_text(json.dumps({"f0005": [[512, 300, 560, 362]]}))
    (tree.work / "truth.json").write_text("{}")

    export(tree)

    assert not list(tree.out.rglob("*truth*"))
    assert "512, 300, 560, 362" not in "".join(
        p.read_text() for p in tree.out.glob("*.json") if p.name != "detections.json"
    )


# ---------------------------------------------------------------- bad inputs


def test_a_missing_input_names_the_file_and_its_stage(tree):
    (tree.work / "place" / "poses.json").unlink()

    with pytest.raises(FileNotFoundError, match=r"poses\.json.*`place`"):
        export(tree)


def test_a_frame_without_a_pose_is_reported(tree):
    tree.edit("place/poses.json", lambda d: d["frames"].pop("f0007"))

    with pytest.raises(ValueError, match=r"f0007.*poses\.json"):
        export(tree)


def test_a_frame_missing_from_the_raw_detections_is_reported(tree):
    tree.edit("detect/detections_raw.json", lambda d: d["frames"].pop("f0010"))

    with pytest.raises(ValueError, match=r"f0010.*detections_raw\.json"):
        export(tree)


def test_geo_entries_must_pair_one_to_one_with_raw_detections(tree):
    tree.edit("georef/detections_geo.json", lambda d: d["frames"]["f0005"].pop())

    with pytest.raises(ValueError, match=r"f0005.*2 raw.*1 position"):
        export(tree)


def test_geo_entry_with_a_different_box_is_reported(tree):
    tree.edit(
        "georef/detections_geo.json", lambda d: d["frames"]["f0005"][0].update(box=[1, 1, 9, 9])
    )

    with pytest.raises(ValueError, match=r"f0005.*box"):
        export(tree)


def test_config_and_raw_detections_must_agree_on_the_threshold(tree):
    tree.edit("detect/config.json", lambda d: d.update(candidate_threshold=0.5))

    with pytest.raises(ValueError, match="candidate_threshold"):
        export(tree)


def test_return_types_are_the_contract_models(tree):
    export(tree)

    assert isinstance(MapFile.model_validate_json((tree.out / "map.json").read_text()), MapFile)
    metrics = Metrics.model_validate_json((tree.out / "metrics.json").read_text())
    assert isinstance(metrics.detector, DetectorMetrics)
    assert isinstance(metrics.ranking, Ranking) and isinstance(metrics.search_sim, SearchSim)
    assert metrics.baseline_human.seconds_per_image == 33
