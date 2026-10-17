"""VOC XML ↔ YOLO txt helpers for HERIDAL (docs/LANE_A_ML.md §4).

Pure functions apart from ``read_voc`` / ``read_yolo_labels``, which read one file each.
"""

from __future__ import annotations

import random
import xml.etree.ElementTree as ET
from collections.abc import Sequence
from pathlib import Path

from sightline.ml.types import Box, LabeledImage

PERSON = "person"


def parse_voc(xml_text: str) -> tuple[int | None, int | None, list[Box]]:
    """Return ``(width, height, person boxes)`` from a VOC annotation.

    Width/height are ``None`` when the XML has no ``<size>`` (some HERIDAL files).
    Element order doesn't matter: HERIDAL often lists ``<object>`` before ``<size>``.
    Boxes are returned as written (not yet clipped to the image).
    """
    root = ET.fromstring(xml_text)
    size = root.find("size")
    width = _int_or_none(size.findtext("width")) if size is not None else None
    height = _int_or_none(size.findtext("height")) if size is not None else None
    boxes: list[Box] = []
    for obj in root.iter("object"):
        if (obj.findtext("name") or "").strip() != PERSON:
            continue
        bb = obj.find("bndbox")
        if bb is None:
            continue
        x1, y1 = int(float(bb.findtext("xmin"))), int(float(bb.findtext("ymin")))
        x2, y2 = int(float(bb.findtext("xmax"))), int(float(bb.findtext("ymax")))
        if x2 > x1 and y2 > y1:
            boxes.append(Box(x1, y1, x2, y2))
    return width, height, boxes


def clip_box(box: Box, width: int, height: int) -> Box | None:
    """Clip to the image; ``None`` if nothing is left."""
    return box.clipped(0, 0, width, height)


def read_voc(xml_path: Path, image_path: Path) -> LabeledImage:
    """One labelled image. Falls back to the JPEG header for size when the XML lacks it."""
    width, height, boxes = parse_voc(xml_path.read_text(encoding="utf-8"))
    if width is None or height is None:
        width, height = image_size(image_path)
    clipped = [c for b in boxes if (c := clip_box(b, width, height)) is not None]
    return LabeledImage(path=image_path, width=width, height=height, boxes=clipped)


def image_size(image_path: Path) -> tuple[int, int]:
    """(width, height) from the file header only; no full decode."""
    from PIL import Image

    with Image.open(image_path) as im:
        return im.size


def yolo_line(box: Box, width: int, height: int, cls: int = 0) -> str:
    """``cls cx cy w h`` normalised to [0, 1], 6 decimals."""
    cx, cy = box.center
    return f"{cls} {cx / width:.6f} {cy / height:.6f} {box.width_px / width:.6f} {box.height_px / height:.6f}"


def yolo_lines(image: LabeledImage) -> list[str]:
    return [yolo_line(b, image.width, image.height) for b in image.boxes]


def yolo_line_to_box(line: str, width: int, height: int) -> Box:
    _cls, cx, cy, w, h = (float(v) for v in line.split())
    x1 = round((cx - w / 2) * width)
    x2 = round((cx + w / 2) * width)
    y1 = round((cy - h / 2) * height)
    y2 = round((cy + h / 2) * height)
    return Box(x1, y1, max(x2, x1 + 1), max(y2, y1 + 1))


def read_yolo_labels(label_path: Path, width: int, height: int) -> list[Box]:
    """Boxes from a YOLO label file; a missing file means an empty (background) image."""
    if not label_path.exists():
        return []
    lines = [ln for ln in label_path.read_text(encoding="utf-8").splitlines() if ln.strip()]
    return [yolo_line_to_box(ln, width, height) for ln in lines]


def split_train_val(
    ids: Sequence[str], val_frac: float = 0.1, seed: int = 7
) -> tuple[list[str], list[str]]:
    """Seeded split **by image**. Independent of the input order; both halves sorted."""
    pool = sorted(ids)
    rng = random.Random(seed)
    rng.shuffle(pool)
    n_val = round(len(pool) * val_frac)
    val = sorted(pool[:n_val])
    train = sorted(pool[n_val:])
    return train, val


def _int_or_none(text: str | None) -> int | None:
    try:
        return int(float(text)) if text is not None else None
    except ValueError:
        return None
