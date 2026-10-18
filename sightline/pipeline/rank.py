"""Frame scoring, ranking and the ranking metrics (LANE_D section 6.3).

`RawDetection` is lane A's type (`sightline.ml.types`); this module only reads its `conf`.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Protocol

from sightline.contract import HitPositions, MinutesAtHumanPace, Ranking

HUMAN_SECONDS_PER_IMAGE = 33  # Pyrrö, Naseri & Jung 2021, on full 4000×3000 photos
RANKING_NOTE = "Minutes use the published 33 s per image, measured on full 4000×3000 photos."


class DetectionLike(Protocol):
    @property
    def conf(self) -> float: ...


def rank_frames(
    dets: Mapping[str, Sequence[DetectionLike]],
    flight_index: Mapping[str, int],
    candidate_threshold: float,
) -> dict[str, tuple[float, int, int]]:
    """Return frame id -> (score, rank, n_candidates).

    Score is the highest confidence in the frame (0.0 if none). Rank 1 is the most likely to hold a
    person: higher score first, then more candidates (conf >= threshold), then earlier flight_index.
    Frames missing from `dets` count as having no detections.
    """
    unknown = sorted(set(dets) - set(flight_index))
    if unknown:
        raise ValueError(f"detections for frames that are not in the survey: {', '.join(unknown)}")

    scores = {f: max((d.conf for d in dets.get(f, ())), default=0.0) for f in flight_index}
    candidates = {
        f: sum(d.conf >= candidate_threshold for d in dets.get(f, ())) for f in flight_index
    }
    order = sorted(flight_index, key=lambda f: (-scores[f], -candidates[f], flight_index[f]))
    return {f: (scores[f], position, candidates[f]) for position, f in enumerate(order, start=1)}


def ranking_metrics(
    ranks: Mapping[str, int],
    flight_index: Mapping[str, int],
    truth: Mapping[str, Sequence[object]],
) -> Ranking:
    """How many frames a reviewer opens before the first / last true hit, by flight order and by rank.

    A frame is a true positive when `truth` lists at least one box for it. Positions are 1-based.
    """
    if set(ranks) != set(flight_index):
        missing = sorted(set(flight_index) ^ set(ranks))
        raise ValueError(
            f"ranks and flight_index must cover the same frames; differ on {missing[:5]}"
        )
    n_frames = len(flight_index)
    if sorted(ranks.values()) != list(range(1, n_frames + 1)):
        raise ValueError("rank values must be exactly 1..N")
    positives = [f for f in flight_index if truth.get(f)]
    if not positives:
        raise ValueError("the survey has no positive frames, so there is no first hit to measure")

    in_flight_order = sorted(flight_index[f] + 1 for f in positives)
    in_ranked_order = sorted(ranks[f] for f in positives)
    return Ranking(
        n_frames=n_frames,
        n_positive=len(positives),
        flight_order=HitPositions(
            frames_to_first_hit=in_flight_order[0], frames_to_all_hits=in_flight_order[-1]
        ),
        ranked=HitPositions(
            frames_to_first_hit=in_ranked_order[0], frames_to_all_hits=in_ranked_order[-1]
        ),
        expected_first_hit_random_order=(n_frames + 1) / (len(positives) + 1),
        minutes_at_human_pace=MinutesAtHumanPace(
            flight_order_first=in_flight_order[0] * HUMAN_SECONDS_PER_IMAGE / 60,
            ranked_first=in_ranked_order[0] * HUMAN_SECONDS_PER_IMAGE / 60,
        ),
        note=RANKING_NOTE,
    )
