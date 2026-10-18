"""Lanes can look for one function in several places, since lane C may export from its package or from submodules."""

from __future__ import annotations

from sightline.pipeline.lanes import REGISTRY, Lanes


def test_the_second_place_is_used_when_the_first_cannot_be_imported():
    lanes = Lanes(registry={"x": [("sightline.no_such_lane", "f"), ("json", "dumps")]})

    assert lanes.get("x")({"a": 1}) == '{"a": 1}'


def test_the_second_place_is_used_when_the_first_module_lacks_the_function():
    lanes = Lanes(registry={"x": [("json", "no_such_function"), ("json", "dumps")]})

    assert lanes.get("x") is not None


def test_the_first_place_wins_when_both_have_it():
    lanes = Lanes(registry={"x": [("json", "dumps"), ("json", "loads")]})

    import json

    assert lanes.get("x") is json.dumps


def test_when_no_place_has_it_the_reason_names_every_place_tried():
    lanes = Lanes(registry={"x": [("sightline.no_such_lane", "f"), ("json", "no_such_function")]})

    assert lanes.get("x") is None
    assert "sightline.no_such_lane" in lanes.unavailable["x"]
    assert "no_such_function" in lanes.unavailable["x"]


def test_a_single_place_still_works_as_before():
    lanes = Lanes(registry={"x": ("json", "dumps")})

    assert lanes.get("x") is not None


def test_the_default_registry_knows_lane_c_helpers_and_both_places_for_its_functions():
    for name in ("make_grid", "placeholder_prior", "frame_input"):
        assert name in REGISTRY
    assert len(REGISTRY["build_map"]) == 2 and len(REGISTRY["simulate"]) == 2
