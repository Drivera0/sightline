"""The person detector on OpenCV 5's DNN module: no torch, ultralytics or sahi at run time.

A port of ``Detector.detect_tiled`` (sightline/ml/detect.py) with its single-view defaults, and of
the browser copy in web/src/detect/tiling.ts, which matches it box for box:

- SAHI slices of 1024 px with 0.2 overlap (``slice_boxes``, same loop as SAHI's get_slice_bboxes);
- each slice letterboxed onto a grey (114) 1024 px canvas, as Ultralytics' LetterBox does;
- one ``cv2.dnn`` forward pass per slice on the ONNX export of the same weights
  (``YOLO(pt).export(format="onnx", imgsz=1024, opset=17)``, output ``[1, 5, 21504]``);
- per-slice decode, conf >= ``conf``, NMS at IoU 0.7 (Ultralytics' default, ``cv2.dnn.NMSBoxes``);
- all slices merged with NMS at IoU 0.5, suppressing at or above the threshold like SAHI;
- rounded and clipped like ``_int_box``.

``CvDetector`` satisfies the ``TiledDetector`` protocols in sightline/pipeline/real.py and
sightline/ml/hard_negatives.py, so it drops into the pipeline in place of ``Detector``.
"""

from __future__ import annotations

import math
import os
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from sightline.ml.detect import MERGE_THRESHOLD, SLICE_OVERLAP, SLICE_PX
from sightline.ml.types import Box, RawDetection

INPUT_PX = 1024  # the model's square input (export imgsz)
MIN_CONF = 0.05  # detect_tiled's default conf: boxes below it are dropped before merging
MERGE_NMS_IOU = MERGE_THRESHOLD  # SAHI's merge across slices
SLICE_NMS_IOU = 0.7  # Ultralytics' default NMS IoU inside one slice
MAX_DET = 300  # Ultralytics' default max detections per slice
PAD_VALUE = 114  # Ultralytics' letterbox grey
STRIDE = 32  # the model's largest stride: a variable-size input must be a multiple of it

Xyxy = tuple[float, float, float, float]


@dataclass(frozen=True)
class Letterbox:
    """Fit of one slice inside the model input: scale, then centred padding."""

    scale: float
    pad_x: int
    pad_y: int
    width: int
    height: int
    canvas_w: int = INPUT_PX
    canvas_h: int = INPUT_PX


def slice_boxes(
    width: int, height: int, slice_px: int = SLICE_PX, overlap: float = SLICE_OVERLAP
) -> list[tuple[int, int, int, int]]:
    """SAHI's get_slice_bboxes: left to right, top to bottom; a window that would run past an
    edge is pulled back to end on it."""
    out: list[tuple[int, int, int, int]] = []
    step_overlap = int(overlap * slice_px)
    y_min = y_max = 0
    while y_max < height:
        x_min = x_max = 0
        y_max = y_min + slice_px
        while x_max < width:
            x_max = x_min + slice_px
            if y_max > height or x_max > width:
                x2, y2 = min(width, x_max), min(height, y_max)
                out.append((max(0, x2 - slice_px), max(0, y2 - slice_px), x2, y2))
            else:
                out.append((x_min, y_min, x_max, y_max))
            x_min = x_max - step_overlap
        y_min = y_max - step_overlap
    return out


def letterbox(
    width: int, height: int, input_px: int = INPUT_PX, stride: int | None = None
) -> Letterbox:
    """Ultralytics' LetterBox, centred: keep aspect ratio, pad the rest. ``stride=None`` pads to
    the full ``input_px`` square (auto=False, what a fixed-size ONNX needs); ``stride=32`` pads
    only up to a multiple of 32 (auto=True, what ``YOLO.predict`` does with a ``.pt`` model), so
    a 1000×750 frame becomes a 1024×768 input with no padding."""
    scale = min(input_px / width, input_px / height)
    w, h = round(width * scale), round(height * scale)
    dw, dh = (input_px - w) / 2, (input_px - h) / 2
    if stride is not None:
        dw, dh = (input_px - w) % stride / 2, (input_px - h) % stride / 2
    left, right = max(0, round(dw - 0.1)), max(0, round(dw + 0.1))
    top, bottom = max(0, round(dh - 0.1)), max(0, round(dh + 0.1))
    return Letterbox(scale, left, top, w, h, w + left + right, h + top + bottom)


def letterboxed(bgr: np.ndarray, lb: Letterbox) -> np.ndarray:
    """The slice resized and placed on a grey ``canvas_w × canvas_h`` canvas (BGR, uint8)."""
    canvas = np.full((lb.canvas_h, lb.canvas_w, 3), PAD_VALUE, dtype=np.uint8)
    if (bgr.shape[1], bgr.shape[0]) != (lb.width, lb.height):
        bgr = cv2.resize(bgr, (lb.width, lb.height), interpolation=cv2.INTER_LINEAR)
    canvas[lb.pad_y : lb.pad_y + lb.height, lb.pad_x : lb.pad_x + lb.width] = bgr
    return canvas


def iou(a: Xyxy, b: Xyxy) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def nms(
    dets: list[tuple[Xyxy, float]],
    iou_threshold: float,
    max_det: float = math.inf,
    inclusive: bool = False,
) -> list[tuple[Xyxy, float]]:
    """Greedy NMS, highest confidence first; ties keep the earlier box (Python's sort is stable).
    Ultralytics (torchvision) suppresses at IoU above the threshold; SAHI's merge suppresses at
    or above it (``inclusive``). tiling.ts ``nms``."""
    kept: list[tuple[Xyxy, float]] = []
    for box, conf in sorted(dets, key=lambda d: d[1], reverse=True):
        if len(kept) >= max_det:
            break
        overlaps = (iou(k[0], box) for k in kept)
        if not any(v >= iou_threshold if inclusive else v > iou_threshold for v in overlaps):
            kept.append((box, conf))
    return kept


def nms_inclusive(dets: list[tuple[Xyxy, float]], threshold: float) -> list[tuple[Xyxy, float]]:
    """SAHI's merge: suppress at IoU >= ``threshold``."""
    return nms(dets, threshold, inclusive=True)


def decode_slice(
    output: np.ndarray, lb: Letterbox, slice_w: int, slice_h: int, conf: float
) -> list[tuple[Xyxy, float]]:
    """Raw output ``[4 + nc, anchors]`` (cx, cy, w, h in input pixels, then class scores) to
    boxes in slice pixels: conf filter, then per-slice NMS with ``cv2.dnn.NMSBoxes``."""
    scores = output[4:].max(axis=0)
    keep = scores >= conf
    if not keep.any():
        return []
    cx, cy, w, h = output[:4, keep]
    s = scores[keep]
    x1 = np.clip((cx - w / 2 - lb.pad_x) / lb.scale, 0, slice_w)
    y1 = np.clip((cy - h / 2 - lb.pad_y) / lb.scale, 0, slice_h)
    x2 = np.clip((cx + w / 2 - lb.pad_x) / lb.scale, 0, slice_w)
    y2 = np.clip((cy + h / 2 - lb.pad_y) / lb.scale, 0, slice_h)
    # NMSBoxes takes (x, y, w, h) and suppresses at IoU > threshold, like torchvision's nms.
    rects = np.stack([x1, y1, x2 - x1, y2 - y1], axis=1).astype(np.float32)
    idx = cv2.dnn.NMSBoxes(rects.tolist(), s.astype(np.float32).tolist(), conf, SLICE_NMS_IOU)
    idx = np.asarray(idx).reshape(-1)[:MAX_DET]
    return [((float(x1[i]), float(y1[i]), float(x2[i]), float(y2[i])), float(s[i])) for i in idx]


def int_box(box: Xyxy, width: int, height: int) -> Box | None:
    """Round, clip to the image, drop degenerate boxes (detect.py's ``_int_box``)."""
    x1, y1 = max(0, round(box[0])), max(0, round(box[1]))
    x2, y2 = min(width, round(box[2])), min(height, round(box[3]))
    if x2 <= x1 or y2 <= y1:
        return None
    return Box(x1, y1, x2, y2)


def offset(
    dets: list[tuple[Xyxy, float]], window: tuple[int, int, int, int]
) -> list[tuple[Xyxy, float]]:
    """Shift a slice's boxes into photo pixels (tiling.ts ``offset``)."""
    dx, dy = window[0], window[1]
    return [((x1 + dx, y1 + dy, x2 + dx, y2 + dy), c) for (x1, y1, x2, y2), c in dets]


def merge_slices(
    per_slice: list[list[tuple[Xyxy, float]]],
    width: int,
    height: int,
    iou_threshold: float = MERGE_NMS_IOU,
) -> list[RawDetection]:
    """Every slice's boxes (photo pixels) merged with SAHI's inclusive NMS, rounded like
    ``_int_box``, highest confidence first (tiling.ts ``mergeSlices``)."""
    merged = nms([d for dets in per_slice for d in dets], iou_threshold, inclusive=True)
    out = [RawDetection(box=b, conf=c) for box, c in merged if (b := int_box(box, width, height))]
    return sorted(out, key=lambda d: d.conf, reverse=True)


def _read(image: Path | str) -> np.ndarray:
    bgr = cv2.imread(str(image), cv2.IMREAD_COLOR)
    if bgr is None:
        raise FileNotFoundError(image)
    return bgr


class CvDetector:
    """The weights-v2 detector run through ``cv2.dnn`` on its ONNX export."""

    def __init__(
        self,
        onnx_path: Path,
        input_px: int = INPUT_PX,
        threads: int | None = None,
        rect: bool | None = None,
        engine: int | None = None,
    ) -> None:
        """``engine``: a ``cv2.dnn.ENGINE_*`` value for ``readNetFromONNX``; ``None`` (the default)
        calls it without one, OpenCV's own default. Only the INT8 experiment sets it
        (scripts/quantize_onnx.py).

        ``rect``: pad like ``YOLO.predict`` (to a multiple of 32) instead of to the square.
        Needs an ONNX exported with ``dynamic=True`` (``scripts/export_onnx.py``); ``None`` checks
        once whether this one accepts a non-square input. Full 1024 px slices are the same either
        way; smaller or non-square slices (1000×750 demo frames) match Torch only with ``rect``."""
        self.onnx_path = Path(onnx_path)
        if not self.onnx_path.exists():
            raise FileNotFoundError(self.onnx_path)
        self.input_px = input_px
        # OpenCV's thread count is process-wide, and importing ultralytics sets it to 0
        # (single-threaded, for PyTorch's DataLoader): 5x slower here. Keep our own and restore it
        # before every forward pass.
        self.threads = threads if threads is not None else os.cpu_count() or 1
        cv2.setNumThreads(self.threads)
        self.engine = engine
        if engine is None:
            self.net = cv2.dnn.readNetFromONNX(str(self.onnx_path))
        else:
            self.net = cv2.dnn.readNetFromONNX(str(self.onnx_path), engine)
        self.rect = self._accepts_rect() if rect is None else rect

    def _accepts_rect(self) -> bool:
        """True if the network runs a ``input_px × 3/4`` input and returns one anchor per cell of
        each stride (8, 16, 32): an ONNX exported with dynamic axes."""
        w, h = self.input_px, self.input_px * 3 // 4 // STRIDE * STRIDE
        try:
            out = self._forward(np.zeros((h, w, 3), np.uint8))
        except cv2.error:
            return False
        return out.shape[-1] == sum((w // s) * (h // s) for s in (8, 16, 32))

    def _forward(self, canvas_bgr: np.ndarray) -> np.ndarray:
        if cv2.getNumThreads() != self.threads:
            cv2.setNumThreads(self.threads)
        h, w = canvas_bgr.shape[:2]
        blob = cv2.dnn.blobFromImage(canvas_bgr, scalefactor=1 / 255, size=(w, h), swapRB=True)
        self.net.setInput(blob)
        out = self.net.forward()
        return np.asarray(out)[0]  # [4 + nc, anchors]

    def detect_slice(self, bgr: np.ndarray, conf: float = 0.05) -> list[tuple[Xyxy, float]]:
        """One slice (BGR pixels of any size up to ``input_px``), boxes in slice pixels."""
        h, w = bgr.shape[:2]
        lb = letterbox(w, h, self.input_px, STRIDE if self.rect else None)
        return decode_slice(self._forward(letterboxed(bgr, lb)), lb, w, h, conf)

    def detect_frame(self, image: Path, conf: float = MIN_CONF) -> list[RawDetection]:
        """One pass with the whole image letterboxed to ``input_px``, like ``Detector.detect_frame``
        (demo frames, 1000×750, fit in one pass). Matches Torch box for box only when ``rect``
        (a dynamic ONNX); with the fixed-size export, boxes near the top and bottom edges differ."""
        bgr = _read(image)
        height, width = bgr.shape[:2]
        dets = self.detect_slice(bgr, conf)  # already NMS'd; no merge across slices
        out = [RawDetection(box=b, conf=c) for box, c in dets if (b := int_box(box, width, height))]
        return sorted(out, key=lambda d: d.conf, reverse=True)

    def detect_tiled(
        self,
        image: Path | np.ndarray,
        conf: float = MIN_CONF,
        slice_px: int = SLICE_PX,
        overlap: float = SLICE_OVERLAP,
        match_threshold: float = MERGE_THRESHOLD,
    ) -> list[RawDetection]:
        """Tiled detection on a full photo (path or BGR array), highest confidence first."""
        bgr = _read(image) if isinstance(image, Path | str) else image
        height, width = bgr.shape[:2]
        per_slice = [
            offset(self.detect_slice(bgr[y1:y2, x1:x2], conf), (x1, y1, x2, y2))
            for x1, y1, x2, y2 in slice_boxes(width, height, slice_px, overlap)
        ]
        return merge_slices(per_slice, width, height, match_threshold)

    def detect_array(self, img_bgr: np.ndarray, conf: float = MIN_CONF) -> list[RawDetection]:
        """Tiled detection on BGR pixels already in memory (the re-look's native window and its
        2× upscale: the upscale only helps if it is sliced, not shrunk back to one input)."""
        return self.detect_tiled(img_bgr, conf)
