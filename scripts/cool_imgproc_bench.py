"""Time the OpenCV image-processing calls Sightline makes around the detector, on real photos.

    python scripts/cool_imgproc_bench.py --data-root data/heridal/yolo_full --photos 10 \
        --repeats 20 --out runs/cool/imgproc-cool.json

Run it once per OpenCV build (COOL and the pip wheel, docs/report/COOL_GRAVITON.md) with the same
interpreter and photos. Each operation is the call the code makes, at the size it makes it:

- ``imread``: a full 4000x3000 HERIDAL JPEG (``detect_cv.detect_tiled``)
- ``resize_linear_letterbox``: the full photo to 1024 px on the long side (``detect_cv``'s resize)
- ``blob_1024``: ``dnn.blobFromImage`` of one 1024 px slice (``detect_cv._forward``)
- ``resize_cubic_2x``: a 512 px window upscaled 2x (``agent.relook.redetect_region``)
- ``zoom_native``: a 150 px window to 384 px, INTER_CUBIC (``agent.relook.zoom_native``)
- ``enhance_contrast``: LAB, CLAHE, GaussianBlur, addWeighted on the 384 px crop
  (``agent.relook.enhance_contrast``)
- ``canopy_blur``: ``cv2.blur`` 7x7 on the float64 grey frame and its square, at 1000x750
  (``search.canopy.canopy_features``; the live map runs canopy on a reduced frame)
- ``fillpoly_cell``: one map cell's polygon rasterised into a 300x300 window
  (``search.pod.cell_canopy``)
- ``gaussian_full``: GaussianBlur sigma 1.0 on the full photo (a frame-size reference)
- ``cvtcolor_gray_full``: BGR to grey on the full photo

Every operation is timed ``--repeats`` times per photo after one warm-up; the JSON keeps the
median and the 10th and 90th percentiles in milliseconds, at the default thread count and at
one thread (``cv2.setNumThreads``). A SHA-256 of each operation's output on the first photo is
saved too, so two builds can be checked for identical pixels.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def _ops(cv2, np, bgr):
    """name -> zero-argument callable returning the output array."""
    h, w = bgr.shape[:2]
    scale = 1024 / max(h, w)
    lb = (round(w * scale), round(h * scale))
    cy, cx = h // 2, w // 2
    slice_1024 = np.ascontiguousarray(bgr[cy - 512 : cy + 512, cx - 512 : cx + 512])
    win_512 = bgr[cy - 256 : cy + 256, cx - 256 : cx + 256]
    win_150 = bgr[cy - 75 : cy + 75, cx - 75 : cx + 75]
    crop_384 = cv2.resize(win_150, (384, 384), interpolation=cv2.INTER_CUBIC)
    small = cv2.resize(bgr, (1000, 750), interpolation=cv2.INTER_AREA)
    grey = small.astype(np.float64) @ np.array([0.114, 0.587, 0.299])
    grey_sq = grey * grey
    # A skewed quadrilateral like a projected grid cell, in 1/16 px (shift=4).
    cell = (np.array([[12, 30], [281, 8], [296, 270], [20, 292]], np.float64) * 16).astype(
        np.int32
    )

    def enhance():
        lab = cv2.cvtColor(crop_384, cv2.COLOR_BGR2LAB)
        l_chan, a_chan, b_chan = cv2.split(lab)
        l_chan = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(l_chan)
        out = cv2.cvtColor(cv2.merge((l_chan, a_chan, b_chan)), cv2.COLOR_LAB2BGR)
        blurred = cv2.GaussianBlur(out, (0, 0), sigmaX=1.0)
        return cv2.addWeighted(out, 1.5, blurred, -0.5, 0)

    def canopy():
        mean = cv2.blur(grey, (7, 7), borderType=cv2.BORDER_REFLECT)
        mean_sq = cv2.blur(grey_sq, (7, 7), borderType=cv2.BORDER_REFLECT)
        return np.sqrt(np.clip(mean_sq - mean * mean, 0.0, None))

    def fillpoly():
        window = np.zeros((300, 300), np.uint8)
        cv2.fillPoly(window, [cell], 1, lineType=cv2.LINE_8, shift=4)
        return window

    return {
        "resize_linear_letterbox": lambda: cv2.resize(bgr, lb, interpolation=cv2.INTER_LINEAR),
        "blob_1024": lambda: cv2.dnn.blobFromImage(
            slice_1024, 1 / 255.0, (1024, 1024), swapRB=True, crop=False
        ),
        "resize_cubic_2x": lambda: cv2.resize(win_512, (1024, 1024), interpolation=cv2.INTER_CUBIC),
        "zoom_native": lambda: cv2.resize(win_150, (384, 384), interpolation=cv2.INTER_CUBIC),
        "enhance_contrast": enhance,
        "canopy_blur": canopy,
        "fillpoly_cell": fillpoly,
        "gaussian_full": lambda: cv2.GaussianBlur(bgr, (0, 0), sigmaX=1.0),
        "cvtcolor_gray_full": lambda: cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY),
    }


def _pct(xs: list[float], q: float) -> float:
    xs = sorted(xs)
    return xs[min(len(xs) - 1, max(0, round(q * (len(xs) - 1))))]


def _time(fn, repeats: int) -> list[float]:
    fn()  # warm-up
    out = []
    for _ in range(repeats):
        t0 = time.perf_counter()
        fn()
        out.append(1000 * (time.perf_counter() - t0))
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--data-root", type=Path, default=ROOT / "data/heridal/yolo_full")
    ap.add_argument("--photos", type=int, default=10, help="first N test photos (sorted)")
    ap.add_argument("--repeats", type=int, default=20)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)

    import cv2
    import numpy as np

    paths = sorted((args.data_root / "test" / "images").glob("*.jpg"))[: args.photos]
    if not paths:
        print(f"no photos under {args.data_root}/test/images", file=sys.stderr)
        return 2
    default_threads = cv2.getNumThreads()
    result: dict[str, object] = {
        "opencv": cv2.__version__,
        "cv2_file": cv2.__file__,
        "numpy": np.__version__,
        "python": platform.python_version(),
        "machine": platform.machine(),
        "logical_cpus": os.cpu_count(),
        "default_threads": default_threads,
        "photos": [p.name for p in paths],
        "repeats": args.repeats,
        "ops": {},
        "sha256_first_photo": {},
    }
    samples: dict[str, dict[int, list[float]]] = {}
    imread_ms: dict[int, list[float]] = {}
    for threads in (default_threads, 1):
        cv2.setNumThreads(threads)
        imread_ms[threads] = []
        for i, path in enumerate(paths):
            imread_ms[threads] += _time(
                lambda p=path: cv2.imread(str(p), cv2.IMREAD_COLOR), max(3, args.repeats // 4)
            )
            bgr = cv2.imread(str(path), cv2.IMREAD_COLOR)
            for name, fn in _ops(cv2, np, bgr).items():
                samples.setdefault(name, {}).setdefault(threads, [])
                samples[name][threads] += _time(fn, args.repeats)
                if i == 0 and threads == default_threads:
                    out = np.ascontiguousarray(fn())
                    result["sha256_first_photo"][name] = hashlib.sha256(out.tobytes()).hexdigest()
            if i == 0 and threads == default_threads:
                result["sha256_first_photo"]["imread"] = hashlib.sha256(bgr.tobytes()).hexdigest()
        print(f"threads={threads}: done", flush=True)
    cv2.setNumThreads(default_threads)
    samples["imread"] = imread_ms
    for name, by_threads in samples.items():
        result["ops"][name] = {
            ("default_threads" if t == default_threads else "one_thread"): {
                "median_ms": statistics.median(xs),
                "p10_ms": _pct(xs, 0.1),
                "p90_ms": _pct(xs, 0.9),
                "n": len(xs),
            }
            for t, xs in by_threads.items()
        }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=1), encoding="utf-8")
    for name, row in result["ops"].items():
        d, o = row["default_threads"]["median_ms"], row["one_thread"]["median_ms"]
        print(f"{name:26s} {d:9.3f} ms ({default_threads} threads)  {o:9.3f} ms (1 thread)")
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
