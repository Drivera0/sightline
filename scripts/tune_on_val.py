"""Tune tiled-inference settings on the **validation** split only (docs/LANE_A_ML.md §6.3a).

    python scripts/tune_on_val.py [--weights data/runs/tiles_s_v2/weights/best.pt] \
        [--overlaps 0.1 0.2 0.3] [--out data/work/tune/val_tuning.json]

1. SAHI sliced inference on the annotated val photos, once per slice overlap, with no merge
   (``Detector.slice_predictions``); raw boxes are cached under ``data/work/tune/``.
2. Every merge setting (NMS / NMM / GREEDYNMM × IOU / IOS × match threshold) is applied
   offline with ``merge_slices``, the threshold is re-chosen by max F2, and val F2 / AP50
   are recorded.
3. The best setting is compared with the current default by a paired bootstrap over val
   images (2,000 resamples, seed 7). It is adopted only if the 95 % interval of ΔF2 is above
   zero; otherwise the current default stays.
4. Operating points for the adopted setting: the primary F2 threshold and the secondary
   high-recall threshold (rule fixed before looking at any result, see ``HIGH_RECALL_RULE``).

The test split is never read. Needs the GPU and the ``ml`` extra; about 2 minutes per overlap.
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

MERGES = ("NMS", "NMM", "GREEDYNMM")
METRICS = ("IOU", "IOS")
MATCH_THRESHOLDS = (0.3, 0.4, 0.5, 0.6, 0.7)
BASELINE = {"overlap": 0.2, "merge": "NMS", "metric": "IOU", "match": 0.5}
HIGH_RECALL_TARGET = 0.90
HIGH_RECALL_RULE = (
    "highest threshold whose VOC recall on annotated val photos is >= 0.90 "
    "(fixed before any result was seen: roughly nine in ten people surfaced, and a false "
    "alarm costs a reviewer a few seconds); if val never reaches 0.90, max F3 instead"
)
SAR_LOOSE_IOU = 0.1  # 'found the person': a loose box with IoU >= 0.1 still counts


def _key(cfg: dict[str, object]) -> str:
    return f"ov{cfg['overlap']}_{cfg['merge']}_{cfg['metric']}_{cfg['match']}"


def collect_raw(det: object, val: list, overlap: float, cache: Path) -> tuple[dict, float]:
    if cache.exists():
        data = json.loads(cache.read_text(encoding="utf-8"))
        return data["raw"], data["seconds_per_image"]
    raw: dict[str, object] = {}
    t0 = time.perf_counter()
    for im in val:
        boxes, w, h = det.slice_predictions(im.path, conf=0.05, overlap=overlap)  # type: ignore[attr-defined]
        raw[im.path.stem] = {"w": w, "h": h, "boxes": boxes}
    spi = (time.perf_counter() - t0) / max(1, len(val))
    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_text(json.dumps({"raw": raw, "seconds_per_image": spi}), encoding="utf-8")
    return raw, spi


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--weights", type=Path, default=ROOT / "data/runs/tiles_s_v2/weights/best.pt")
    ap.add_argument("--data-root", type=Path, default=ROOT / "data/heridal/yolo_full")
    ap.add_argument("--overlaps", type=float, nargs="+", default=[0.1, 0.2, 0.3])
    ap.add_argument("--work", type=Path, default=ROOT / "data/work/tune")
    ap.add_argument("--out", type=Path, default=ROOT / "data/work/tune/val_tuning.json")
    ap.add_argument("--resamples", type=int, default=2000)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args(argv)

    from sightline.ml.data import load_split
    from sightline.ml.detect import Detector, merge_slices
    from sightline.ml.evaluate import choose_threshold_from_preds, score_voc
    from sightline.ml.tuning import (
        paired_bootstrap_f2,
        scores_at,
        threshold_curve,
        threshold_for_recall,
    )

    val = load_split("val", args.data_root, annotated_only=True)
    truth = {im.path.stem: list(im.boxes) for im in val}
    print(f"val: {len(val)} annotated photos, {sum(len(b) for b in truth.values())} people")
    det = Detector(args.weights)

    rows: list[dict[str, object]] = []
    preds_by_key: dict[str, dict] = {}
    speed: dict[str, float] = {}
    for ov in args.overlaps:
        raw, spi = collect_raw(det, val, ov, args.work / f"raw_val_ov{ov}.json")
        speed[str(ov)] = spi
        print(f"overlap {ov}: {spi:.3f} s/photo (inference, no merge)")
        for merge in MERGES:
            for metric in METRICS:
                for match in MATCH_THRESHOLDS:
                    cfg = {"overlap": ov, "merge": merge, "metric": metric, "match": match}
                    t0 = time.perf_counter()
                    preds = {
                        k: merge_slices(
                            [tuple(b) for b in v["boxes"]], v["w"], v["h"], merge, metric, match
                        )
                        for k, v in raw.items()
                    }
                    merge_s = (time.perf_counter() - t0) / len(raw)
                    thr = choose_threshold_from_preds(preds, truth)
                    pt = scores_at(preds, truth, thr)
                    ap50 = score_voc(preds, truth, thr).ap50
                    row = {
                        **cfg,
                        "threshold": thr,
                        "precision": pt.precision,
                        "recall": pt.recall,
                        "f2": pt.f2,
                        "ap50": ap50,
                        "merge_seconds_per_image": merge_s,
                    }
                    rows.append(row)
                    preds_by_key[_key(cfg)] = preds
                    print(
                        f"  {_key(cfg):28s} thr={thr:.2f} P={pt.precision:.3f} "
                        f"R={pt.recall:.3f} F2={pt.f2:.4f} AP50={ap50:.3f}"
                    )

    base_key = _key(BASELINE)
    base = next(r for r in rows if _key(r) == base_key)
    # Best by val F2; ties to higher AP50, then to the baseline-like (lower overlap) setting.
    best = max(rows, key=lambda r: (round(r["f2"], 6), round(r["ap50"], 6), -r["overlap"]))  # type: ignore[arg-type,operator]
    best_key = _key(best)
    boot = paired_bootstrap_f2(
        preds_by_key[base_key],
        float(base["threshold"]),  # type: ignore[arg-type]
        preds_by_key[best_key],
        float(best["threshold"]),  # type: ignore[arg-type]
        truth,
        n_resamples=args.resamples,
        seed=args.seed,
    )
    adopted_key = best_key if (best_key != base_key and boot.clearly_better) else base_key
    adopted = next(r for r in rows if _key(r) == adopted_key)
    print(
        f"best {best_key} F2 {best['f2']:.4f} vs baseline {base_key} F2 {base['f2']:.4f}: "
        f"dF2 {boot.delta:+.4f}, 95% CI [{boot.ci_low:+.4f}, {boot.ci_high:+.4f}], "
        f"P(best>base) {boot.p_b_better:.3f} -> adopt {adopted_key}"
    )

    # Operating points for the adopted setting.
    preds = preds_by_key[adopted_key]
    primary_thr = float(adopted["threshold"])  # type: ignore[arg-type]
    curve = threshold_curve(preds, truth)
    reachable = any(s.recall >= HIGH_RECALL_TARGET for s in curve)
    if reachable:
        hr_thr = threshold_for_recall(preds, truth, HIGH_RECALL_TARGET)
        hr_how = f"recall >= {HIGH_RECALL_TARGET} on val"
    else:
        hr_thr = choose_threshold_from_preds(preds, truth, beta=3.0)
        hr_how = "max F3 on val (0.90 recall not reachable)"

    def point(thr: float) -> dict[str, float]:
        voc = scores_at(preds, truth, thr)
        loose = scores_at(preds, truth, thr, iou_threshold=SAR_LOOSE_IOU)
        return {
            "threshold": thr,
            "precision": voc.precision,
            "recall": voc.recall,
            "f2": voc.f2,
            "false_alarms": voc.n_pred - voc.tp,
            "recall_iou_0.1": loose.recall,
        }

    out = {
        "split": "val (annotated photos only)",
        "val_photos": len(val),
        "val_people": sum(len(b) for b in truth.values()),
        "weights": str(args.weights),
        "inference_seconds_per_image": speed,
        "baseline": base_key,
        "best": best_key,
        "bootstrap_best_vs_baseline": {
            "delta_f2": boot.delta,
            "ci95": [boot.ci_low, boot.ci_high],
            "p_best_better": boot.p_b_better,
            "resamples": boot.n_resamples,
            "seed": args.seed,
            "rule": "adopt only if the 95% interval of dF2 is above zero",
        },
        "adopted": adopted_key,
        "adopted_settings": {k: adopted[k] for k in ("overlap", "merge", "metric", "match")},
        "operating_points": {
            "primary": {"rule": "max F2 on val", **point(primary_thr)},
            "high_recall": {"rule": HIGH_RECALL_RULE, "applied": hr_how, **point(hr_thr)},
        },
        "rows": rows,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(out["operating_points"], indent=2))
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
