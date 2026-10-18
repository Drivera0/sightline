"""Test-time augmentation (flips + 90° rotations) for tiled inference, measured on **val** only.

    python scripts/tta_on_val.py [--weights data/runs/tiles_s_v2/weights/best.pt] \
        [--out data/work/tune/val_tta.json]

Each annotated val photo is run through the normal tiled detector (default merge settings) in
all 8 dihedral views; boxes are mapped back and cached under ``data/work/tune/``. View sets
(1 = no TTA, 2, 4, 8 views) are fused with pooled NMS (IoU 0.5) or weighted box fusion
(IoU 0.55), the threshold is re-chosen by max F2, and each is compared with no TTA by a paired
bootstrap over val photos (2,000 resamples, seed 7).

Decision rule: among settings under 2 s per photo, take the best val F2; adopt it only if the
95 % interval of ΔF2 against no TTA is above zero; otherwise keep single-view inference.
The test split is never read.
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

VIEW_SETS = {
    "1 (no TTA)": ["id"],
    "2 (id, hflip)": ["id", "hflip"],
    "4 (id, hflip, vflip, rot90)": ["id", "hflip", "vflip", "rot90"],
    "8 (all flips and rotations)": [
        "id",
        "hflip",
        "rot90",
        "rot180",
        "rot270",
        "vflip",
        "transpose",
        "antitranspose",
    ],
}
MAX_SECONDS_PER_IMAGE = 2.0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--weights", type=Path, default=ROOT / "data/runs/tiles_s_v2/weights/best.pt")
    ap.add_argument("--data-root", type=Path, default=ROOT / "data/heridal/yolo_full")
    ap.add_argument("--cache", type=Path, default=ROOT / "data/work/tune/raw_val_tta.json")
    ap.add_argument("--out", type=Path, default=ROOT / "data/work/tune/val_tta.json")
    ap.add_argument("--resamples", type=int, default=2000)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args(argv)

    import numpy as np
    from PIL import Image

    from sightline.ml.data import load_split
    from sightline.ml.detect import Detector, merge_slices
    from sightline.ml.evaluate import choose_threshold_from_preds, score_voc
    from sightline.ml.tta import TRANSFORMS, boxes_back, to_float_boxes, transform_image
    from sightline.ml.tta import weighted_box_fusion as wbf
    from sightline.ml.tuning import paired_bootstrap_f2, scores_at
    from sightline.ml.types import Box, RawDetection

    val = load_split("val", args.data_root, annotated_only=True)
    truth = {im.path.stem: list(im.boxes) for im in val}

    if args.cache.exists():
        cache = json.loads(args.cache.read_text(encoding="utf-8"))
    else:
        det = Detector(args.weights)
        views: dict[str, dict[str, list]] = {}
        view_seconds = dict.fromkeys(TRANSFORMS, 0.0)
        decode_seconds = 0.0
        sizes: dict[str, list[int]] = {}
        det.slice_predictions(val[0].path)  # warm-up, not timed
        for im in val:
            t0 = time.perf_counter()
            with Image.open(im.path) as src:
                pixels = np.asarray(src.convert("RGB"))
            decode_seconds += time.perf_counter() - t0
            h, w = pixels.shape[:2]
            sizes[im.path.stem] = [w, h]
            for name in TRANSFORMS:
                t0 = time.perf_counter()
                raw, vw, vh = det.slice_predictions(transform_image(pixels, name))
                merged = merge_slices(raw, vw, vh)
                back = boxes_back(to_float_boxes(merged), name, w, h)
                view_seconds[name] += time.perf_counter() - t0
                views.setdefault(name, {})[im.path.stem] = back
        n = len(val)
        cache = {
            "views": views,
            "sizes": sizes,
            "view_seconds_per_image": {k: v / n for k, v in view_seconds.items()},
            "decode_seconds_per_image": decode_seconds / n,
        }
        args.cache.parent.mkdir(parents=True, exist_ok=True)
        args.cache.write_text(json.dumps(cache), encoding="utf-8")

    sizes = cache["sizes"]

    def to_dets(boxes: list, w: int, h: int) -> list[RawDetection]:
        out = []
        for x1, y1, x2, y2, c in boxes:
            ix1, iy1, ix2, iy2 = (
                max(0, round(x1)),
                max(0, round(y1)),
                min(w, round(x2)),
                min(h, round(y2)),
            )
            if ix2 > ix1 and iy2 > iy1:
                out.append(RawDetection(Box(ix1, iy1, ix2, iy2), float(c)))
        return sorted(out, key=lambda d: -d.conf)

    rows = []
    preds_by: dict[str, dict] = {}
    for set_name, names in VIEW_SETS.items():
        fusions = ["none"] if len(names) == 1 else ["nms", "wbf"]
        for fusion in fusions:
            t0 = time.perf_counter()
            preds = {}
            for img in truth:
                w, h = sizes[img]
                per_view = [cache["views"][n][img] for n in names]
                if fusion == "none":
                    fused = per_view[0]
                    preds[img] = to_dets(fused, w, h)
                elif fusion == "nms":
                    preds[img] = merge_slices([tuple(b) for v in per_view for b in v], w, h)
                else:
                    preds[img] = to_dets(wbf(per_view), w, h)
            fuse_s = (time.perf_counter() - t0) / len(truth)
            spi = (
                cache["decode_seconds_per_image"]
                + sum(cache["view_seconds_per_image"][n] for n in names)
                + fuse_s
            )
            thr = choose_threshold_from_preds(preds, truth)
            pt = scores_at(preds, truth, thr)
            row = {
                "views": set_name,
                "fusion": fusion,
                "threshold": thr,
                "precision": pt.precision,
                "recall": pt.recall,
                "f2": pt.f2,
                "ap50": score_voc(preds, truth, thr).ap50,
                "seconds_per_image": spi,
            }
            key = f"{set_name} / {fusion}"
            preds_by[key] = preds
            rows.append(row)

    base_key = "1 (no TTA) / none"
    base = rows[0]
    for row in rows[1:]:
        key = f"{row['views']} / {row['fusion']}"
        b = paired_bootstrap_f2(
            preds_by[base_key],
            base["threshold"],
            preds_by[key],
            row["threshold"],
            truth,
            n_resamples=args.resamples,
            seed=args.seed,
        )
        row["bootstrap_vs_no_tta"] = {
            "delta_f2": b.delta,
            "ci95": [b.ci_low, b.ci_high],
            "p_better": b.p_b_better,
        }
        row["clearly_better"] = b.clearly_better
    for row in rows:
        print(
            f"{row['views']:30s} {row['fusion']:5s} thr={row['threshold']:.2f} "
            f"P={row['precision']:.3f} R={row['recall']:.3f} F2={row['f2']:.4f} "
            f"AP50={row['ap50']:.3f} {row['seconds_per_image']:.2f}s/img "
            + (
                f"dF2 {row['bootstrap_vs_no_tta']['delta_f2']:+.4f} CI "
                f"[{row['bootstrap_vs_no_tta']['ci95'][0]:+.4f}, "
                f"{row['bootstrap_vs_no_tta']['ci95'][1]:+.4f}]"
                if "bootstrap_vs_no_tta" in row
                else ""
            )
        )
    # The speed limit is part of the rule, so the best is taken among settings under it. (The
    # first version of this script took the best F2 overall, 8 views / WBF at 2.4 s per photo,
    # and so rejected TTA on speed alone; see docs/LANE_A_ML.md §6.3a.)
    fast = [r for r in rows if r["seconds_per_image"] < MAX_SECONDS_PER_IMAGE]
    best = max(fast, key=lambda r: r["f2"])
    adopt = best is not base and best.get("clearly_better", False)
    decision = (
        f"adopt {best['views']} / {best['fusion']}" if adopt else "keep single-view inference"
    )
    print(f"best by val F2: {best['views']} / {best['fusion']} -> {decision}")
    out = {
        "split": "val (annotated photos only)",
        "val_photos": len(truth),
        "rule": f"among settings under {MAX_SECONDS_PER_IMAGE} s per photo, the best val F2; "
        "adopt only if the 95% interval of dF2 vs no TTA is above zero",
        "decision": decision,
        "view_seconds_per_image": cache["view_seconds_per_image"],
        "decode_seconds_per_image": cache["decode_seconds_per_image"],
        "rows": rows,
    }
    args.out.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
