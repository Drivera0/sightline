"""Reading the converted HERIDAL splits (docs/LANE_A_ML.md §5)."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from sightline.ml.types import LabeledImage
from sightline.ml.voc import image_size, read_yolo_labels

Split = Literal["train", "val", "test"]
DEFAULT_ROOT = Path("data/heridal/yolo_full")


def load_split(split: Split, root: Path = DEFAULT_ROOT) -> list[LabeledImage]:
    """Reads ``<root>/<split>/{images,labels}``. Sorted by filename.

    Used by D's survey builder (test split) and by evaluation. Image sizes come from the
    JPEG headers, so this is cheap even for the full training set.
    """
    images_dir = root / split / "images"
    labels_dir = root / split / "labels"
    if not images_dir.is_dir():
        raise FileNotFoundError(f"{images_dir} not found; run scripts/convert_heridal.py first")
    out: list[LabeledImage] = []
    for jpg in sorted(images_dir.glob("*.jpg")):
        width, height = image_size(jpg)
        boxes = read_yolo_labels(labels_dir / f"{jpg.stem}.txt", width, height)
        out.append(LabeledImage(path=jpg, width=width, height=height, boxes=boxes))
    return out
