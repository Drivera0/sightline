"""normalise_map: make any lane-C map obey the contract's rounding and replay rules."""

from __future__ import annotations

import pytest

from sightline.contract import LatLon, MapFile, Step
from sightline.pipeline.export import _check_replay
from sightline.pipeline.geometry import cell_center
from sightline.pipeline.mapmath import normalise_map, replay_steps
from sightline.pipeline.placeholders import placeholder_map

LKP = LatLon(lat=49.37, lon=-122.945)
IDS = ["f0001", "f0002", "f0003"]


def base_map() -> MapFile:
    return placeholder_map(IDS, LKP, recall=0.8)[0]


def with_steps(steps: list[Step]) -> MapFile:
    data = base_map().model_dump()
    data["steps"] = [s.model_dump() for s in steps]
    return MapFile.model_validate(data)


def contract_update(prior: list[float], outside: float, cells: list[tuple[int, float]]):
    """Section 8 of the contract, written out independently of the code under test."""
    p = list(prior)
    denominator = 1 - sum(p[i] * pod for i, pod in cells)
    for i, pod in cells:
        p[i] *= 1 - pod
    return [x / denominator for x in p], outside / denominator


# ---------------------------------------------------------------- replay_steps


def test_replay_of_no_steps_returns_the_prior():
    map_file = base_map()

    p, outside = replay_steps(map_file.prior.p, map_file.prior.outside, [])

    assert p == map_file.prior.p and outside == map_file.prior.outside


def test_replay_of_one_step_follows_the_contract_formula():
    map_file = base_map()
    cells = [(0, 0.5), (1, 0.25), (2499, 0.9)]

    p, outside = replay_steps(
        map_file.prior.p, map_file.prior.outside, [Step(frame_id="f0001", cells=cells)]
    )

    want_p, want_outside = contract_update(map_file.prior.p, map_file.prior.outside, cells)
    assert p == pytest.approx(want_p, abs=1e-15) and outside == pytest.approx(
        want_outside, abs=1e-15
    )
    assert sum(p) + outside == pytest.approx(1.0, abs=1e-12)


def test_replay_keeps_total_probability_at_one_over_many_steps():
    map_file = base_map()
    steps = [Step(frame_id=f"f{i:04d}", cells=[(i, 0.9), (i + 1, 0.4)]) for i in range(1, 200)]

    p, outside = replay_steps(map_file.prior.p, map_file.prior.outside, steps)

    assert sum(p) + outside == pytest.approx(1.0, abs=1e-9)


def test_replay_does_not_change_its_inputs():
    map_file = base_map()
    before = list(map_file.prior.p)

    replay_steps(
        map_file.prior.p, map_file.prior.outside, [Step(frame_id="f0001", cells=[(0, 0.5)])]
    )

    assert map_file.prior.p == before


# ---------------------------------------------------------------- normalise_map


def test_a_placeholder_map_is_already_normal():
    map_file = base_map()

    assert normalise_map(map_file) == map_file


def test_pods_are_rounded_to_four_decimals():
    map_file = with_steps([Step(frame_id="f0001", cells=[(10, 0.123456), (11, 0.5)])])

    result = normalise_map(map_file)

    assert result.steps[0].cells == [(10, 0.1235), (11, 0.5)]


def test_pods_below_one_thousandth_are_dropped():
    map_file = with_steps(
        [Step(frame_id="f0001", cells=[(10, 0.0004), (11, 0.0005), (12, 0.001), (13, 0.0012)])]
    )

    result = normalise_map(map_file)

    assert result.steps[0].cells == [(12, 0.001), (13, 0.0012)]


def test_final_is_the_replay_of_the_rounded_steps_on_the_unrounded_prior():
    map_file = with_steps(
        [
            Step(frame_id="f0001", cells=[(10, 0.123456), (11, 0.5)]),
            Step(frame_id="f0002", cells=[(11, 0.9), (2000, 0.333333)]),
            Step(frame_id="f0003", cells=[]),
        ]
    )

    result = normalise_map(map_file)

    p, outside = map_file.prior.p, map_file.prior.outside
    for step in result.steps:
        p, outside = contract_update(p, outside, step.cells)
    assert result.final.p == pytest.approx(p, abs=1e-15)
    assert result.final.outside == pytest.approx(outside, abs=1e-15)
    assert result.prior == map_file.prior


def test_a_normalised_map_passes_the_cache_replay_check_exactly():
    map_file = with_steps(
        [Step(frame_id=f"f{i:04d}", cells=[(i, 0.123456), (i + 7, 0.777777)]) for i in range(1, 60)]
    )

    assert _check_replay(normalise_map(map_file)) == []


def test_a_wrong_final_from_the_lane_is_replaced():
    data = with_steps([Step(frame_id="f0001", cells=[(10, 0.5)])]).model_dump()
    # a lane that forgot to apply its steps: final is just the prior
    map_file = MapFile.model_validate({**data, "final": {"p": base_map().prior.p, "outside": 0.35}})

    result = normalise_map(map_file)

    assert _check_replay(result) == []


def test_top_cells_are_the_five_most_likely_cells_by_final_probability():
    # Looking hard at cells 0-4 lowers them, so the unlooked-at cells with the lowest idx lead.
    map_file = with_steps([Step(frame_id="f0001", cells=[(i, 0.9) for i in range(5)])])

    result = normalise_map(map_file)

    assert [c.idx for c in result.top_cells] == [5, 6, 7, 8, 9]
    assert [c.p for c in result.top_cells] == sorted((c.p for c in result.top_cells), reverse=True)
    assert result.top_cells[0].p == result.final.p[5]


def test_top_cells_carry_position_and_canopy():
    data = base_map().model_dump()
    data["canopy"][0] = 0.62
    map_file = MapFile.model_validate(data)

    result = normalise_map(map_file)

    first = result.top_cells[0]
    assert first.idx == 0 and first.canopy == 0.62
    assert (first.lat, first.lon) == pytest.approx(cell_center(map_file.grid, 0), abs=1e-12)


def test_normalising_twice_changes_nothing():
    once = normalise_map(with_steps([Step(frame_id="f0001", cells=[(10, 0.123456)])]))

    assert normalise_map(once) == once


def test_the_input_map_is_not_modified():
    map_file = with_steps([Step(frame_id="f0001", cells=[(10, 0.123456)])])
    snapshot = map_file.model_dump()

    normalise_map(map_file)

    assert map_file.model_dump() == snapshot
