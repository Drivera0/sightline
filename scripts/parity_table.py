"""Parity table: the OpenCV 5 cv2.dnn detector vs the Torch (Ultralytics + SAHI) one (A-X3).

    uv run --extra ml python scripts/parity_table.py \
        [--pt data/weights/release_v2/yolo11s_tiles_run1_best.pt] [--onnx <pt>.onnx] \
        [--splits val test] [--threshold 0.29] [--demo-frames cache/sample/frames]

Both backends run tiled inference (the pipeline's ``detect_tiled``) on the same photos and are
scored with the same code as ``evaluate_model.py`` at the **frozen** threshold (0.29, chosen on
val in sprint 1). Nothing is tuned: this only checks that the two backends give the same answer.
Test is read for that check alone, once; the scores must match the published Torch numbers.

Box agreement: per photo, boxes are matched one-to-one (highest IoU first) between backends;
reported as the share matched at IoU >= 0.95 and the largest confidence difference on a match,
for all saved boxes (conf >= 0.05) and for boxes at or above the threshold.

Writes ``runs/parity/<timestamp>.json`` and prints a Markdown table for scripts/README.md.
Needs the ``ml`` extra; Torch uses the GPU if there is one, cv2.dnn always runs on the CPU.
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

from sightline.ml.detect_cv import iou
from sightline.ml.types import RawDetection

AGREE_IOU = 0.95


def _xyxy(d: RawDetection) -> tuple[float, float, float, float]:
    return (d.box.x1, d.box.y1, d.box.x2, d.box.y2)


def match(a: list[RawDetection], b: list[RawDetection]) -> list[tuple[float, float]]:
    """One-to-one greedy matching, highest IoU first; returns (iou, |conf diff|) per pair."""
    pairs = sorted(
        ((iou(_xyxy(x), _xyxy(y)), i, j) for i, x in enumerate(a) for j, y in enumerate(b)),
        reverse=True,
    )
    used_a: set[int] = set()
    used_b: set[int] = set()
    out = []
    for v, i, j in pairs:
        if v <= 0:
            break
        if i in used_a or j in used_b:
            continue
        used_a.add(i)
        used_b.add(j)
        out.append((v, abs(a[i].conf - b[j].conf)))
    return out


def agreement(
    torch_preds: dict[str, list[RawDetection]],
    cv_preds: dict[str, list[RawDetection]],
    min_conf: float,
) -> dict[str, float | int]:
    n_torch = n_cv = n_agree = 0
    max_diff = 0.0
    for img, dets in torch_preds.items():
        a = [d for d in dets if d.conf >= min_conf]
        b = [d for d in cv_preds[img] if d.conf >= min_conf]
        n_torch, n_cv = n_torch + len(a), n_cv + len(b)
        for v, diff in match(a, b):
            if v >= AGREE_IOU:
                n_agree += 1
                max_diff = max(max_diff, diff)
    return {
        "boxes_torch": n_torch,
        "boxes_cv2": n_cv,
        "matched_iou_095": n_agree,
        "share_of_torch": n_agree / n_torch if n_torch else 1.0,
        "share_of_cv2": n_agree / n_cv if n_cv else 1.0,
        "max_conf_diff": max_diff,
    }


def seconds_per_frame(detector: object, frames: list[Path]) -> float:
    t0 = time.perf_counter()
    for f in frames:
        detector.detect_tiled(f, conf=0.05)  # type: ignore[attr-defined]
    return (time.perf_counter() - t0) / max(1, len(frames))


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--pt", type=Path, default=ROOT / "data/weights/release_v2/yolo11s_tiles_run1_best.pt"
    )
    ap.add_argument("--onnx", type=Path, default=None, help="default: --pt with .onnx")
    ap.add_argument("--splits", nargs="+", default=["val", "test"], choices=["val", "test"])
    ap.add_argument("--threshold", type=float, default=0.29, help="frozen; never re-chosen here")
    ap.add_argument("--data-root", type=Path, default=ROOT / "data/heridal/yolo_full")
    ap.add_argument("--demo-frames", type=Path, default=ROOT / "cache/sample/frames")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--limit", type=int, default=None, help="debug: first N photos per split")
    ap.add_argument("--out", type=Path, default=ROOT / "runs/parity")
    args = ap.parse_args(argv)

    from sightline.ml.data import load_split
    from sightline.ml.detect import Detector, resolve_device
    from sightline.ml.detect_cv import CvDetector
    from sightline.ml.evaluate import predict_split, score_sar, score_voc

    onnx = args.onnx or args.pt.with_suffix(".onnx")
    torch_det = Detector(args.pt, device=args.device)
    cv_det = CvDetector(onnx)
    device = resolve_device(args.device)
    thr = args.threshold

    result: dict[str, object] = {
        "pt": str(args.pt.relative_to(ROOT) if args.pt.is_relative_to(ROOT) else args.pt),
        "onnx": str(onnx.relative_to(ROOT) if onnx.is_relative_to(ROOT) else onnx),
        "threshold": thr,
        "torch_device": device,
        "cv2_device": "cpu",
        "splits": {},
    }
    for split in args.splits:
        # Same photo sets as evaluate_model.py: annotated val photos, the full test split.
        images = load_split(split, args.data_root, annotated_only=split == "val")[: args.limit]
        print(f"[{split}] {len(images)} photos", flush=True)
        per_backend = {}
        preds = {}
        for name, det in (("torch", torch_det), ("cv2", cv_det)):
            p, truth, spi = predict_split(det, images, "tiled")
            preds[name] = p
            voc, sar = score_voc(p, truth, thr), score_sar(p, truth, thr)
            per_backend[name] = {
                "voc": voc.model_dump(),
                "sar": sar.model_dump(),
                "seconds_per_photo": spi,
            }
            print(
                f"  {name:5s} VOC P={voc.precision:.3f} R={voc.recall:.3f} AP50={voc.ap50:.3f} "
                f"SAR P={sar.precision:.3f} R={sar.recall:.3f} {spi:.2f} s/photo",
                flush=True,
            )
        per_backend["agreement_all"] = agreement(preds["torch"], preds["cv2"], 0.05)
        per_backend["agreement_at_threshold"] = agreement(preds["torch"], preds["cv2"], thr)
        result["splits"][split] = per_backend  # type: ignore[index]

    frames = sorted(args.demo_frames.glob("*.jpg"))[: args.limit]
    if frames:
        result["demo_frames"] = {
            "n": len(frames),
            "torch_seconds_per_frame": seconds_per_frame(torch_det, frames),
            "cv2_seconds_per_frame": seconds_per_frame(cv_det, frames),
        }

    args.out.mkdir(parents=True, exist_ok=True)
    out = args.out / f"{time.strftime('%Y%m%d-%H%M%S')}.json"
    out.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"\nwrote {out}\n")
    print(markdown(result))
    return 0


def markdown(r: dict) -> str:
    lines = [
        f"Threshold {r['threshold']} (frozen). Torch on {r['torch_device']}, cv2.dnn on the CPU.",
        "",
        "| Split | Backend | VOC P / R / AP50 | SAR P / R | s per photo |",
        "|---|---|---|---|---|",
    ]
    for split, s in r["splits"].items():
        for name in ("torch", "cv2"):
            b = s[name]
            v, sr = b["voc"], b["sar"]
            lines.append(
                f"| {split} | {name} | {v['precision']:.3f} / {v['recall']:.3f} / {v['ap50']:.3f} "
                f"| {sr['precision']:.3f} / {sr['recall']:.3f} | {b['seconds_per_photo']:.2f} |"
            )
    lines += [
        "",
        "| Split | Boxes | Torch / cv2 | Matched at IoU ≥ 0.95 | Max conf diff |",
        "|---|---|---|---|---|",
    ]
    for split, s in r["splits"].items():
        for key, label in (("agreement_all", "all (≥ 0.05)"), ("agreement_at_threshold", "≥ thr")):
            a = s[key]
            lines.append(
                f"| {split} | {label} | {a['boxes_torch']} / {a['boxes_cv2']} "
                f"| {a['share_of_torch']:.1%} of torch, {a['share_of_cv2']:.1%} of cv2 "
                f"| {a['max_conf_diff']:.4f} |"
            )
    if "demo_frames" in r:
        d = r["demo_frames"]
        lines += [
            "",
            (
                f"Demo frames (1000×750, n={d['n']}): torch {d['torch_seconds_per_frame']:.3f} s, "
                f"cv2 {d['cv2_seconds_per_frame']:.3f} s per frame."
            ),
        ]
    return "\n".join(lines)


if __name__ == "__main__":
    raise SystemExit(main())
