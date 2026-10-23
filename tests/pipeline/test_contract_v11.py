"""Contract 1.1 (additive over 1.0): map.params.prior_source and metrics.search_sim.in_survey."""

from __future__ import annotations

from typing import get_args

import pytest
from pydantic import ValidationError

from sightline.contract import (
    CONTRACT_VERSION,
    ContractVersion,
    InSurvey,
    LatLon,
    Params,
    SearchMethod,
    SearchSim,
)
from sightline.pipeline.lanes import Lanes, MapFrame
from sightline.pipeline.placeholders import PRIOR_FROM_PLACEHOLDER, placeholder_map

METHODS = ["Prior only", "Naive: photographed = cleared", "Sightline: canopy-aware"]


def _sim(**extra: object) -> dict[str, object]:
    return {
        "simulated": True,
        "trials": 1000,
        "seed": 7,
        "found_by_drone_rate": 0.5,
        "methods": [{"name": n, "median_cells": 10, "p90_cells": 50} for n in METHODS],
        **extra,
    }


def test_1_1_files_stay_readable() -> None:
    assert CONTRACT_VERSION == "1.3" and "1.1" in get_args(ContractVersion)


def test_new_fields_default_to_null_so_1_0_files_still_parse() -> None:
    params = Params(recall=0.8, recall_source="x", pod_cap=0.95, review_pod=0.9)
    assert params.prior_source is None
    assert SearchSim.model_validate(_sim()).in_survey is None
    dumped = SearchSim.model_validate(_sim()).model_dump(mode="json")
    assert "in_survey" in dumped and dumped["in_survey"] is None  # null, never omitted


def test_in_survey_accepts_same_methods_in_order() -> None:
    sim = SearchSim.model_validate(
        _sim(
            in_survey={
                "trials": 400,
                "methods": [{"name": n, "median_cells": 5, "p90_cells": 30} for n in METHODS],
            }
        )
    )
    assert isinstance(sim.in_survey, InSurvey)
    assert sim.in_survey.trials == 400


def test_in_survey_rejects_different_methods_or_too_many_trials() -> None:
    reordered = [{"name": n, "median_cells": 5, "p90_cells": 30} for n in reversed(METHODS)]
    with pytest.raises(ValidationError, match="same names"):
        SearchSim.model_validate(_sim(in_survey={"trials": 400, "methods": reordered}))
    same = [SearchMethod(name=n, median_cells=1, p90_cells=2).model_dump() for n in METHODS]
    with pytest.raises(ValidationError, match="cannot exceed"):
        SearchSim.model_validate(_sim(in_survey={"trials": 2000, "methods": same}))


def test_placeholder_map_names_the_placeholder_prior() -> None:
    map_file, _ = placeholder_map(["f0001"], LatLon(lat=49.37, lon=-122.945), 0.8)
    assert map_file.params.prior_source == PRIOR_FROM_PLACEHOLDER == "placeholder"


def test_build_map_without_lane_c_stamps_placeholder_prior_source() -> None:
    lanes = Lanes(overrides={"build_map": None})
    map_file, _ = lanes.build_map([], LatLon(lat=49.37, lon=-122.945), 0.754)
    assert map_file.params.prior_source == "placeholder"


def test_native_build_map_with_placeholder_prior_is_stamped_and_citation_is_kept() -> None:
    lkp = LatLon(lat=49.37, lon=-122.945)

    def native_build_map(grid, lkp, prior, frames, recall, recall_source):  # lane C's signature
        map_file, _ = placeholder_map([], lkp, recall, recall_source)
        params = map_file.params.model_copy(update={"prior_source": None})
        return map_file.model_copy(update={"params": params}), []

    lanes = Lanes(overrides={"build_map": native_build_map, "placeholder_prior": None})
    map_file, _ = lanes.build_map([], lkp, 0.754)
    assert map_file.params.prior_source == "placeholder"  # the pipeline handed it our placeholder

    def legacy_build_map(frames: list[MapFrame], lkp: LatLon, recall: float, recall_source: str):
        map_file, cells = placeholder_map([], lkp, recall, recall_source)
        params = map_file.params.model_copy(
            update={"prior_source": "Koester, Lost Person Behavior (2008)"}
        )
        return map_file.model_copy(update={"params": params}), cells

    lanes = Lanes(overrides={"build_map": legacy_build_map})
    map_file, _ = lanes.build_map([], lkp, 0.754)
    assert (
        map_file.params.prior_source == "Koester, Lost Person Behavior (2008)"
    )  # lane C's own prior
