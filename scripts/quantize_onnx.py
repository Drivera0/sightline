"""INT8 experiment: quantize the detector's ONNX and run it in OpenCV 5's DNN engines. Val only.

    uv run --extra ml --extra quant python scripts/quantize_onnx.py quantize \
        [--onnx data/weights/release_v2/yolo11s_tiles_run1_best.onnx] [--calib-tiles 64]
    uv run --extra ml --extra quant python scripts/quantize_onnx.py bench \
        --int8 runs/int8/<stem>_int8_qdq.onnx [--runs 3]

``quantize`` follows opencv_zoo's ``tools/quantize/quantize-ort.py``: a ``CalibrationDataReader``
over preprocessed inputs, ``quant_pre_process`` (shape inference), then ONNX Runtime's
``quantize_static``. Differences: the format is QDQ (QuantizeLinear/DequantizeLinear pairs, what
OpenCV 5's new engine is said to support) rather than opencv_zoo's QOperator, the opset is kept
(17), and the calibration set is 1024 px **val** tiles cut exactly as ``detect_cv.py`` cuts them
(SAHI slices, letterbox, 1/255, RGB). ``--exclude-head`` keeps the Detect head (``/model.23/``)
in float, a common fix when INT8 boxes drift.

``bench`` loads FP32 and INT8 with ``readNetFromONNX`` under ``ENGINE_NEW`` and ``ENGINE_CLASSIC``.
A load or forward failure is recorded with OpenCV's exact message and that row stops there.
Rows that run are timed (ms per 1024 px tile, s per 4000x3000 photo with the same tiling as
``CvDetector.detect_tiled``; ``--runs`` interleaved repeats, mean and sd) and scored on the annotated val
photos with ``score_voc`` at the frozen 0.29 threshold. The test split is never read.

Writes ``runs/int8/`` (models, ``bench-<timestamp>.json``). onnxruntime is the ``quant`` extra only:
it is never needed at run time.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import random
import statistics
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import cv2
import numpy as np

from sightline.ml.detect_cv import INPUT_PX, letterbox, letterboxed, slice_boxes

THRESHOLD = 0.29  # frozen in sprint 1, chosen on val
HEAD_PREFIX = "/model.23/"  # YOLO11's Detect head in the Ultralytics export
DEFAULT_ONNX = ROOT / "data/weights/release_v2/yolo11s_tiles_run1_best.onnx"
DEFAULT_DATA = ROOT / "data/heridal/yolo_full"
OUT = ROOT / "runs/int8"


def val_tiles(data_root: Path, n: int, seed: int = 0) -> list[np.ndarray]:
    """``n`` preprocessed val tiles (``[1, 3, 1024, 1024]`` float32 blobs), each a random SAHI
    slice of a different random annotated val photo where possible."""
    from sightline.ml.data import load_split

    images = load_split("val", data_root, annotated_only=True)
    rng = random.Random(seed)
    picks = [rng.choice(images) for _ in range(n)] if n > len(images) else rng.sample(images, n)
    blobs = []
    for im in picks:
        bgr = cv2.imread(str(im.path), cv2.IMREAD_COLOR)
        x1, y1, x2, y2 = rng.choice(slice_boxes(bgr.shape[1], bgr.shape[0]))
        blobs.append(blob(bgr[y1:y2, x1:x2]))
    return blobs


def blob(tile_bgr: np.ndarray) -> np.ndarray:
    """The model input for one slice, exactly as ``CvDetector._forward`` builds it (square pad)."""
    h, w = tile_bgr.shape[:2]
    canvas = letterboxed(tile_bgr, letterbox(w, h, INPUT_PX))
    return cv2.dnn.blobFromImage(
        canvas, scalefactor=1 / 255, size=(INPUT_PX, INPUT_PX), swapRB=True
    )


def quantize(args: argparse.Namespace) -> int:
    import onnx
    import onnxruntime
    from onnxruntime.quantization import (
        CalibrationDataReader,
        CalibrationMethod,
        QuantFormat,
        QuantType,
        quant_pre_process,
        quantize_static,
    )

    class DataReader(CalibrationDataReader):  # opencv_zoo's pattern
        def __init__(self, model_path: Path, blobs: list[np.ndarray]) -> None:
            self.input_name = onnx.load(str(model_path)).graph.input[0].name
            self.it = iter([{self.input_name: b} for b in blobs])

        def get_next(self):
            return next(self.it, None)

    args.out.mkdir(parents=True, exist_ok=True)
    stem = args.onnx.stem
    pre = args.out / f"{stem}_pre.onnx"
    suffix = "_nohead" if args.exclude_head else ""
    dst = args.out / f"{stem}_int8_{args.format}{suffix}.onnx"
    print(f"onnxruntime {onnxruntime.__version__}; pre-processing {args.onnx}", flush=True)
    quant_pre_process(str(args.onnx), str(pre))
    model = onnx.load(str(pre))
    exclude = [n.name for n in model.graph.node if n.name.startswith(HEAD_PREFIX)]
    exclude = exclude if args.exclude_head else []
    print(f"calibrating on {args.calib_tiles} val tiles; {len(exclude)} head nodes kept float")
    t0 = time.time()
    quantize_static(
        str(pre),
        str(dst),
        DataReader(pre, val_tiles(args.data_root, args.calib_tiles, args.seed)),
        quant_format=QuantFormat.QDQ if args.format == "qdq" else QuantFormat.QOperator,
        per_channel=args.per_channel,
        activation_type=QuantType.QUInt8 if args.act == "uint8" else QuantType.QInt8,
        weight_type=QuantType.QInt8,
        calibrate_method=getattr(CalibrationMethod, args.calibrate),
        nodes_to_exclude=exclude,
    )
    pre.unlink(missing_ok=True)
    meta = {
        "source": str(args.onnx.relative_to(ROOT) if args.onnx.is_relative_to(ROOT) else args.onnx),
        "output": dst.name,
        "onnxruntime": onnxruntime.__version__,
        "format": args.format,
        "per_channel": args.per_channel,
        "activation": args.act,
        "weights": "int8",
        "calibrate": args.calibrate,
        "calib_tiles": args.calib_tiles,
        "calib_split": "val",
        "seed": args.seed,
        "head_kept_float": args.exclude_head,
        "seconds": round(time.time() - t0, 1),
        "mb": round(dst.stat().st_size / 2**20, 1),
    }
    dst.with_suffix(".json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    print(json.dumps(meta, indent=2))
    return 0


ENGINES = {"new": "ENGINE_NEW", "classic": "ENGINE_CLASSIC"}


def _mean_sd(xs: list[float]) -> dict[str, float]:
    return {"mean": statistics.mean(xs), "sd": statistics.stdev(xs) if len(xs) > 1 else 0.0}


def load(path: Path, engine: str, threads: int | None) -> tuple[object, dict]:
    """``(detector or None, row)``: the row records a load or warm-up failure verbatim."""
    from sightline.ml.detect_cv import CvDetector

    row: dict = {"model": path.name, "engine": ENGINES[engine]}
    try:
        det = CvDetector(
            path, threads=threads, rect=False, engine=getattr(cv2.dnn, ENGINES[engine])
        )
    except cv2.error as e:
        return None, {**row, "status": "load_failed", "error": str(e).strip()}
    try:
        det._forward(np.zeros((INPUT_PX, INPUT_PX, 3), np.uint8))  # warm-up, first-run allocation
    except cv2.error as e:
        return None, {**row, "status": "forward_failed", "error": str(e).strip()}
    return det, {**row, "status": "ok", "tile_ms": [], "photo_s": []}


def time_once(det, row: dict, tiles: list[np.ndarray], photos: list) -> None:
    """One timing run: every tile through ``forward`` alone, then full photos tiled."""
    t0 = time.perf_counter()
    for b in tiles:
        _forward_blob(det, b)
    row["tile_ms"].append((time.perf_counter() - t0) * 1000 / len(tiles))
    t0 = time.perf_counter()
    for im in photos:
        det.detect_tiled(im.path)
    row["photo_s"].append((time.perf_counter() - t0) / len(photos))


def _forward_blob(det, b: np.ndarray) -> None:
    if cv2.getNumThreads() != det.threads:
        cv2.setNumThreads(det.threads)
    det.net.setInput(b)
    det.net.forward()


def score(det, photos: list) -> dict:
    from sightline.ml.evaluate import predict_split, score_voc

    preds, truth, _ = predict_split(det, photos, "tiled")
    voc = score_voc(preds, truth, THRESHOLD)
    return {
        "voc": {"precision": voc.precision, "recall": voc.recall, "ap50": voc.ap50},
        "kept_at_threshold": sum(d.conf >= THRESHOLD for v in preds.values() for d in v),
    }


def bench(args: argparse.Namespace) -> int:
    """All models are loaded first; the timing runs are interleaved (run 1 of every model, then
    run 2, ...) so that load from other processes falls on every row alike."""
    from sightline.ml.data import load_split

    photos = load_split("val", args.data_root, annotated_only=True)[: args.limit]
    tiles = val_tiles(args.data_root, args.timing_tiles, seed=args.seed + 1)
    timing_photos = photos[: args.timing_photos]
    machine = {
        "cpu": _cpu_name(),
        "logical_cpus": os.cpu_count(),
        "cv2_threads": args.threads or os.cpu_count(),
        "opencv": cv2.__version__,
        "python": platform.python_version(),
        "os": platform.platform(),
        "loadavg_start": _loadavg(),
    }
    print(json.dumps(machine), flush=True)
    loaded = []
    for path in [args.onnx, *args.int8]:
        for engine in args.engines:
            det, row = load(path, engine, args.threads)
            if det is None:
                print(json.dumps(row), flush=True)
            loaded.append((det, row))
    live = [(d, r) for d, r in loaded if d is not None]
    for n in range(args.runs):
        for det, row in live:
            time_once(det, row, tiles, timing_photos)
        print(f"timing run {n + 1}/{args.runs} done, load {_loadavg()}", flush=True)
    machine["loadavg_end_timing"] = _loadavg()
    for det, row in loaded:
        if det is not None:
            row["ms_per_tile"] = _mean_sd(row["tile_ms"])
            row["s_per_photo"] = _mean_sd(row["photo_s"])
            if not args.no_eval:
                row.update(score(det, photos))
            print(json.dumps(row), flush=True)
    out = {
        "split": "val",
        "photos": len(photos),
        "people": sum(len(im.boxes) for im in photos),
        "threshold": THRESHOLD,
        "runs": args.runs,
        "timing_tiles": len(tiles),
        "timing_photos": len(timing_photos),
        "machine": machine,
        "rows": [r for _, r in loaded],
    }
    args.out.mkdir(parents=True, exist_ok=True)
    dst = args.out / f"bench-{time.strftime('%Y%m%d-%H%M%S')}.json"
    dst.write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(f"wrote {dst}")
    return 0


def _loadavg() -> list[float] | None:
    try:
        return [round(x, 1) for x in os.getloadavg()]
    except OSError:
        return None


def _cpu_name() -> str:
    try:
        for line in Path("/proc/cpuinfo").read_text().splitlines():
            if line.startswith("model name"):
                return line.split(":", 1)[1].strip()
    except OSError:
        pass
    return platform.processor() or "unknown"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = ap.add_subparsers(dest="cmd", required=True)
    q = sub.add_parser("quantize", help="write an INT8 ONNX calibrated on val tiles")
    q.add_argument("--onnx", type=Path, default=DEFAULT_ONNX, help="FP32 export (fixed 1024 px)")
    q.add_argument("--calib-tiles", type=int, default=64)
    q.add_argument("--format", choices=["qdq", "qoperator"], default="qdq")
    q.add_argument("--act", choices=["uint8", "int8"], default="uint8")
    q.add_argument("--per-channel", action="store_true")
    q.add_argument("--calibrate", choices=["MinMax", "Entropy", "Percentile"], default="MinMax")
    q.add_argument("--exclude-head", action="store_true", help="keep the Detect head in float")
    b = sub.add_parser("bench", help="load, time and score FP32 vs INT8 on val")
    b.add_argument("--onnx", type=Path, default=DEFAULT_ONNX, help="FP32 baseline")
    b.add_argument("--int8", type=Path, nargs="+", required=True)
    b.add_argument("--engines", nargs="+", choices=list(ENGINES), default=list(ENGINES))
    b.add_argument("--runs", type=int, default=3)
    b.add_argument("--timing-tiles", type=int, default=40)
    b.add_argument("--timing-photos", type=int, default=10)
    b.add_argument("--limit", type=int, default=None, help="debug: first N val photos")
    b.add_argument("--threads", type=int, default=None, help="cv2 threads (default: every core)")
    b.add_argument("--no-eval", action="store_true", help="timing only, no val scoring")
    for p in (q, b):
        p.add_argument("--data-root", type=Path, default=DEFAULT_DATA)
        p.add_argument("--seed", type=int, default=0)
        p.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args(argv)
    return quantize(args) if args.cmd == "quantize" else bench(args)


if __name__ == "__main__":
    raise SystemExit(main())
