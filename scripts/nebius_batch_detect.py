"""Batch person detection over a folder of drone photos, for a Nebius Serverless Job (A-N1).

    python scripts/nebius_batch_detect.py IN_DIR OUT_DIR [--onnx PATH] [--threads N] [--limit N]

Runs the frozen detector on OpenCV 5 ``cv2.dnn`` (tiled, as the pipeline does for full-size
photos; no torch) over every JPEG in ``IN_DIR`` and writes ``OUT_DIR/detections_raw.json`` in
the format ``run_survey`` writes (model, thresholds, ``frames: {photo stem: [{box, conf}]}``),
plus ``OUT_DIR/job_summary.json`` with photo count, wall time, seconds per photo and the CPU
count, for the feedback report. The container is ``deploy/nebius/Dockerfile``; mount or sync
the photos into ``IN_DIR`` (the job's input volume) and read ``OUT_DIR`` back.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

MODEL_NAME = "yolo11s-heridal-tiled-run2"
SAVE_THRESHOLD = 0.05
CANDIDATE_THRESHOLD = 0.29
PHOTO_SUFFIXES = {".jpg", ".jpeg"}
RESULT_MARK = "=== sightline-result"


def detect_folder(detector, in_dir: Path, limit: int | None = None) -> dict:
    """``detect_tiled`` on every JPEG (sorted by name); the ``detections_raw.json`` document."""
    photos = sorted(p for p in in_dir.iterdir() if p.suffix.lower() in PHOTO_SUFFIXES)[:limit]
    if not photos:
        raise FileNotFoundError(f"no JPEG photos in {in_dir}")
    frames = {}
    for i, photo in enumerate(photos, 1):
        dets = detector.detect_tiled(photo, conf=SAVE_THRESHOLD)
        frames[photo.stem] = [
            {"box": [d.box.x1, d.box.y1, d.box.x2, d.box.y2], "conf": round(d.conf, 3)}
            for d in sorted(dets, key=lambda d: d.conf, reverse=True)
        ]
        print(f"[{i}/{len(photos)}] {photo.name}: {len(dets)} boxes", flush=True)
    return {
        "model": MODEL_NAME,
        "save_threshold": SAVE_THRESHOLD,
        "candidate_threshold": CANDIDATE_THRESHOLD,
        "frames": frames,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("in_dir", type=Path)
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--onnx", type=Path, default=os.environ.get("SIGHTLINE_ONNX"))
    ap.add_argument("--threads", type=int, default=None, help="default: every core")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument(
        "--print-results",
        action="store_true",
        help="also print both JSON files to stdout between markers (read back from the job's logs)",
    )
    args = ap.parse_args(argv)

    from sightline.ml.detect_cv import CvDetector

    if args.onnx is None:
        ap.error("pass --onnx or set SIGHTLINE_ONNX")
    detector = CvDetector(Path(args.onnx), threads=args.threads)
    t0 = time.perf_counter()
    doc = detect_folder(detector, args.in_dir, args.limit)
    seconds = time.perf_counter() - t0

    args.out_dir.mkdir(parents=True, exist_ok=True)
    (args.out_dir / "detections_raw.json").write_text(json.dumps(doc, indent=1) + "\n")
    n = len(doc["frames"])
    summary = {
        "photos": n,
        "boxes": sum(len(v) for v in doc["frames"].values()),
        "candidates": sum(
            1 for v in doc["frames"].values() for d in v if d["conf"] >= CANDIDATE_THRESHOLD
        ),
        "wall_seconds": round(seconds, 1),
        "seconds_per_photo": round(seconds / n, 2),
        "cpus": os.cpu_count(),
        "onnx": Path(args.onnx).name,
        "rect_letterbox": detector.rect,
    }
    (args.out_dir / "job_summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary))
    if args.print_results:
        for name, body in (("detections_raw.json", doc), ("job_summary.json", summary)):
            print(
                f"{RESULT_MARK} {name}\n{json.dumps(body, separators=(',', ':'))}\n{RESULT_MARK} end",
                flush=True,
            )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
