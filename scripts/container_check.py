"""Check a deployment can detect, and how fast: run it inside the AWS or Nebius container.

    python scripts/container_check.py [--repeats 5]

Builds the detector the way the pipeline does (``make_detector``: ``SIGHTLINE_BACKEND``,
``SIGHTLINE_ONNX``), runs one 1024 px slice ``--repeats`` times, and prints one JSON line:
backend, ONNX file, whether it pads like Torch (``rect``), OpenCV threads and version, CPUs,
milliseconds per slice and the estimated seconds per 4000×3000 photo (20 slices). Exit code 1 if
the detector can't be built or run. Use it to size an instance before choosing it.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

SLICES_PER_PHOTO = 20  # a 4000×3000 photo in 1024 px slices with 20 % overlap


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--repeats", type=int, default=5)
    args = ap.parse_args(argv)

    import cv2
    import numpy as np

    from sightline.ml.backend import make_detector

    try:
        det = make_detector()
        if not hasattr(det, "detect_slice"):
            raise RuntimeError(f"expected the cv2 backend, got {type(det).__name__}")
        tile = np.random.default_rng(0).integers(0, 255, (1024, 1024, 3), dtype=np.uint8)
        det.detect_slice(tile)  # warm-up
        t0 = time.perf_counter()
        for _ in range(args.repeats):
            det.detect_slice(tile)
        ms = (time.perf_counter() - t0) / args.repeats * 1000
    except (FileNotFoundError, ImportError, RuntimeError, ValueError, cv2.error) as e:
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))
        return 1
    print(
        json.dumps(
            {
                "ok": True,
                "backend": "cv2",
                "onnx": det.onnx_path.name,
                "rect": det.rect,
                "opencv": cv2.__version__,
                "threads": det.threads,
                "cpus": os.cpu_count(),
                "ms_per_slice": round(ms, 1),
                "est_s_per_4000x3000_photo": round(ms * SLICES_PER_PHOTO / 1000, 2),
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
