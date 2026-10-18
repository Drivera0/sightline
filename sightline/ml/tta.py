"""Test-time augmentation for tiled inference: the 8 flips/rotations of a nadir photo.

A nadir drone photo has no "up", so each dihedral transform is an equally valid view. Each view
is run through the normal tiled detector, its boxes are mapped back to the original image, and
the views are fused (pooled NMS, or weighted box fusion). Pure numpy; the GPU part is
``Detector.slice_predictions``. Evaluated on val in ``scripts/tune_on_val.py --tta``.
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np

from sightline.ml.types import RawDetection

FloatBox = tuple[float, float, float, float, float]  # x1, y1, x2, y2, conf

# name -> (number of CCW quarter turns, then flip left-right?)
TRANSFORMS: dict[str, tuple[int, bool]] = {
    "id": (0, False),
    "hflip": (0, True),
    "rot90": (1, False),
    "rot180": (2, False),
    "rot270": (3, False),
    "vflip": (2, True),  # rot180 then hflip == vertical flip
    "transpose": (1, True),
    "antitranspose": (3, True),
}


def transform_image(pixels: np.ndarray, name: str) -> np.ndarray:
    k, flip = TRANSFORMS[name]
    out = np.rot90(pixels, k) if k else pixels
    if flip:
        out = out[:, ::-1]
    return np.ascontiguousarray(out)


def _rot90_back(box: tuple[float, float, float, float], w: int, h: int):
    """Undo one CCW quarter turn. ``w, h`` are the size of the image *before* that turn.

    np.rot90 (CCW): original (x, y) -> new (y, w - x). Inverse: new (x', y') -> (w - y', x').
    """
    x1, y1, x2, y2 = box
    return (w - y2, x1, w - y1, x2)


def boxes_back(boxes: Sequence[FloatBox], name: str, width: int, height: int) -> list[FloatBox]:
    """Map boxes predicted on ``transform_image(img, name)`` back to ``img`` (size ``width`` x
    ``height``)."""
    k, flip = TRANSFORMS[name]
    # sizes after 0..k quarter turns
    sizes = [(width, height) if i % 2 == 0 else (height, width) for i in range(k + 1)]
    out: list[FloatBox] = []
    for x1, y1, x2, y2, c in boxes:
        b = (x1, y1, x2, y2)
        if flip:
            fw = sizes[k][0]
            b = (fw - b[2], b[1], fw - b[0], b[3])
        for i in range(k, 0, -1):
            pw, ph = sizes[i - 1]
            b = _rot90_back(b, pw, ph)
        out.append((*b, c))
    return out


def _iou(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """IoU of one box ``a`` (4,) against many ``b`` (n, 4)."""
    ix1 = np.maximum(a[0], b[:, 0])
    iy1 = np.maximum(a[1], b[:, 1])
    ix2 = np.minimum(a[2], b[:, 2])
    iy2 = np.minimum(a[3], b[:, 3])
    inter = np.clip(ix2 - ix1, 0, None) * np.clip(iy2 - iy1, 0, None)
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1])
    return inter / np.maximum(area_a + area_b - inter, 1e-9)


def weighted_box_fusion(
    views: Sequence[Sequence[FloatBox]], iou_threshold: float = 0.55
) -> list[FloatBox]:
    """Weighted box fusion (Solovyev et al. 2021) over ``len(views)`` views of one image.

    Boxes from all views are clustered greedily in descending confidence (a box joins the first
    cluster whose fused box it overlaps at IoU >= ``iou_threshold``). The fused box is the
    confidence-weighted mean of the cluster; its score is the summed confidence divided by the
    number of views, so a box seen in one view out of eight keeps 1/8 of its confidence.
    """
    n_views = max(1, len(views))
    flat = sorted((b for v in views for b in v), key=lambda b: -b[4])
    clusters: list[list[FloatBox]] = []
    fused: list[np.ndarray] = []
    for b in flat:
        arr = np.array(b[:4], dtype=float)
        j = -1
        if fused:
            ious = _iou(arr, np.stack(fused))
            best = int(np.argmax(ious))
            if ious[best] >= iou_threshold:
                j = best
        if j < 0:
            clusters.append([b])
            fused.append(arr)
        else:
            clusters[j].append(b)
            w = np.array([c[4] for c in clusters[j]])
            coords = np.array([c[:4] for c in clusters[j]])
            fused[j] = (coords * w[:, None]).sum(0) / w.sum()
    out: list[FloatBox] = []
    for cl, fb in zip(clusters, fused, strict=True):
        score = min(1.0, sum(c[4] for c in cl) / n_views)
        out.append((float(fb[0]), float(fb[1]), float(fb[2]), float(fb[3]), score))
    return out


def to_float_boxes(dets: Sequence[RawDetection]) -> list[FloatBox]:
    return [(d.box.x1, d.box.y1, d.box.x2, d.box.y2, d.conf) for d in dets]
