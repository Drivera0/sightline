"""The sample cache ranks its frames exactly as the real pipeline does (rank_frames)."""

from __future__ import annotations

from sightline.contract import Detections, Survey
from sightline.pipeline.rank import rank_frames
from sightline.pipeline.sample import write_sample


def test_sample_scores_ranks_and_candidates_equal_rank_frames(tmp_path):
    write_sample(tmp_path / "sample", web_out=None)
    survey = Survey.model_validate_json((tmp_path / "sample" / "survey.json").read_text())
    detections = Detections.model_validate_json(
        (tmp_path / "sample" / "detections.json").read_text()
    )

    expected = rank_frames(
        detections.frames,
        {f.id: f.flight_index for f in survey.frames},
        detections.candidate_threshold,
    )

    for frame in survey.frames:
        score, rank, n_candidates = expected[frame.id]
        assert (frame.score, frame.rank, frame.n_candidates) == (score, rank, n_candidates)
