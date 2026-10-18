"""Placeholder outputs: what a stage writes when a lane's function is not available yet (§8)."""

from __future__ import annotations

from sightline.contract import LatLon, MapFile, Metrics, SearchSim
from sightline.ml.evaluate import ABLATION_NAMES as LANE_A_ABLATION_NAMES
from sightline.pipeline.formats import DetectConfig, DetectorMetricsFile, RawDetectionsFile
from sightline.pipeline.placeholders import (
    ABLATION_NAMES,
    placeholder_detections,
    placeholder_detector_metrics,
    placeholder_map,
    placeholder_search_sim,
)

LKP = LatLon(lat=49.37, lon=-122.945)
IDS = [f"f{i:04d}" for i in range(1, 501)]


def test_placeholder_map_has_one_empty_step_per_frame_in_the_order_given():
    map_file, cells = placeholder_map(IDS, LKP, recall=0.8)

    assert [s.frame_id for s in map_file.steps] == IDS
    assert all(s.cells == [] for s in map_file.steps)
    assert cells == {fid: [] for fid in IDS}


def test_placeholder_map_is_a_uniform_prior_and_final_equals_prior():
    map_file, _ = placeholder_map(IDS, LKP, recall=0.8)

    assert len(set(map_file.prior.p)) == 1
    assert map_file.final == map_file.prior
    assert map_file.prior.outside == 0.35


def test_placeholder_map_is_a_valid_contract_map_with_five_top_cells():
    map_file, _ = placeholder_map(IDS, LKP, recall=0.75)

    assert isinstance(map_file, MapFile)
    assert len(map_file.top_cells) == 5
    assert map_file.params.recall == 0.75
    assert map_file.params.recall_source == "metrics.detector.recall"
    assert map_file.lkp == LKP


def test_placeholder_map_has_no_canopy_because_no_frame_was_analysed():
    map_file, _ = placeholder_map(IDS, LKP, recall=0.8)

    assert set(map_file.canopy) == {None}


def test_placeholder_detections_list_every_frame_with_no_detections():
    raw, config = placeholder_detections(IDS, candidate_threshold=0.25)

    assert isinstance(raw, RawDetectionsFile) and isinstance(config, DetectConfig)
    assert raw.frames == {fid: [] for fid in IDS}
    assert raw.model == config.model == "PLACEHOLDER"
    assert raw.candidate_threshold == config.candidate_threshold == 0.25


def test_placeholder_detector_metrics_are_zeros_labelled_placeholder_with_the_seven_ablation_rows():
    file = placeholder_detector_metrics(candidate_threshold=0.25)

    assert isinstance(file, DetectorMetricsFile)
    assert file.detector.model == "PLACEHOLDER"
    assert file.detector.voc.recall == file.detector.recall == 0.0
    assert [a.name for a in file.ablations] == [
        "Stock model, no tiling",
        "Fine-tuned on tiles, run on shrunk photos",
        "Stock model, full-resolution photo",
        "Fine-tuned on tiles, full-resolution photo",
        "Trained and run on whole photos",
        "Fine-tuned + tiling",
        "+ hard negatives",
    ]
    assert list(ABLATION_NAMES) == list(LANE_A_ABLATION_NAMES)


def test_placeholder_search_sim_is_marked_simulated_and_has_the_three_methods():
    sim = placeholder_search_sim()

    assert isinstance(sim, SearchSim) and sim.simulated is True
    assert [m.name for m in sim.methods] == [
        "Prior only",
        "Naive: photographed = cleared",
        "Sightline: canopy-aware",
    ]
    assert sim.trials == 0


def test_placeholder_pieces_fit_together_in_a_metrics_file():
    from sightline.pipeline.export import HUMAN_BASELINE
    from sightline.pipeline.rank import ranking_metrics

    detector = placeholder_detector_metrics(0.25)
    ranks = {fid: i for i, fid in enumerate(IDS, start=1)}
    flight = {fid: i for i, fid in enumerate(IDS)}
    ranking = ranking_metrics(ranks, flight, {IDS[10]: [object()]})

    metrics = Metrics(
        contract_version="1.0",
        detector=detector.detector,
        baseline_human=HUMAN_BASELINE,
        ablations=detector.ablations,
        ranking=ranking,
        search_sim=placeholder_search_sim(),
    )

    assert metrics.detector.model == "PLACEHOLDER"
