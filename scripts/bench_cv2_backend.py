"""Time the cv2.dnn detector on one backend over the test split, and compare two runs box by box.

    # a CUDA build of OpenCV first on the path (docs/report/CV2_CUDA.md):
    PYTHONPATH=<cv2-cuda site-packages> uv run python scripts/bench_cv2_backend.py \
        --backend cuda-fp16 --runs 3 --out runs/cv2_cuda/cuda-fp16.json
    uv run python scripts/bench_cv2_backend.py --backend cpu --runs 3 --out runs/cv2_cuda/cpu.json
    uv run python scripts/bench_cv2_backend.py --compare runs/cv2_cuda/cpu.json \
        runs/cv2_cuda/cuda-fp16.json

Each run is the loop ``evaluate_model.py`` times (``predict_split``: one photo after another,
``detect_tiled`` at the save threshold 0.05, reading included), so its seconds per photo stand
next to Torch's ``seconds_per_image`` in ``detector_metrics.json``. The network's own time
(``blobFromImage`` + ``setInput`` + ``forward``) is also summed per 1024 px slice. One warm-up
photo runs first (CUDA initialisation and cuDNN autotuning are not counted).

The boxes of the first run are saved and scored at the **frozen** threshold 0.29 with the same
code as ``evaluate_model.py``. Test is only re-scored with the existing model; nothing is tuned.
``--compare`` matches two saved runs one-to-one per photo (``parity_table.agreement``).
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for p in (ROOT, ROOT / "scripts"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

THRESHOLD = 0.29  # frozen on val in sprint 1


def _rows(preds: dict) -> dict[str, list[list[float]]]:
    return {
        k: [[d.box.x1, d.box.y1, d.box.x2, d.box.y2, d.conf] for d in v] for k, v in preds.items()
    }


def _preds(rows: dict[str, list[list[float]]]) -> dict:
    from sightline.ml.types import Box, RawDetection

    return {
        k: [RawDetection(Box(*(int(c) for c in r[:4])), r[4]) for r in v] for k, v in rows.items()
    }


def bench(args: argparse.Namespace) -> int:
    import cv2

    from sightline.ml.data import load_split
    from sightline.ml.detect_cv import CvDetector
    from sightline.ml.evaluate import predict_split, score_sar, score_voc

    images = load_split("test", args.data_root)[: args.limit]
    det = CvDetector(args.onnx, backend=args.backend)
    forward = det._forward
    spent: list[float] = []

    def timed(canvas):  # the network's share of each slice
        t0 = time.perf_counter()
        out = forward(canvas)
        spent.append(time.perf_counter() - t0)
        return out

    det._forward = timed  # type: ignore[method-assign]
    det.detect_tiled(images[0].path)  # warm-up: CUDA context, cuDNN algorithm choice
    runs = []
    first = None
    for i in range(args.runs):
        spent.clear()
        preds, truth, spp = predict_split(det, images, "tiled")
        runs.append(
            {
                "seconds_per_photo": spp,
                "ms_per_slice_forward": 1000 * statistics.fmean(spent),
                "ms_per_slice_end_to_end": 1000 * spp * len(images) / len(spent),
                "slices": len(spent),
            }
        )
        print(
            f"run {i + 1}: {spp:.3f} s/photo, {runs[-1]['ms_per_slice_forward']:.1f} ms/slice "
            f"forward ({len(spent)} slices)",
            flush=True,
        )
        if first is None:
            first = (preds, truth)
    assert first is not None
    preds, truth = first
    voc, sar = score_voc(preds, truth, THRESHOLD), score_sar(preds, truth, THRESHOLD)
    print(f"VOC P={voc.precision:.3f} R={voc.recall:.3f} AP50={voc.ap50:.3f} at {THRESHOLD}")

    def mean_sd(key: str) -> list[float]:
        xs = [r[key] for r in runs]
        return [statistics.fmean(xs), statistics.stdev(xs) if len(xs) > 1 else 0.0]

    out = {
        "backend": det.backend,
        "opencv": cv2.__version__,
        "cuda_devices": cv2.cuda.getCudaEnabledDeviceCount() if hasattr(cv2, "cuda") else 0,
        "threads": det.threads,
        "onnx": args.onnx.name,
        "photos": len(images),
        "threshold": THRESHOLD,
        "voc": voc.model_dump(),
        "sar": sar.model_dump(),
        "runs": runs,
        "seconds_per_photo": mean_sd("seconds_per_photo"),
        "ms_per_slice_forward": mean_sd("ms_per_slice_forward"),
        "boxes": _rows(preds),
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out), encoding="utf-8")
    s, f = out["seconds_per_photo"], out["ms_per_slice_forward"]
    print(f"{det.backend}: {s[0]:.3f} ± {s[1]:.3f} s/photo, {f[0]:.1f} ± {f[1]:.1f} ms/slice")
    print(f"wrote {args.out}")
    return 0


def compare(a_path: Path, b_path: Path) -> int:
    from parity_table import agreement

    a, b = (json.loads(p.read_text(encoding="utf-8")) for p in (a_path, b_path))
    pa, pb = _preds(a["boxes"]), _preds(b["boxes"])
    print(f"{a['backend']} vs {b['backend']}")
    for key in ("precision", "recall", "ap50"):
        print(f"  VOC {key}: {a['voc'][key]:.3f} vs {b['voc'][key]:.3f}")
    for label, conf in (("all (>= 0.05)", 0.05), (f">= {THRESHOLD}", THRESHOLD)):
        r = agreement(pa, pb, conf)
        print(
            f"  {label}: {r['boxes_torch']} / {r['boxes_cv2']} boxes, "
            f"{r['matched_iou_095']} matched at IoU >= 0.95, max conf diff {r['max_conf_diff']:.4f}"
        )
    same = sum(
        sorted(map(tuple, a["boxes"][k])) == sorted(map(tuple, b["boxes"][k])) for k in a["boxes"]
    )
    print(f"  photos with identical boxes and confidences: {same} / {len(a['boxes'])}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--onnx", type=Path, default=ROOT / "data/weights/release_v2/yolo11s_tiles_run1_best.onnx"
    )
    ap.add_argument("--backend", choices=("cpu", "cuda", "cuda-fp16"), default=None)
    ap.add_argument("--data-root", type=Path, default=ROOT / "data/heridal/yolo_full")
    ap.add_argument("--runs", type=int, default=3)
    ap.add_argument("--limit", type=int, default=None, help="debug: first N photos")
    ap.add_argument("--out", type=Path, default=ROOT / "runs/cv2_cuda/bench.json")
    ap.add_argument("--compare", nargs=2, type=Path, metavar=("A", "B"))
    args = ap.parse_args(argv)
    return compare(*args.compare) if args.compare else bench(args)


if __name__ == "__main__":
    raise SystemExit(main())
