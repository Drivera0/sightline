"""Fair no-tiling baselines: whole photos at (near) full resolution, one pass, no slicing.

    python scripts/evaluate_no_tiling.py --row stock-fullres --row tuned-fullres \
        [--row whole-1600=data/runs/whole_s/weights/best.pt@1600] [--write-metrics]

The original "no tiling" ablation rows shrink a 4000x3000 photo to 1024 px, so a person who was
about 50 px tall becomes about 13 px, a scale the tile-trained weights never saw. These rows give
the model the photo at the scale it was trained on instead: one forward pass at ``imgsz`` 4000
(letterboxed to 4000x3008, the native size), no SAHI. A row trained on whole photos runs at its
own training size.

Same protocol as ``scripts/evaluate_model.py``: threshold chosen on the annotated **val** photos by
max F2 with the row's own inference, test scored once with VOC (IoU >= 0.5) and SAR-style
(IoU >= 0.0025) matching. Seconds per photo are wall time per test photo (decode + one pass +
NMS) on whatever GPU runs this; peak GPU memory is torch's peak reserved memory during the test
pass.

Writes ``data/work/detect/no_tiling_baselines.json`` (lane A's own file). With
``--write-metrics`` also adds the rows to ``detector_metrics.json``, keeping its ``detector`` block
and existing rows unchanged except for the honest rename of the shrunk-photo fine-tuned row.
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

RUN2 = ROOT / "data/runs/tiles_s_v2/weights/best.pt"
STOCK = ROOT / "data/weights/yolo11s.pt"
FULL_RES_PX = 4000  # long side of a HERIDAL photo: scale 1.0, the scale the tile model trained on

# Preset rows: key -> (ablation row name, weights, imgsz)
PRESETS: dict[str, tuple[str, Path, int]] = {
    "stock-fullres": ("Stock model, full-resolution photo", STOCK, FULL_RES_PX),
    "tuned-fullres": ("Fine-tuned on tiles, full-resolution photo", RUN2, FULL_RES_PX),
}
WHOLE_ROW_NAME = "Trained and run on whole photos"  # = ABLATION_NAMES[4]


def parse_row(spec: str) -> tuple[str, Path, int]:
    """A preset key, or ``key=weights@imgsz`` for a whole-photo-trained model."""
    if spec in PRESETS:
        return PRESETS[spec]
    _, rest = spec.split("=", 1)
    weights, imgsz = rest.rsplit("@", 1)
    return WHOLE_ROW_NAME, Path(weights), int(imgsz)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--row", action="append", required=True, help="preset key or key=w.pt@imgsz")
    ap.add_argument("--data-root", type=Path, default=ROOT / "data/heridal/yolo_full")
    ap.add_argument("--out-dir", type=Path, default=ROOT / "data/work/detect")
    ap.add_argument("--write-metrics", action="store_true")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--limit", type=int, default=None, help="debug: first N images per split")
    args = ap.parse_args(argv)

    import torch

    from sightline.ml.data import load_split
    from sightline.ml.detect import Detector
    from sightline.ml.evaluate import (
        choose_threshold_from_preds,
        predict_split,
        score_sar,
        score_voc,
    )
    from sightline.ml.tuning import scores_at

    val = load_split("val", args.data_root, annotated_only=True)[: args.limit]
    test = load_split("test", args.data_root)[: args.limit]
    print(f"val {len(val)} images, test {len(test)} images")

    out_json = args.out_dir / "no_tiling_baselines.json"
    results: dict[str, dict[str, object]] = (
        json.loads(out_json.read_text(encoding="utf-8")) if out_json.exists() else {}
    )
    for spec in args.row:
        name, weights, imgsz = parse_row(spec)
        det = Detector(weights, device=args.device, imgsz=imgsz)
        t0 = time.time()
        val_preds, val_truth, val_spi = predict_split(det, val, "resized")
        thr = choose_threshold_from_preds(val_preds, val_truth)  # val only
        torch.cuda.reset_peak_memory_stats()
        test_preds, test_truth, spi = predict_split(det, test, "resized")
        peak_gb = torch.cuda.max_memory_reserved() / 2**30 if torch.cuda.is_available() else 0.0
        voc, sar = score_voc(test_preds, test_truth, thr), score_sar(test_preds, test_truth, thr)
        val_pt = scores_at(val_preds, val_truth, thr)
        results[name] = {
            "weights": str(weights.relative_to(ROOT) if weights.is_relative_to(ROOT) else weights),
            "imgsz": imgsz,
            "inference": "whole photo, one pass, letterboxed to imgsz, no slicing",
            "threshold": thr,
            "val": {"precision": val_pt.precision, "recall": val_pt.recall, "f2": val_pt.f2},
            "voc": voc.model_dump(),
            "sar": sar.model_dump(),
            "f2": scores_at(test_preds, test_truth, thr).f2,
            "seconds_per_image": spi,
            "val_seconds_per_image": val_spi,
            "peak_gpu_memory_gb": peak_gb,
            "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu",
        }
        print(
            f"[{name}] imgsz={imgsz} thr={thr:.2f} val F2={val_pt.f2:.3f} | test "
            f"P={voc.precision:.3f} R={voc.recall:.3f} AP50={voc.ap50:.3f} "
            f"SAR P={sar.precision:.3f} R={sar.recall:.3f} {spi:.2f}s/img "
            f"peak {peak_gb:.1f} GB ({time.time() - t0:.0f}s)"
        )
        del det
        torch.cuda.empty_cache()
        if args.limit is None:
            out_json.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")

    if args.write_metrics and args.limit is None:
        update_metrics(args.out_dir / "detector_metrics.json", results)
    return 0


def update_metrics(path: Path, results: dict[str, dict[str, object]]) -> None:
    """Add the measured rows to ``detector_metrics.json``; the detector block is not touched."""
    from sightline.ml.evaluate import (
        ABLATION_NAMES,
        LEGACY_ABLATION_RENAMES,
        Ablation,
        DetectorMetrics,
        VocScores,
        write_detector_metrics,
    )

    data = json.loads(path.read_text(encoding="utf-8"))
    rows = {
        LEGACY_ABLATION_RENAMES.get(r["name"], r["name"]): VocScores(**r["voc"])
        for r in data["ablations"]
    }
    for name, res in results.items():
        rows[name] = VocScores(**res["voc"])  # type: ignore[arg-type]
    ablations = [Ablation(name=n, voc=rows[n]) for n in ABLATION_NAMES if n in rows]
    write_detector_metrics(DetectorMetrics(**data["detector"]), ablations, path)
    print(f"wrote {path}: {[a.name for a in ablations]}")


if __name__ == "__main__":
    raise SystemExit(main())
