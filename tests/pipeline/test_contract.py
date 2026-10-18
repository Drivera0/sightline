"""Test 1 (LANE_D section 7): the contract's JSON examples parse into the models."""

from __future__ import annotations

import copy
import json
import re
from pathlib import Path

import pytest
from pydantic import ValidationError

from sightline.contract import (
    CONTRACT_VERSION,
    Detections,
    Manifest,
    MapFile,
    Metrics,
    Survey,
    dump_json,
    export_json_schema,
)

DOC = Path(__file__).resolve().parents[2] / "docs" / "01_CONTRACT.md"
N_CELLS = 50 * 50


def _doc_examples() -> dict[str, dict]:
    """The five ```json blocks of the contract, in document order."""
    blocks = re.findall(r"```json\n(.*?)```", DOC.read_text(encoding="utf-8"), flags=re.DOTALL)
    names = ["manifest", "survey", "detections", "map", "metrics"]
    assert len(blocks) == len(names)
    # Only the map example has elided arrays ("... 2500 values ..."); stub them, tests fill them.
    return {
        name: json.loads(re.sub(r'"\.\.\. [^"]*"', "0", block))
        for name, block in zip(names, blocks, strict=True)
    }


@pytest.fixture(scope="module")
def examples() -> dict[str, dict]:
    return _doc_examples()


def _filled_map(example: dict) -> dict:
    m = copy.deepcopy(example)
    outside = m["prior"]["outside"]
    m["prior"]["p"] = [(1 - outside) / N_CELLS] * N_CELLS
    m["canopy"] = [None if i % 7 == 0 else 0.5 for i in range(N_CELLS)]
    m["final"] = {"p": [(1 - 0.41) / N_CELLS] * N_CELLS, "outside": 0.41}
    return m


def _filled_survey(example: dict, n: int = 20) -> dict:
    """The doc's frame f0017 becomes frame 17 of a 20-frame survey (ranks 1..20)."""
    s = copy.deepcopy(example)
    doc_frame = s["frames"][0]
    frames = []
    for i in range(n):
        f = copy.deepcopy(doc_frame)
        f["id"] = f"f{i + 1:04d}"
        f["file"] = f"frames/{f['id']}.jpg"
        f["flight_index"] = i
        f["rank"] = i + 1
        frames.append(f)
    doc_frame["rank"] = 17  # the doc's rank 3 only makes sense in a larger survey
    frames[16] = doc_frame
    s["frames"] = frames
    return s


def test_manifest_example_parses(examples):
    m = Manifest.model_validate(examples["manifest"])
    assert m.contract_version == CONTRACT_VERSION and m.stages.detect.seconds == 210.0


def test_detections_example_parses(examples):
    d = Detections.model_validate(examples["detections"])
    assert [x.crop for x in d.frames["f0017"]] == ["crops/f0017-d01.jpg", None]
    assert d.frames["f0018"] == []


def test_metrics_example_parses(examples):
    m = Metrics.model_validate(examples["metrics"])
    assert m.baseline_human.seconds_per_image == 33 and len(m.ablations) == 4


def test_survey_example_parses_once_completed(examples):
    s = Survey.model_validate(_filled_survey(examples["survey"]))
    assert s.frames[16].footprint[0] == (-122.946027, 49.369902)


def test_map_example_parses_once_arrays_are_filled(examples):
    m = MapFile.model_validate(_filled_map(examples["map"]))
    assert m.grid.rows * m.grid.cols == N_CELLS and m.steps[0].cells[0] == (1234, 0.2104)


@pytest.mark.parametrize(
    ("name", "model"),
    [("manifest", Manifest), ("detections", Detections), ("metrics", Metrics)],
)
def test_unknown_fields_are_rejected(examples, name, model):
    data = copy.deepcopy(examples[name])
    data["ground_truth"] = []
    with pytest.raises(ValidationError, match="ground_truth"):
        model.model_validate(data)


def test_unknown_nested_field_is_rejected(examples):
    data = _filled_survey(examples["survey"])
    data["frames"][0]["pose"]["speed"] = 3.0
    with pytest.raises(ValidationError, match="speed"):
        Survey.model_validate(data)


def test_wrong_contract_version_is_rejected(examples):
    data = copy.deepcopy(examples["manifest"])
    data["contract_version"] = "2.0"  # 1.0 and 1.1 are both readable; anything else is not
    with pytest.raises(ValidationError):
        Manifest.model_validate(data)


def test_missing_values_must_be_explicit_null(examples):
    data = _filled_survey(examples["survey"])
    del data["frames"][0]["pose"]["alt_agl_m"]
    with pytest.raises(ValidationError, match="alt_agl_m"):
        Survey.model_validate(data)


def test_duplicate_rank_is_rejected(examples):
    data = _filled_survey(examples["survey"])
    data["frames"][1]["rank"] = data["frames"][0]["rank"]
    with pytest.raises(ValidationError, match="1..N"):
        Survey.model_validate(data)


def test_closed_footprint_is_rejected(examples):
    data = _filled_survey(examples["survey"])
    fp = data["frames"][0]["footprint"]
    fp[3] = fp[0]
    with pytest.raises(ValidationError, match="closed"):
        Survey.model_validate(data)


def test_crop_must_match_candidate_threshold(examples):
    data = copy.deepcopy(examples["detections"])
    data["frames"]["f0017"][1]["crop"] = "crops/f0017-d02.jpg"
    with pytest.raises(ValidationError, match="crop"):
        Detections.model_validate(data)


def test_degenerate_box_is_rejected(examples):
    data = copy.deepcopy(examples["detections"])
    data["frames"]["f0017"][0]["box_px"] = [512, 300, 512, 362]
    with pytest.raises(ValidationError, match="x2 > x1"):
        Detections.model_validate(data)


def test_probabilities_must_sum_to_one(examples):
    data = _filled_map(examples["map"])
    data["final"]["outside"] = 0.5
    with pytest.raises(ValidationError, match="final"):
        MapFile.model_validate(data)


def test_dump_rounds_per_contract(examples):
    m = MapFile.model_validate(_filled_map(examples["map"]))
    m.prior.p[0] = 0.000123456789012
    m.canopy[1] = 0.123456
    m.steps[0].cells[0] = (1234, 0.210449)
    m.lkp.lat = 49.3700004
    out = json.loads(dump_json(m))
    assert out["prior"]["p"][0] == 0.000123456789012  # full precision
    assert out["canopy"][1] == 0.1235
    assert out["steps"][0]["cells"][0] == [1234, 0.2104]
    assert out["lkp"]["lat"] == 49.37


def test_dump_rejects_nan(examples):
    m = Metrics.model_validate(examples["metrics"])
    m.ranking.expected_first_hit_random_order = float("nan")
    with pytest.raises(ValueError):
        dump_json(m)


def test_json_schema_export(tmp_path):
    out = tmp_path / "nested" / "contract.schema.json"
    export_json_schema(out)
    schema = json.loads(out.read_text())
    assert set(schema["properties"]) == {"manifest", "survey", "detections", "map", "metrics"}


def _walk(node):
    yield node
    if isinstance(node, dict):
        for value in node.values():
            yield from _walk(value)
    elif isinstance(node, list):
        for value in node:
            yield from _walk(value)


def test_schema_is_shaped_for_json_schema_to_typescript(tmp_path):
    out = tmp_path / "contract.schema.json"
    export_json_schema(out)
    schema = json.loads(out.read_text())

    assert not any("prefixItems" in n for n in _walk(schema) if isinstance(n, dict))
    footprint = schema["$defs"]["Frame"]["properties"]["footprint"]
    assert len(footprint["items"]) == 4 and footprint["minItems"] == footprint["maxItems"] == 4
    assert all("title" not in p for d in schema["$defs"].values() for p in d["properties"].values())
    assert {"Frame", "Pose", "MapFile"} <= set(schema["$defs"])


def test_committed_json_schema_is_up_to_date_with_the_models(tmp_path):
    """web/src/contract.ts is generated from this schema. If this fails, run `pnpm gen:contract`."""
    committed = Path(__file__).resolve().parents[2] / "web" / "src" / "contract.schema.json"
    fresh = tmp_path / "contract.schema.json"

    export_json_schema(fresh)

    assert json.loads(committed.read_text()) == json.loads(fresh.read_text())
