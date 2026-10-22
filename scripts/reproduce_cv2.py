"""Reproduce the published detector numbers with OpenCV 5 ``cv2.dnn`` only, on the CPU.

    uv sync
    gh release download data-v1       -R Drivera0/sightline -p heridal_test_split.zip
    gh release download weights-v2    -R Drivera0/sightline -D data/weights/release_v2
    gh release download model-onnx-v2 -R Drivera0/sightline -D data/weights/release_v2 \
        -p sightline-detector-v2.onnx
    unzip -q heridal_test_split.zip -d data/heridal/yolo_full
    CUDA_VISIBLE_DEVICES= uv run python scripts/reproduce_cv2.py \
        [--onnx data/weights/release_v2/sightline-detector-v2.onnx] \
        [--expected data/weights/release_v2/detector_metrics.json] [--workers N] [--threads T]

The judge path: no torch, ultralytics or sahi, no GPU. The 101 test photos run through
``CvDetector.detect_tiled`` (1024 px SAHI slices, 0.2 overlap, merge NMS at IoU 0.5), are scored
with the same VOC code as ``evaluate_model.py`` at the **frozen** threshold 0.29 (chosen on val in
sprint 1), and compared with ``detector_metrics.json``. Nothing is tuned: test is only read to
check the published numbers. ``parity_table.py`` does the same and also runs Torch, so it takes
about three times as long.

Exit code 0 when precision, recall and AP50 are each within ``--tolerance`` (0.005, about one
person of the 337) of the published values, 1 when one is not, 2 when an input is missing.

Speed: photos are independent until scoring, so they run in a pool of ``--workers`` processes,
each with its own network and ``cv2.setNumThreads(--threads)``; by default 4 workers (fewer on
small machines) share the cores. On a busy 32-thread Ryzen 9 9950X, 2 to 16 workers were within
15 % of each other and about 30 % faster than one process with every thread. The scorer then
sees every photo's boxes at once, as in ``evaluate_model.py``. Measured there on 2026-10-22,
GPU hidden, another job using about 11 cores: 4 min 58 s for the 101 photos, all three scores
equal to the published ones.

``--backend cuda`` / ``cuda-fp16`` (or ``SIGHTLINE_CV_BACKEND``) runs the same check on the GPU
through the classic engine; it needs OpenCV built with CUDA, not the pip wheel
(docs/report/CV2_CUDA.md). The default stays the CPU.

``--subset N`` scores a fixed seeded sample of N test photos: a smoke check of the setup, not
the headline number, so it is not compared with the published values.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import random
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from multiprocessing import get_context
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

THRESHOLD = 0.29  # frozen on val in sprint 1; never re-chosen here
TOLERANCE = 0.005
SUBSET_SEED = 7
DEFAULT_WORKERS = 4  # processes; each gets cores / workers cv2 threads

Row = tuple[int, int, int, int, float]

_detector = None  # one CvDetector per pool process


def _init_worker(onnx: str, threads: int, backend: str | None = None) -> None:
    global _detector
    from sightline.ml.detect_cv import CvDetector

    _detector = CvDetector(Path(onnx), threads=threads, backend=backend)


def _detect(path: str) -> list[Row]:
    """Tiled detection on one photo at the save threshold (0.05), as plain tuples for the pool."""
    assert _detector is not None
    dets = _detector.detect_tiled(Path(path))
    return [(d.box.x1, d.box.y1, d.box.x2, d.box.y2, d.conf) for d in dets]


def default_workers(cpus: int) -> int:
    return max(1, min(DEFAULT_WORKERS, cpus // 2))


def predict(
    paths: list[Path], onnx: Path, workers: int, threads: int, backend: str | None = None
) -> list[list[Row]]:
    """Boxes per photo, in the order of ``paths``. ``workers=1`` runs in this process."""
    if workers <= 1:
        _init_worker(str(onnx), threads, backend)
        return [_detect(str(p)) for p in paths]
    # spawn, not fork: a forked OpenCV thread pool can hang, and macOS has no fork default.
    with ProcessPoolExecutor(
        max_workers=workers,
        mp_context=get_context("spawn"),
        initializer=_init_worker,
        initargs=(str(onnx), threads, backend),
    ) as pool:
        return list(pool.map(_detect, [str(p) for p in paths]))


def machine_spec() -> dict[str, object]:
    import cv2

    cpu = platform.processor() or platform.machine()
    try:
        for line in Path("/proc/cpuinfo").read_text(encoding="utf-8").splitlines():
            if line.startswith("model name"):
                cpu = line.split(":", 1)[1].strip()
                break
    except OSError:
        pass
    try:
        ram_gb = round(os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES") / 2**30, 1)
    except (ValueError, OSError, AttributeError):
        ram_gb = None
    return {
        "cpu": cpu,
        "logical_cpus": os.cpu_count(),
        "ram_gb": ram_gb,
        "os": platform.platform(),
        "python": platform.python_version(),
        "opencv": cv2.__version__,
        "cuda_visible_devices": os.environ.get("CUDA_VISIBLE_DEVICES"),
    }


def compare(got: dict[str, float], want: dict[str, float], tol: float) -> list[tuple[str, bool]]:
    """``(line, ok)`` per score, the line like ``recall 0.864 vs 0.864 (ok)``."""
    out = []
    for key in ("precision", "recall", "ap50"):
        ok = abs(got[key] - want[key]) <= tol
        out.append(
            (f"{key:9s} {got[key]:.3f} vs {want[key]:.3f} ({'ok' if ok else 'MISMATCH'})", ok)
        )
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--onnx", type=Path, default=ROOT / "data/weights/release_v2/sightline-detector-v2.onnx"
    )
    ap.add_argument("--data-root", type=Path, default=ROOT / "data/heridal/yolo_full")
    ap.add_argument(
        "--expected", type=Path, default=ROOT / "data/weights/release_v2/detector_metrics.json"
    )
    ap.add_argument("--tolerance", type=float, default=TOLERANCE)
    ap.add_argument(
        "--backend",
        choices=("cpu", "cuda", "cuda-fp16"),
        default=None,
        help="cv2.dnn backend (default: SIGHTLINE_CV_BACKEND, else cpu); cuda needs a CUDA build "
        "of OpenCV (docs/report/CV2_CUDA.md) and runs in one process",
    )
    ap.add_argument("--workers", type=int, default=None, help="processes (default: 4)")
    ap.add_argument(
        "--threads", type=int, default=None, help="cv2 threads per process (default: cores/workers)"
    )
    ap.add_argument(
        "--subset",
        type=int,
        default=None,
        help=f"smoke check: N test photos drawn with seed {SUBSET_SEED}; not compared",
    )
    args = ap.parse_args(argv)

    t0 = time.perf_counter()
    from sightline.ml.data import load_split
    from sightline.ml.detect_cv import MERGE_NMS_IOU
    from sightline.ml.evaluate import score_sar, score_voc
    from sightline.ml.types import Box, RawDetection

    for path, hint in (
        (args.onnx, "gh release download model-onnx-v2"),
        (args.expected, "gh release download weights-v2"),
    ):
        if not path.exists():
            print(f"missing {path} ({hint})", file=sys.stderr)
            return 2
    try:
        images = load_split("test", args.data_root)  # the full test split, as evaluate_model.py
    except FileNotFoundError as e:
        print(f"{e} (gh release download data-v1 -p heridal_test_split.zip)", file=sys.stderr)
        return 2
    expected = json.loads(args.expected.read_text(encoding="utf-8"))["detector"]
    if abs(expected.get("threshold", THRESHOLD) - THRESHOLD) > 1e-9:
        print(f"{args.expected} has threshold {expected['threshold']}, not {THRESHOLD}")
        return 1
    if args.subset is not None:
        picked = random.Random(SUBSET_SEED).sample(images, min(args.subset, len(images)))
        images = sorted(picked, key=lambda im: im.path.name)

    from sightline.ml.detect_cv import resolve_cv_backend

    backend = resolve_cv_backend(args.backend)
    cpus = os.cpu_count() or 1
    workers = args.workers or (1 if backend != "cpu" else default_workers(cpus))
    threads = args.threads or max(1, cpus // workers)
    spec = machine_spec()
    print(
        f"machine: {spec['cpu']}, {spec['logical_cpus']} logical CPUs, {spec['ram_gb']} GB RAM, "
        f"{spec['os']}, Python {spec['python']}, OpenCV {spec['opencv']}, "
        f"CUDA_VISIBLE_DEVICES={spec['cuda_visible_devices']!r}"
    )
    where = "the CPU" if backend == "cpu" else f"CUDA ({backend}, ENGINE_CLASSIC)"
    print(
        f"cv2.dnn on {where}: {args.onnx.name}, {len(images)} test photos, "
        f"{workers} workers x {threads} threads, threshold {THRESHOLD}, merge NMS {MERGE_NMS_IOU}",
        flush=True,
    )

    t_detect = time.perf_counter()
    rows = predict([im.path for im in images], args.onnx, workers, threads, backend)
    detect_s = time.perf_counter() - t_detect
    preds = {
        im.path.stem: [RawDetection(Box(*r[:4]), r[4]) for r in rs]
        for im, rs in zip(images, rows, strict=True)
    }
    truth = {im.path.stem: list(im.boxes) for im in images}
    voc, sar = score_voc(preds, truth, THRESHOLD), score_sar(preds, truth, THRESHOLD)
    wall = time.perf_counter() - t0

    n_truth = sum(len(b) for b in truth.values())
    print(f"\n{len(images)} photos, {n_truth} people")
    print(f"VOC  P={voc.precision:.3f} R={voc.recall:.3f} AP50={voc.ap50:.3f}")
    print(f"SAR  P={sar.precision:.3f} R={sar.recall:.3f} AP={sar.ap:.3f} (for reference)")
    print(
        f"wall time {wall:.1f} s ({int(wall // 60)} min {wall % 60:.0f} s); "
        f"detection {detect_s / max(1, len(images)):.2f} s per photo of wall time"
    )

    if args.subset is not None:
        print(f"\n--subset {args.subset}: smoke check only, not compared with {args.expected.name}")
        return 0
    if expected.get("test_images") not in (None, len(images)):
        print(f"\n{expected['test_images']} test photos expected, {len(images)} found: MISMATCH")
        return 1
    lines = compare(voc.model_dump(), expected["voc"], args.tolerance)
    print(f"\nvs {args.expected.name} (tolerance {args.tolerance}):")
    for line, _ in lines:
        print(f"  {line}")
    if not all(ok for _, ok in lines):
        print("MISMATCH: the cv2.dnn numbers differ from the published ones")
        return 1
    print("MATCH: cv2.dnn reproduces the published detector numbers")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
