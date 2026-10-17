"""Evaluate the detector and write data/work/detect/detector_metrics.json (docs/LANE_A_ML.md §6.3).

    python scripts/evaluate_model.py --weights data/runs/tiles_s/weights/best.pt \
        [--hn-weights data/runs/tiles_s_hn/weights/best.pt] [--stock yolo11s.pt] \
        [--model-name yolo11s-heridal-tiled] [--out data/work/detect/detector_metrics.json]

For every ablation row the threshold is chosen on **val** by maximising F2 with that row's own
inference mode, then precision/recall/AP50 are measured on the full **test** set. The
``detector`` block is the final model (hard-negative weights if given, else ``--weights``) with
tiled inference; its threshold is ``candidate_threshold``.

Needs the GPU and the ``ml`` extra. Takes a few minutes.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--weights", type=Path, required=True, help="best tiled-trained weights")
    ap.add_argument("--hn-weights", type=Path, default=None, help="weights after hard-negative fine-tune")
    ap.add_argument("--stock", type=Path, default=ROOT / "data/weights/yolo11s.pt", help="COCO weights")
    ap.add_argument("--model-name", default=None)
    ap.add_argument("--data-root", type=Path, default=ROOT / "data/heridal/yolo_full")
    ap.add_argument("--out", type=Path, default=ROOT / "data/work/detect/detector_metrics.json")
    ap.add_argument("--device", default="cuda:0")
    ap.add_argument("--limit", type=int, default=None, help="debug: only the first N images per split")
    args = ap.parse_args(argv)

    from sightline.ml.data import load_split
    from sightline.ml.detect import Detector
    from sightline.ml.evaluate import (
        ABLATION_NAMES,
        Ablation,
        DetectorMetrics,
        SarScores,
        VocScores,
        choose_threshold,
        evaluate,
        write_detector_metrics,
    )

    val = load_split("val", args.data_root)[: args.limit]
    test = load_split("test", args.data_root)[: args.limit]
    print(f"val {len(val)} images, test {len(test)} images")

    stock = Detector(args.stock, device=args.device)
    tuned = Detector(args.weights, device=args.device)
    hn = Detector(args.hn_weights, device=args.device) if args.hn_weights else None

    rows = []
    results: dict[str, dict[str, object]] = {}
    plan = [
        (ABLATION_NAMES[0], stock, "resized"),
        (ABLATION_NAMES[1], tuned, "resized"),
        (ABLATION_NAMES[2], tuned, "tiled"),
        (ABLATION_NAMES[3], hn, "tiled"),
    ]
    for name, det, mode in plan:
        if det is None:
            print(f"[{name}] no weights given: writing the row as zeros, re-run after §6.5")
            rows.append(Ablation(name=name, voc=VocScores(precision=0.0, recall=0.0, ap50=0.0)))
            continue
        t0 = time.time()
        thr = choose_threshold(det, val, mode)
        voc, sar, spi = evaluate(det, test, mode, thr)
        rows.append(Ablation(name=name, voc=voc))
        results[name] = {"threshold": thr, "voc": voc.model_dump(), "sar": sar.model_dump(), "seconds_per_image": spi}
        print(
            f"[{name}] thr={thr:.2f} P={voc.precision:.3f} R={voc.recall:.3f} AP50={voc.ap50:.3f} "
            f"SAR P={sar.precision:.3f} R={sar.recall:.3f} {spi:.2f}s/img ({time.time() - t0:.0f}s)"
        )

    final_name = ABLATION_NAMES[3] if hn else ABLATION_NAMES[2]
    final = results[final_name]
    model_name = args.model_name or (args.hn_weights or args.weights).parent.parent.name
    detector = DetectorMetrics(
        model=model_name,
        test_images=len(test),
        tiled=True,
        threshold=float(final["threshold"]),  # type: ignore[arg-type]
        voc=rows[3].voc if hn else rows[2].voc,
        sar=SarScores(**final["sar"]),  # type: ignore[arg-type]
        recall=float(final["voc"]["recall"]),  # type: ignore[index]
        seconds_per_image=float(final["seconds_per_image"]),  # type: ignore[arg-type]
    )
    write_detector_metrics(detector, rows, args.out)
    (args.out.parent / "evaluate_details.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"wrote {args.out}")
    print(f"candidate_threshold = {detector.threshold:.2f}; tell lane C: recall = {detector.recall:.3f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
