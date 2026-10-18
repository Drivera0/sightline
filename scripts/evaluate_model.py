"""Evaluate the detector and write data/work/detect/detector_metrics.json (docs/LANE_A_ML.md §6.3).

    python scripts/evaluate_model.py --weights data/runs/tiles_s/weights/best.pt \
        [--hn-weights data/runs/tiles_s_hn/weights/best.pt] [--stock yolo11s.pt] \
        [--model-name yolo11s-heridal-tiled] [--final auto|tiled|hn]         [--out data/work/detect/detector_metrics.json]

For every ablation row the threshold is chosen on **val** by maximising F2 with that row's own
inference mode, then precision/recall/AP50 are measured on the full **test** set. The
``detector`` block is the final model (hard-negative weights if given, else ``--weights``) with
tiled inference; its threshold is ``candidate_threshold``.

Also writes ``operating_points.json`` (lane A's own file, not a contract file): the primary F2
threshold and a secondary high-recall threshold (highest threshold with val recall >= 0.90),
both chosen on val, with val and test precision/recall/F2 and 'found the person' recall where a
loose box (IoU >= 0.1) counts; and ``test_preds_final.json`` (the final row's test boxes).

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
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--weights", type=Path, required=True, help="best tiled-trained weights")
    ap.add_argument(
        "--hn-weights", type=Path, default=None, help="weights after hard-negative fine-tune"
    )
    ap.add_argument(
        "--stock", type=Path, default=ROOT / "data/weights/yolo11s.pt", help="COCO weights"
    )
    ap.add_argument("--model-name", default=None)
    ap.add_argument(
        "--final",
        choices=["auto", "tiled", "hn"],
        default="auto",
        help="row reported as the detector: auto = hard negatives if given, else fine-tuned + tiling "
        "(weights-v2 measured the hard-negative row but kept fine-tuned + tiling)",
    )
    ap.add_argument("--data-root", type=Path, default=ROOT / "data/heridal/yolo_full")
    ap.add_argument("--out", type=Path, default=ROOT / "data/work/detect/detector_metrics.json")
    ap.add_argument("--device", default="auto", help="auto = cuda, then mps, then cpu")
    ap.add_argument(
        "--limit", type=int, default=None, help="debug: only the first N images per split"
    )
    args = ap.parse_args(argv)

    from sightline.ml.data import load_split
    from sightline.ml.detect import Detector
    from sightline.ml.evaluate import (
        ABLATION_NAMES,
        Ablation,
        DetectorMetrics,
        SarScores,
        choose_threshold_from_preds,
        predict_split,
        score_sar,
        score_voc,
        write_detector_metrics,
    )
    from sightline.ml.tuning import scores_at

    # Threshold on annotated val photos only: unlabelled people would count as false positives.
    val = load_split("val", args.data_root, annotated_only=True)[: args.limit]
    test = load_split("test", args.data_root)[: args.limit]
    print(f"val {len(val)} images, test {len(test)} images")

    stock = Detector(args.stock, device=args.device)
    tuned = Detector(args.weights, device=args.device)
    hn = Detector(args.hn_weights, device=args.device) if args.hn_weights else None

    use_hn = hn is not None if args.final == "auto" else args.final == "hn"
    final_name = ABLATION_NAMES[3] if use_hn else ABLATION_NAMES[2]

    rows = []
    results: dict[str, dict[str, object]] = {}
    final_preds: dict[str, object] = {}
    plan = [
        (ABLATION_NAMES[0], stock, "resized"),
        (ABLATION_NAMES[1], tuned, "resized"),
        (ABLATION_NAMES[2], tuned, "tiled"),
        (ABLATION_NAMES[3], hn, "tiled"),
    ]
    for name, det, mode in plan:
        if det is None:
            # Not run yet: omit the row. Never write zeros as a stand-in (see write_detector_metrics).
            print(f"[{name}] not measured yet (no weights given): row omitted, re-run after §6.5")
            continue
        t0 = time.time()
        val_preds, val_truth, _ = predict_split(det, val, mode)  # type: ignore[arg-type]
        thr = choose_threshold_from_preds(val_preds, val_truth)  # threshold from val only
        test_preds, test_truth, spi = predict_split(det, test, mode)  # type: ignore[arg-type]
        voc, sar = score_voc(test_preds, test_truth, thr), score_sar(test_preds, test_truth, thr)
        rows.append(Ablation(name=name, voc=voc))
        results[name] = {
            "threshold": thr,
            "voc": voc.model_dump(),
            "sar": sar.model_dump(),
            "f2": scores_at(test_preds, test_truth, thr).f2,
            "seconds_per_image": spi,
        }
        if name == final_name:
            final_preds = {"val": (val_preds, val_truth), "test": (test_preds, test_truth)}
        print(
            f"[{name}] thr={thr:.2f} P={voc.precision:.3f} R={voc.recall:.3f} AP50={voc.ap50:.3f} "
            f"SAR P={sar.precision:.3f} R={sar.recall:.3f} {spi:.2f}s/img ({time.time() - t0:.0f}s)"
        )

    final = results[final_name]
    final_voc = next(r.voc for r in rows if r.name == final_name)
    model_name = args.model_name or (args.hn_weights if use_hn else args.weights).parent.parent.name
    detector = DetectorMetrics(
        model=model_name,
        test_images=len(test),
        tiled=True,
        threshold=float(final["threshold"]),  # type: ignore[arg-type]
        voc=final_voc,
        sar=SarScores(**final["sar"]),  # type: ignore[arg-type]
        recall=float(final["voc"]["recall"]),  # type: ignore[index]
        seconds_per_image=float(final["seconds_per_image"]),  # type: ignore[arg-type]
    )
    write_detector_metrics(detector, rows, args.out)
    (args.out.parent / "evaluate_details.json").write_text(
        json.dumps(results, indent=2), encoding="utf-8"
    )
    write_operating_points(
        final_preds,
        float(final["threshold"]),
        model_name,
        args.out.parent / "operating_points.json",
    )
    print(f"wrote {args.out}")
    print(
        f"candidate_threshold = {detector.threshold:.2f}; tell lane C: recall = {detector.recall:.3f}"
    )
    return 0


HIGH_RECALL_TARGET = 0.90
HIGH_RECALL_RULE = (
    "highest threshold whose VOC recall on the annotated val photos is >= 0.90 (rule fixed "
    "before any result was seen; scripts/tune_on_val.py)"
)
LOOSE_IOU = 0.1


def write_operating_points(preds: dict[str, object], primary: float, model: str, out: Path) -> None:
    """Lane A's own file (not a contract file): the primary F2 operating point and the secondary
    high-recall one, each with val and test scores, plus 'found the person' recall where a loose
    box (IoU >= 0.1, one-to-one) counts. Both thresholds come from val; test is only scored."""
    from sightline.ml.tuning import scores_at, threshold_for_recall

    val_preds, val_truth = preds["val"]  # type: ignore[index]
    test_preds, test_truth = preds["test"]  # type: ignore[index]
    high = threshold_for_recall(val_preds, val_truth, HIGH_RECALL_TARGET)

    def block(p: object, t: object, thr: float) -> dict[str, float]:
        voc = scores_at(p, t, thr)  # type: ignore[arg-type]
        loose = scores_at(p, t, thr, iou_threshold=LOOSE_IOU)  # type: ignore[arg-type]
        return {
            "precision": round(voc.precision, 3),
            "recall": round(voc.recall, 3),
            "f2": round(voc.f2, 3),
            "found": voc.tp,
            "missed": voc.n_truth - voc.tp,
            "false_alarms": voc.n_pred - voc.tp,
            "recall_loose_iou_0.1": round(loose.recall, 3),
        }

    payload = {
        "model": model,
        "note": "Thresholds chosen on val only. recall_loose_iou_0.1 counts a person as found "
        "when a box overlaps them at IoU >= 0.1 (one box per person), so a loose box still finds "
        "them. Not a contract file: metrics.json has no field for a second operating point.",
        "primary": {
            "rule": "max F2 on the annotated val photos",
            "threshold": primary,
            "val": block(val_preds, val_truth, primary),
            "test": block(test_preds, test_truth, primary),
        },
        "high_recall": {
            "rule": HIGH_RECALL_RULE,
            "threshold": high,
            "val": block(val_preds, val_truth, high),
            "test": block(test_preds, test_truth, high),
        },
    }
    out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    preds_out = out.parent / "test_preds_final.json"
    preds_out.write_text(
        json.dumps(
            {
                k: [{"box": [d.box.x1, d.box.y1, d.box.x2, d.box.y2], "conf": d.conf} for d in v]
                for k, v in test_preds.items()  # type: ignore[attr-defined]
            }
        ),
        encoding="utf-8",
    )
    print(json.dumps(payload, indent=2))


if __name__ == "__main__":
    raise SystemExit(main())
