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

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from sightline.ml.detect import MERGE_THRESHOLD, SLICE_OVERLAP, SLICE_PX
from sightline.ml.types import Box, RawDetection

INPUT_PX = 1024  # the model's square input (export imgsz)
SLICE_NMS_IOU = 0.7  # Ultralytics' default NMS IoU inside one slice
MAX_DET = 300  # Ultralytics' default max detections per slice
PAD_VALUE = 114  # Ultralytics' letterbox grey

Xyxy = tuple[float, float, float, float]


@dataclass(frozen=True)
class Letterbox:
    """Fit of one slice inside the model input: scale, then centred padding."""

    scale: float
    pad_x: int
    pad_y: int
    width: int
    height: int


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


def letterbox(width: int, height: int, input_px: int = INPUT_PX) -> Letterbox:
    """Ultralytics' LetterBox(auto=False, centred): keep aspect ratio, pad the rest."""
    scale = min(input_px / width, input_px / height)
    w, h = round(width * scale), round(height * scale)
    pad_x = max(0, round((input_px - w) / 2 - 0.1))
    pad_y = max(0, round((input_px - h) / 2 - 0.1))
    return Letterbox(scale, pad_x, pad_y, w, h)


def letterboxed(bgr: np.ndarray, lb: Letterbox, input_px: int = INPUT_PX) -> np.ndarray:
    """The slice resized and placed on a grey ``input_px`` canvas (BGR, uint8)."""
    canvas = np.full((input_px, input_px, 3), PAD_VALUE, dtype=np.uint8)
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


def nms_inclusive(dets: list[tuple[Xyxy, float]], threshold: float) -> list[tuple[Xyxy, float]]:
    """Greedy NMS, highest confidence first, suppressing at IoU >= ``threshold`` (SAHI's merge).
    Ties keep the earlier box (Python's sort is stable)."""
    kept: list[tuple[Xyxy, float]] = []
    for box, conf in sorted(dets, key=lambda d: d[1], reverse=True):
        if not any(iou(k[0], box) >= threshold for k in kept):
            kept.append((box, conf))
    return kept


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


class CvDetector:
    """The weights-v2 detector run through ``cv2.dnn`` on its ONNX export."""

    def __init__(self, onnx_path: Path, input_px: int = INPUT_PX) -> None:
        self.onnx_path = Path(onnx_path)
        if not self.onnx_path.exists():
            raise FileNotFoundError(self.onnx_path)
        self.input_px = input_px
        self.net = cv2.dnn.readNetFromONNX(str(self.onnx_path))

    def _forward(self, canvas_bgr: np.ndarray) -> np.ndarray:
        blob = cv2.dnn.blobFromImage(
            canvas_bgr, scalefactor=1 / 255, size=(self.input_px, self.input_px), swapRB=True
        )
        self.net.setInput(blob)
        out = self.net.forward()
        return np.asarray(out)[0]  # [4 + nc, anchors]

    def detect_slice(self, bgr: np.ndarray, conf: float = 0.05) -> list[tuple[Xyxy, float]]:
        """One slice (BGR pixels of any size up to ``input_px``), boxes in slice pixels."""
        h, w = bgr.shape[:2]
        lb = letterbox(w, h, self.input_px)
        return decode_slice(self._forward(letterboxed(bgr, lb, self.input_px)), lb, w, h, conf)

    def detect_tiled(
        self,
        image: Path | np.ndarray,
        conf: float = 0.05,
        slice_px: int = SLICE_PX,
        overlap: float = SLICE_OVERLAP,
        match_threshold: float = MERGE_THRESHOLD,
    ) -> list[RawDetection]:
        """Tiled detection on a full photo (path or BGR array), highest confidence first."""
        bgr = cv2.imread(str(image), cv2.IMREAD_COLOR) if isinstance(image, Path | str) else image
        if bgr is None:
            raise FileNotFoundError(image)
        height, width = bgr.shape[:2]
        dets: list[tuple[Xyxy, float]] = []
        for sx1, sy1, sx2, sy2 in slice_boxes(width, height, slice_px, overlap):
            for (x1, y1, x2, y2), c in self.detect_slice(bgr[sy1:sy2, sx1:sx2], conf):
                dets.append(((x1 + sx1, y1 + sy1, x2 + sx1, y2 + sy1), c))
        out: list[RawDetection] = []
        for box, c in nms_inclusive(dets, match_threshold):
            ib = int_box(box, width, height)
            if ib is not None:
                out.append(RawDetection(box=ib, conf=c))
        return sorted(out, key=lambda d: d.conf, reverse=True)
