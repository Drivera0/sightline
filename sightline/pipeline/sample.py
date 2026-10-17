"""The sample cache: fake data every lane builds against from hour 1 (LANE_D section 6.1).

Everything here is clearly fake: model "SAMPLE", a uniform placeholder prior, and one empty step
per frame until lane C's `build_map` exists. Frames are synthetic unless real test images are given.
"""

from __future__ import annotations

import math
import random
import shutil
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path

from PIL import Image, ImageDraw

from sightline.contract import (
    CONTRACT_VERSION,
    Area,
    Detection,
    Detections,
    Distribution,
    Frame,
    Grid,
    LatLon,
    Manifest,
    MapFile,
    Metrics,
    Params,
    Pose,
    Source,
    StageResult,
    Stages,
    Step,
    Survey,
    TopCell,
    dump_json,
)
from sightline.pipeline.export import HUMAN_BASELINE
from sightline.pipeline.geometry import (
    FRAME_H_PX as FRAME_H,
)
from sightline.pipeline.geometry import (
    FRAME_W_PX as FRAME_W,
)
from sightline.pipeline.geometry import (
    M_PER_DEG_LAT,
    footprint,
    offset,
    pixel_to_latlon,
    placeholder_flight,
)

SURVEY_ID = "sample"
N_FRAMES = 20
LKP = LatLon(lat=49.37, lon=-122.945)
CANDIDATE_THRESHOLD = 0.25
GRID_ROWS = GRID_COLS = 50
CELL_M = 20.0
PRIOR_OUTSIDE = 0.35
GENERATED_AT = datetime(2026, 1, 1, tzinfo=UTC)

# (conf, box) per flight_index; sorted by conf when written.
_FAKE_DETECTIONS: dict[int, list[tuple[float, tuple[int, int, int, int]]]] = {
    2: [(0.12, (700, 200, 730, 240))],
    4: [(0.874, (512, 300, 560, 362)), (0.091, (88, 610, 120, 641))],
    7: [(0.31, (300, 420, 340, 470))],
    11: [(0.612, (620, 150, 660, 205))],
    15: [(0.08, (150, 500, 178, 535))],
}
# Frames the fake ranking metrics pretend are true positives. Never written to the cache.
_FAKE_POSITIVE_INDEXES = (4, 11)


def write_sample(
    out: Path = Path("cache/sample"),
    web_out: Path | None = Path("web/public/cache/sample"),
    images: Sequence[Path] = (),
) -> None:
    """Write a valid 20-frame sample cache to `out`, and copy it to `web_out` when given.

    `images` are real 4000x3000 (or 4000x2250) photos to cut frames from; without them the
    frames are synthetic.
    """
    (out / "frames").mkdir(parents=True, exist_ok=True)
    (out / "crops").mkdir(parents=True, exist_ok=True)

    poses = placeholder_flight(N_FRAMES, LKP)
    sources = _write_frames(out, images)
    detections = _detections(out, poses)
    scores = [max((d.conf for d in detections[_fid(k)]), default=0.0) for k in range(N_FRAMES)]
    n_candidates = [
        sum(d.conf >= CANDIDATE_THRESHOLD for d in detections[_fid(k)]) for k in range(N_FRAMES)
    ]
    order = sorted(range(N_FRAMES), key=lambda k: (-scores[k], -n_candidates[k], k))
    rank = {k: i + 1 for i, k in enumerate(order)}

    survey = Survey(
        contract_version=CONTRACT_VERSION,
        survey_id=SURVEY_ID,
        simulated_path=True,
        area=Area(name="Mount Seymour, North Vancouver (simulated flight path)", lkp=LKP),
        frames=[
            Frame(
                id=_fid(k),
                file=f"frames/{_fid(k)}.jpg",
                width_px=FRAME_W,
                height_px=FRAME_H,
                flight_index=k,
                source=sources[k],
                pose=poses[k],
                footprint=footprint(poses[k]),
                score=scores[k],
                rank=rank[k],
                n_candidates=n_candidates[k],
            )
            for k in range(N_FRAMES)
        ],
    )
    det_file = Detections(
        contract_version=CONTRACT_VERSION,
        model="SAMPLE",
        save_threshold=0.05,
        candidate_threshold=CANDIDATE_THRESHOLD,
        frames=detections,
    )
    metrics = _metrics(rank)
    map_file = _placeholder_map(metrics.detector.recall)
    manifest = Manifest(
        contract_version=CONTRACT_VERSION,
        survey_id=SURVEY_ID,
        generated_at=GENERATED_AT,
        git_sha=None,
        simulated_path=True,
        n_frames=N_FRAMES,
        stages=Stages(**{name: StageResult(ok=True, seconds=0.0) for name in Stages.model_fields}),
        notes="SAMPLE: fake detections and metrics, placeholder uniform prior, one empty step per "
        "frame, simulated flight path.",
    )

    for name, model in (
        ("survey", survey),
        ("detections", det_file),
        ("map", map_file),
        ("metrics", metrics),
        ("manifest", manifest),
    ):  # manifest last
        (out / f"{name}.json").write_text(dump_json(model))

    if web_out is not None:
        shutil.copytree(out, web_out, dirs_exist_ok=True)


def _fid(k: int) -> str:
    return f"f{k + 1:04d}"


def _write_frames(out: Path, images: Sequence[Path]) -> list[Source]:
    sources = []
    for k in range(N_FRAMES):
        if images:
            per_image = math.ceil(N_FRAMES / len(images))
            path = images[k // per_image]
            with Image.open(path) as photo:
                cols, rows = photo.width // FRAME_W, photo.height // FRAME_H
                tile = (k % per_image) % (cols * rows)
                x0, y0 = (tile % cols) * FRAME_W, (tile // cols) * FRAME_H
                frame = photo.crop((x0, y0, x0 + FRAME_W, y0 + FRAME_H)).convert("RGB")
            source = Source(image=path.name, x0=x0, y0=y0)
        else:
            frame = _synthetic_frame(k)
            source = Source(image="SAMPLE_synthetic.jpg", x0=0, y0=0)
        frame.save(out / "frames" / f"{_fid(k)}.jpg", quality=85)
        sources.append(source)
    return sources


def _synthetic_frame(k: int) -> Image.Image:
    rng = random.Random(k)
    image = Image.new("RGB", (FRAME_W, FRAME_H), (70, 92, 62))
    draw = ImageDraw.Draw(image)
    for _ in range(60):
        x, y = rng.randrange(FRAME_W), rng.randrange(FRAME_H)
        r = rng.randrange(10, 60)
        shade = rng.randrange(30, 120)
        draw.ellipse((x - r, y - r, x + r, y + r), fill=(shade // 2, shade, shade // 2))
    for _, box in _FAKE_DETECTIONS.get(k, []):
        draw.rectangle(box, fill=(210, 95, 40))
    draw.text((16, 16), f"SAMPLE {_fid(k)}", fill=(255, 255, 255))
    return image


def _detections(out: Path, poses: list[Pose]) -> dict[str, list[Detection]]:
    result: dict[str, list[Detection]] = {}
    for k in range(N_FRAMES):
        fid = _fid(k)
        result[fid] = []
        for n, (conf, box) in enumerate(sorted(_FAKE_DETECTIONS.get(k, []), reverse=True), start=1):
            lat, lon = pixel_to_latlon(poses[k], (box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
            crop = None
            if conf >= CANDIDATE_THRESHOLD:
                crop = f"crops/{fid}-d{n:02d}.jpg"
                _write_crop(out / "frames" / f"{fid}.jpg", box, out / crop)
            result[fid].append(
                Detection(
                    id=f"{fid}-d{n:02d}",
                    box_px=box,
                    conf=conf,
                    crop=crop,
                    lat=lat,
                    lon=lon,
                    radius_m=10.0,
                )
            )
    return result


def _write_crop(frame_path: Path, box: tuple[int, int, int, int], crop_path: Path) -> None:
    """128x128 window centred on the box (clamped to the frame), upscaled 2x to 256x256."""
    cx, cy = (box[0] + box[2]) // 2, (box[1] + box[3]) // 2
    x0 = min(max(cx - 64, 0), FRAME_W - 128)
    y0 = min(max(cy - 64, 0), FRAME_H - 128)
    with Image.open(frame_path) as frame:
        window = frame.crop((x0, y0, x0 + 128, y0 + 128)).resize(
            (256, 256), Image.Resampling.BICUBIC
        )
    window.save(crop_path, quality=90)


def _cell_center(grid: Grid, idx: int) -> tuple[float, float]:
    row, col = divmod(idx, grid.cols)
    lat = grid.origin_nw.lat - (row + 0.5) * grid.cell_m / M_PER_DEG_LAT
    lon = grid.origin_nw.lon + (col + 0.5) * grid.cell_m / (
        M_PER_DEG_LAT * math.cos(math.radians(grid.origin_nw.lat))
    )
    return lat, lon


def _placeholder_map(recall: float) -> MapFile:
    """Uniform prior, no coverage yet: one empty step per frame, so final == prior."""
    half = GRID_ROWS * CELL_M / 2
    nw_lat, _ = offset(LKP.lat, LKP.lon, 0, half)
    _, nw_lon = offset(nw_lat, LKP.lon, -half, 0)
    # The contract's grid longitude uses cos(origin_nw.lat), so recompute with that latitude.
    nw_lon = LKP.lon - half / (M_PER_DEG_LAT * math.cos(math.radians(nw_lat)))
    grid = Grid(
        origin_nw=LatLon(lat=nw_lat, lon=nw_lon), cell_m=CELL_M, rows=GRID_ROWS, cols=GRID_COLS
    )
    n = GRID_ROWS * GRID_COLS
    p = (1 - PRIOR_OUTSIDE) / n
    top = [
        TopCell(idx=i, lat=lat, lon=lon, p=p, canopy=None)
        for i in range(5)
        for lat, lon in [_cell_center(grid, i)]
    ]
    return MapFile(
        contract_version=CONTRACT_VERSION,
        grid=grid,
        lkp=LKP,
        params=Params(
            recall=recall, recall_source="metrics.detector.recall", pod_cap=0.95, review_pod=0.90
        ),
        prior=Distribution(p=[p] * n, outside=PRIOR_OUTSIDE),
        canopy=[None] * n,
        steps=[Step(frame_id=_fid(k), cells=[]) for k in range(N_FRAMES)],
        final=Distribution(p=[p] * n, outside=PRIOR_OUTSIDE),
        top_cells=top,
    )


def _metrics(rank: dict[int, int]) -> Metrics:
    positives = _FAKE_POSITIVE_INDEXES
    ranked_positions = sorted(rank[k] for k in positives)
    flight_positions = sorted(k + 1 for k in positives)
    voc = {"precision": 0.812, "recall": 0.8, "ap50": 0.766}
    return Metrics.model_validate(
        {
            "contract_version": CONTRACT_VERSION,
            "detector": {
                "model": "SAMPLE",
                "test_images": 101,
                "tiled": True,
                "threshold": CANDIDATE_THRESHOLD,
                "voc": voc,
                "sar": {"precision": 0.86, "recall": 0.84, "ap": 0.79},
                "recall": voc["recall"],
                "seconds_per_image": 0.9,
            },
            "baseline_human": HUMAN_BASELINE.model_dump(),
            "ablations": [
                {
                    "name": "Stock model, no tiling",
                    "voc": {"precision": 0.31, "recall": 0.42, "ap50": 0.28},
                },
                {
                    "name": "Fine-tuned, no tiling",
                    "voc": {"precision": 0.55, "recall": 0.61, "ap50": 0.52},
                },
                {
                    "name": "Fine-tuned + tiling",
                    "voc": {"precision": 0.74, "recall": 0.77, "ap50": 0.71},
                },
                {"name": "+ hard negatives", "voc": voc},
            ],
            "ranking": {
                "n_frames": N_FRAMES,
                "n_positive": len(positives),
                "flight_order": {
                    "frames_to_first_hit": flight_positions[0],
                    "frames_to_all_hits": flight_positions[-1],
                },
                "ranked": {
                    "frames_to_first_hit": ranked_positions[0],
                    "frames_to_all_hits": ranked_positions[-1],
                },
                "expected_first_hit_random_order": (N_FRAMES + 1) / (len(positives) + 1),
                "minutes_at_human_pace": {
                    "flight_order_first": flight_positions[0] * 33 / 60,
                    "ranked_first": ranked_positions[0] * 33 / 60,
                },
                "note": "SAMPLE numbers. Minutes use the published 33 s per image, measured on "
                "full 4000×3000 photos.",
            },
            "search_sim": {
                "simulated": True,
                "trials": 1000,
                "seed": 7,
                "found_by_drone_rate": 0.5,
                "methods": [
                    {"name": "Prior only", "median_cells": 410, "p90_cells": 980},
                    {
                        "name": "Naive: photographed = cleared",
                        "median_cells": 350,
                        "p90_cells": 900,
                    },
                    {"name": "Sightline: canopy-aware", "median_cells": 120, "p90_cells": 450},
                ],
            },
        }
    )
