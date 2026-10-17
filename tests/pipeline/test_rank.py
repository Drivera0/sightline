"""Test 4 (LANE_D section 7): ranking scores, ranks, tie-breaks and ranking metrics."""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from sightline.contract import Ranking
from sightline.pipeline.rank import rank_frames, ranking_metrics


# Same shape as lane A's RawDetection (box and conf); rank.py only reads `conf`.
@dataclass(frozen=True)
class RawDetection:
    box: tuple[int, int, int, int]
    conf: float


def det(conf: float) -> RawDetection:
    return RawDetection((10, 10, 40, 60), conf)


THRESHOLD = 0.25


# ---------------------------------------------------------------- rank_frames


def test_score_is_the_highest_confidence_in_the_frame():
    result = rank_frames({"f0001": [det(0.3), det(0.8), det(0.1)]}, {"f0001": 0}, THRESHOLD)

    score, _, _ = result["f0001"]

    assert score == 0.8


def test_frame_with_no_detections_scores_zero_and_has_no_candidates():
    result = rank_frames({"f0001": []}, {"f0001": 0}, THRESHOLD)

    assert result["f0001"] == (0.0, 1, 0)


def test_frame_missing_from_the_detections_counts_as_empty():
    result = rank_frames({}, {"f0001": 0, "f0002": 1}, THRESHOLD)

    assert result["f0001"][0] == 0.0 and result["f0002"][0] == 0.0


def test_candidates_are_detections_at_or_above_the_threshold():
    dets = {"f0001": [det(0.25), det(0.2499), det(0.9)]}

    _, _, n_candidates = rank_frames(dets, {"f0001": 0}, THRESHOLD)["f0001"]

    assert n_candidates == 2


def test_higher_score_ranks_first():
    dets = {"f0001": [det(0.4)], "f0002": [det(0.9)], "f0003": [det(0.6)]}
    flight = {"f0001": 0, "f0002": 1, "f0003": 2}

    result = rank_frames(dets, flight, THRESHOLD)

    assert [result[f][1] for f in ("f0002", "f0003", "f0001")] == [1, 2, 3]


def test_equal_scores_rank_the_frame_with_more_candidates_first():
    dets = {"f0001": [det(0.5)], "f0002": [det(0.5), det(0.3)]}
    flight = {"f0001": 0, "f0002": 1}

    result = rank_frames(dets, flight, THRESHOLD)

    assert result["f0002"][1] == 1 and result["f0001"][1] == 2


def test_equal_scores_and_candidates_rank_the_earlier_flight_index_first():
    # Frame ids are NOT in flight order here, so the tie must use flight_index, not the id.
    dets = {"f0001": [det(0.5)], "f0002": [det(0.5)]}
    flight = {"f0001": 7, "f0002": 3}

    result = rank_frames(dets, flight, THRESHOLD)

    assert result["f0002"][1] == 1 and result["f0001"][1] == 2


def test_hand_built_example_gives_the_expected_ranking():
    dets = {
        "f0001": [det(0.9)],
        "f0002": [det(0.5), det(0.4), det(0.1)],
        "f0003": [det(0.5)],
        "f0004": [det(0.5), det(0.3)],
        "f0005": [],
    }
    flight = {"f0001": 0, "f0002": 4, "f0003": 2, "f0004": 1, "f0005": 3}

    result = rank_frames(dets, flight, THRESHOLD)

    ranked = sorted(result, key=lambda f: result[f][1])
    assert ranked == ["f0001", "f0004", "f0002", "f0003", "f0005"]
    assert result["f0002"] == (0.5, 3, 2)


def test_ranks_are_exactly_one_to_n():
    flight = {f"f{i:04d}": i - 1 for i in range(1, 51)}
    dets = {f: [det(0.5)] for f in flight}  # every frame ties

    result = rank_frames(dets, flight, THRESHOLD)

    assert sorted(r for _, r, _ in result.values()) == list(range(1, 51))


def test_detections_for_a_frame_not_in_the_survey_are_rejected():
    with pytest.raises(ValueError, match="f0099"):
        rank_frames({"f0099": [det(0.5)]}, {"f0001": 0}, THRESHOLD)


# ---------------------------------------------------------------- ranking_metrics


def ten_frames() -> tuple[dict[str, int], dict[str, int], dict[str, list]]:
    """10 frames in flight order; positives f0004 (flight 3) and f0009 (flight 8)."""
    flight = {f"f{i:04d}": i - 1 for i in range(1, 11)}
    ranks = {"f0009": 1, "f0002": 2, "f0004": 3}
    ranks.update(
        {
            f: r
            for r, f in enumerate(
                ["f0001", "f0003", "f0005", "f0006", "f0007", "f0008", "f0010"], 4
            )
        }
    )
    truth: dict[str, list] = {f: [] for f in flight}
    truth["f0004"] = [object()]
    truth["f0009"] = [object(), object()]
    return flight, ranks, truth


def test_positions_are_one_based_for_flight_order_and_ranked_order():
    flight, ranks, truth = ten_frames()

    result = ranking_metrics(ranks, flight, truth)

    assert (result.flight_order.frames_to_first_hit, result.flight_order.frames_to_all_hits) == (
        4,
        9,
    )
    assert (result.ranked.frames_to_first_hit, result.ranked.frames_to_all_hits) == (1, 3)


def test_counts_and_random_order_expectation():
    flight, ranks, truth = ten_frames()

    result = ranking_metrics(ranks, flight, truth)

    assert (result.n_frames, result.n_positive) == (10, 2)
    assert result.expected_first_hit_random_order == pytest.approx(11 / 3)


def test_random_order_expectation_for_the_demo_survey_is_71_6():
    flight = {f"f{i:04d}": i - 1 for i in range(1, 501)}
    ranks = {f: i for i, f in enumerate(flight, start=1)}
    truth = {f: [] for f in flight}
    for f in list(flight)[:6]:
        truth[f] = [object()]

    result = ranking_metrics(ranks, flight, truth)

    assert round(result.expected_first_hit_random_order, 1) == 71.6


def test_minutes_use_33_seconds_per_image():
    flight, ranks, truth = ten_frames()

    result = ranking_metrics(ranks, flight, truth)

    assert result.minutes_at_human_pace.flight_order_first == pytest.approx(4 * 33 / 60)
    assert result.minutes_at_human_pace.ranked_first == pytest.approx(1 * 33 / 60)


def test_note_says_33_seconds_was_measured_on_full_photos():
    flight, ranks, truth = ten_frames()

    note = ranking_metrics(ranks, flight, truth).note

    assert "33 s" in note and "4000×3000" in note


def test_frames_with_empty_truth_are_not_positive():
    flight, ranks, truth = ten_frames()
    truth["f0002"] = []  # explicit empty list, as build_survey writes for negatives

    assert ranking_metrics(ranks, flight, truth).n_positive == 2


def test_result_is_the_contract_model():
    flight, ranks, truth = ten_frames()

    assert isinstance(ranking_metrics(ranks, flight, truth), Ranking)


def test_a_survey_with_no_positive_frames_is_rejected():
    flight = {"f0001": 0, "f0002": 1}

    with pytest.raises(ValueError, match="positive"):
        ranking_metrics({"f0001": 1, "f0002": 2}, flight, {"f0001": [], "f0002": []})


def test_ranks_must_cover_exactly_the_survey_frames():
    flight, ranks, truth = ten_frames()
    del ranks["f0010"]

    with pytest.raises(ValueError, match="f0010"):
        ranking_metrics(ranks, flight, truth)


def test_ranks_must_be_one_to_n():
    flight, ranks, truth = ten_frames()
    ranks["f0010"] = 4  # duplicate of f0001's rank

    with pytest.raises(ValueError, match="1..N"):
        ranking_metrics(ranks, flight, truth)
