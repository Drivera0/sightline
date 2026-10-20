"""Check the OpenCV 5 detector (sightline/ml/detect_cv.py) against the Ultralytics + SAHI one.

    uv run --extra ml python scripts/compare_cv_detector.py \
        --pt data/weights/release_v2/yolo11s_tiles_run1_best.pt \
        [--onnx data/weights/release_v2/yolo11s_tiles_run1_best.onnx] [--photos 12]

Runs ``Detector.detect_tiled`` (single view) and ``CvDetector.detect_tiled`` on the first N val
photos (val only, like every other comparison script; test stays untouched) and reports, per
photo and overall: boxes from each, boxes matched one-to-one at IoU >= 0.9, the largest
confidence difference on a matched pair, and seconds per photo. At the candidate threshold the
two should agree box for box; tiny differences near 0.05 come from resize rounding and NMS ties.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def match(a, b, min_iou: float = 0.9):  # type: ignore[no-untyped-def]
    """Greedy one-to-one match by IoU; returns [(det_a, det_b, iou)]."""
    from sightline.ml.detect_cv import iou

    pairs = []
    used: set[int] = set()
    for da in a:
        best, best_j = 0.0, -1
        ba = (da.box.x1, da.box.y1, da.box.x2, da.box.y2)
        for j, db in enumerate(b):
            if j in used:
                continue
            v = iou(ba, (db.box.x1, db.box.y1, db.box.x2, db.box.y2))
            if v > best:
                best, best_j = v, j
        if best >= min_iou:
            used.add(best_j)
            pairs.append((da, b[best_j], best))
    return pairs


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--pt", type=Path, required=True)
    ap.add_argument("--onnx", type=Path, default=None, help="default: --pt with .onnx")
    ap.add_argument("--photos", type=int, default=12)
    ap.add_argument("--images", type=Path, default=ROOT / "data/heridal/yolo_full/val/images")
    ap.add_argument("--threshold", type=float, default=0.25, help="candidate threshold")
    args = ap.parse_args(argv)

    from sightline.ml.detect import Detector
    from sightline.ml.detect_cv import CvDetector

    onnx = args.onnx or args.pt.with_suffix(".onnx")
    photos = sorted(p for p in args.images.iterdir() if p.suffix.lower() in {".jpg", ".png"})
    photos = photos[: args.photos]
    if not photos:
        print(f"no photos in {args.images}")
        return 1

    ref = Detector(args.pt)
    cvd = CvDetector(onnx)
    print(f"ultralytics+sahi on {ref.device} | opencv dnn on cpu | {len(photos)} val photos\n")

    totals = {"ref": 0, "cv": 0, "matched": 0, "ref_s": 0.0, "cv_s": 0.0, "max_dconf": 0.0}
    for photo in photos:
        t = time.perf_counter()
        a = [d for d in ref.detect_tiled(photo) if d.conf >= args.threshold]
        totals["ref_s"] += time.perf_counter() - t
        t = time.perf_counter()
        b = [d for d in cvd.detect_tiled(photo) if d.conf >= args.threshold]
        totals["cv_s"] += time.perf_counter() - t
        pairs = match(a, b)
        dconf = max((abs(x.conf - y.conf) for x, y, _ in pairs), default=0.0)
        totals["ref"] += len(a)
        totals["cv"] += len(b)
        totals["matched"] += len(pairs)
        totals["max_dconf"] = max(totals["max_dconf"], dconf)
        flag = "" if len(pairs) == len(a) == len(b) else "  <-- differs"
        print(
            f"{photo.name:28} ultralytics {len(a):3}  opencv {len(b):3}  "
            f"matched {len(pairs):3}  max dconf {dconf:.3f}{flag}"
        )

    n = len(photos)
    print(
        f"\nboxes >= {args.threshold}: ultralytics {totals['ref']}, opencv {totals['cv']}, "
        f"matched at IoU>=0.9: {totals['matched']}"
    )
    print(f"largest confidence difference on a matched box: {totals['max_dconf']:.4f}")
    print(
        f"seconds per photo: ultralytics {totals['ref_s'] / n:.2f}, "
        f"opencv dnn {totals['cv_s'] / n:.2f}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
