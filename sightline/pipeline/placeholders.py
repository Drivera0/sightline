"""Placeholder outputs for lane functions that do not exist yet (LANE_D section 8).

Each one is shaped to the CURRENT survey (not the 20-frame sample) and is labelled so it can never
pass for real data: model "PLACEHOLDER", zero metrics, an empty-step map on a uniform prior.
"""

from __future__ import annotations

from collections.abc import Sequence

from sightline.contract import (
    CONTRACT_VERSION,
    Ablation,
    DetectorMetrics,
    Distribution,
    Grid,
    LatLon,
    MapFile,
    Params,
    SarScores,
    SearchMethod,
    SearchSim,
    Step,
    TopCell,
    VocScores,
)
from sightline.pipeline.formats import DetectConfig, DetectorMetricsFile, RawDetectionsFile
from sightline.pipeline.geometry import CELL_M, GRID_COLS, GRID_ROWS, cell_center, grid_origin_nw

PRIOR_OUTSIDE = 0.35
POD_CAP = 0.95
REVIEW_POD = 0.90
PLACEHOLDER_MODEL = "PLACEHOLDER"
ABLATION_NAMES = (
    "Stock model, no tiling",
    "Fine-tuned, no tiling",
    "Fine-tuned + tiling",
    "+ hard negatives",
)
SEARCH_METHOD_NAMES = ("Prior only", "Naive: photographed = cleared", "Sightline: canopy-aware")


def placeholder_map(
    frame_ids: Sequence[str],
    lkp: LatLon,
    recall: float,
    recall_source: str = "metrics.detector.recall",
) -> tuple[MapFile, dict[str, list[tuple[int, float | None, float]]]]:
    """Uniform prior and one empty step per frame (so `final == prior`), plus empty frame cells."""
    grid = Grid(origin_nw=grid_origin_nw(lkp), cell_m=CELL_M, rows=GRID_ROWS, cols=GRID_COLS)
    n = grid.rows * grid.cols
    p = (1 - PRIOR_OUTSIDE) / n
    top_cells = []
    for idx in range(5):
        lat, lon = cell_center(grid, idx)
        top_cells.append(TopCell(idx=idx, lat=lat, lon=lon, p=p, canopy=None))
    map_file = MapFile(
        contract_version=CONTRACT_VERSION,
        grid=grid,
        lkp=lkp,
        params=Params(
            recall=recall,
            recall_source=recall_source,
            pod_cap=POD_CAP,
            review_pod=REVIEW_POD,
        ),
        prior=Distribution(p=[p] * n, outside=PRIOR_OUTSIDE),
        canopy=[None] * n,
        steps=[Step(frame_id=fid, cells=[]) for fid in frame_ids],
        final=Distribution(p=[p] * n, outside=PRIOR_OUTSIDE),
        top_cells=top_cells,
    )
    return map_file, {fid: [] for fid in frame_ids}


def placeholder_detections(
    frame_ids: Sequence[str], candidate_threshold: float, save_threshold: float = 0.05
) -> tuple[RawDetectionsFile, DetectConfig]:
    """No detections for any frame."""
    raw = RawDetectionsFile(
        model=PLACEHOLDER_MODEL,
        save_threshold=save_threshold,
        candidate_threshold=candidate_threshold,
        frames={fid: [] for fid in frame_ids},
    )
    config = DetectConfig(
        weights="",
        model=PLACEHOLDER_MODEL,
        candidate_threshold=candidate_threshold,
        save_threshold=save_threshold,
    )
    return raw, config


def placeholder_detector_metrics(candidate_threshold: float) -> DetectorMetricsFile:
    zero_voc = VocScores(precision=0.0, recall=0.0, ap50=0.0)
    return DetectorMetricsFile(
        detector=DetectorMetrics(
            model=PLACEHOLDER_MODEL,
            test_images=0,
            tiled=False,
            threshold=candidate_threshold,
            voc=zero_voc,
            sar=SarScores(precision=0.0, recall=0.0, ap=0.0),
            recall=0.0,
            seconds_per_image=0.0,
        ),
        ablations=[Ablation(name=name, voc=zero_voc) for name in ABLATION_NAMES],
    )


def placeholder_search_sim() -> SearchSim:
    return SearchSim(
        simulated=True,
        trials=0,
        seed=7,
        found_by_drone_rate=0.0,
        methods=[SearchMethod(name=n, median_cells=0, p90_cells=0) for n in SEARCH_METHOD_NAMES],
    )
