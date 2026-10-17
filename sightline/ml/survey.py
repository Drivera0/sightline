"""Detection on the demo frames: the ONE entry point D's ``detect`` stage calls (docs/LANE_A_ML.md §6.4)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Protocol

from sightline.ml.crops import make_crop
from sightline.ml.types import RawDetection


class FrameDetector(Protocol):
    def detect_frame(self, image: Path, conf: float = 0.05) -> list[RawDetection]: ...


def run_survey(
    frames_dir: Path,
    weights: Path,
    out_dir: Path,
    candidate_threshold: float,
    model_name: str,
    save_threshold: float = 0.05,
    detector: FrameDetector | None = None,
) -> None:
    """``detect_frame`` on every frame → ``out_dir/detections_raw.json``; ``make_crop`` for every
    detection with ``conf ≥ candidate_threshold`` → ``out_dir/crops/<frame_id>-dNN.jpg``;
    writes ``out_dir/config.json``.

    ``detector`` is injectable for tests; by default a ``Detector`` is built from ``weights``.
    """
    frames = sorted(Path(frames_dir).glob("*.jpg"))
    if not frames:
        raise FileNotFoundError(f"no .jpg frames in {frames_dir}")
    if detector is None:
        from sightline.ml.detect import Detector

        detector = Detector(Path(weights))

    out_dir = Path(out_dir)
    crops_dir = out_dir / "crops"
    crops_dir.mkdir(parents=True, exist_ok=True)

    per_frame: dict[str, list[dict[str, object]]] = {}
    n_dets = n_crops = 0
    for frame in frames:
        dets = sorted(detector.detect_frame(frame, conf=save_threshold), key=lambda d: d.conf, reverse=True)
        per_frame[frame.stem] = [
            {"box": [d.box.x1, d.box.y1, d.box.x2, d.box.y2], "conf": round(d.conf, 3)} for d in dets
        ]
        n_dets += len(dets)
        for i, d in enumerate(dets, 1):
            if d.conf >= candidate_threshold:
                make_crop(frame, d.box, crops_dir / f"{frame.stem}-d{i:02d}.jpg")
                n_crops += 1

    (out_dir / "detections_raw.json").write_text(
        json.dumps(
            {
                "model": model_name,
                "save_threshold": save_threshold,
                "candidate_threshold": candidate_threshold,
                "frames": per_frame,
            },
            indent=1,
        )
        + "\n",
        encoding="utf-8",
    )
    (out_dir / "config.json").write_text(
        json.dumps(
            {
                "weights": str(weights),
                "model": model_name,
                "candidate_threshold": candidate_threshold,
                "save_threshold": save_threshold,
                "n_frames": len(frames),
                "n_detections": n_dets,
                "n_crops": n_crops,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
