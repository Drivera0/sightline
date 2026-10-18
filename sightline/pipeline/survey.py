"""The demo survey builder (LANE_D section 6.2): frames cut from test photos, flight order shuffled.

Ground truth lives only in `data/survey/truth.json`; it never enters the cache. `Box` and
`LabeledImage` are lane A's types (`sightline.ml.types`); this module only relies on their shape.
"""

from __future__ import annotations

import json
import random
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Literal, Protocol

from PIL import Image

FRAME_W, FRAME_H = 1000, 750

FrameLabel = Literal["positive", "negative", "ambiguous"]


class BoxLike(Protocol):
    """Pixel box, origin top-left, edges half-open: covers x1 <= x < x2 and y1 <= y < y2."""

    @property
    def x1(self) -> int: ...
    @property
    def y1(self) -> int: ...
    @property
    def x2(self) -> int: ...
    @property
    def y2(self) -> int: ...

    def shifted(self, dx: int, dy: int) -> BoxLike: ...


class LabeledImageLike(Protocol):
    @property
    def path(self) -> Path: ...
    @property
    def width(self) -> int: ...
    @property
    def height(self) -> int: ...
    @property
    def boxes(self) -> Sequence[BoxLike]: ...


@dataclass
class FrameSpec:
    id: str
    flight_index: int
    source_image: str
    x0: int
    y0: int
    path: Path


@dataclass(frozen=True)
class FrameCandidate:
    source_image: str
    x0: int
    y0: int
    w: int
    h: int


def cut_frames(
    images: Sequence[LabeledImageLike], w: int = FRAME_W, h: int = FRAME_H
) -> list[tuple[FrameCandidate, FrameLabel, list[BoxLike]]]:
    """Split each image into non-overlapping w x h frames and label each one.

    - positive: holds at least one person box, and every box touching it lies fully inside.
    - ambiguous: some box crosses its edge (a half person is neither a fair hit nor a fair miss).
    - negative: no box touches it.

    Boxes are returned in the frame's own pixel coordinates (so a crossing box may stick out of an
    ambiguous frame); negative frames get `[]`. Pixels left over at the right/bottom are dropped.
    """
    cut: list[tuple[FrameCandidate, FrameLabel, list[BoxLike]]] = []
    for image in images:
        for row in range(image.height // h):
            for col in range(image.width // w):
                x0, y0 = col * w, row * h
                touching = [
                    b
                    for b in image.boxes
                    if b.x1 < x0 + w and b.x2 > x0 and b.y1 < y0 + h and b.y2 > y0
                ]
                crossing = any(
                    b.x1 < x0 or b.x2 > x0 + w or b.y1 < y0 or b.y2 > y0 + h for b in touching
                )
                label: FrameLabel = (
                    "negative" if not touching else "ambiguous" if crossing else "positive"
                )
                candidate = FrameCandidate(image.path.name, x0, y0, w, h)
                cut.append((candidate, label, [b.shifted(-x0, -y0) for b in touching]))
    return cut


def build_survey(
    images: Sequence[LabeledImageLike],
    n_frames: int = 500,
    n_positive: int = 6,
    seed: int = 7,
    survey_dir: Path = Path("data/survey"),
) -> tuple[list[FrameSpec], dict[str, list[BoxLike]]]:
    """Pick `n_positive` positive and `n_frames - n_positive` negative frames; shuffle the order.

    Returns the frames in flight order (`f0001`...) and the truth (frame id -> boxes in frame
    pixels, `[]` for negatives). Positives prefer different source photos. The flight order is a
    seeded shuffle of all frames: positives are never placed by hand. The result does not depend on
    the order of `images`.
    """
    rng = random.Random(seed)
    cut = cut_frames(sorted(images, key=lambda image: image.path.name))
    positives = [(c, b) for c, label, b in cut if label == "positive"]
    negatives = [(c, b) for c, label, b in cut if label == "negative"]
    n_negative = n_frames - n_positive
    if len(positives) < n_positive:
        raise ValueError(
            f"need {n_positive} positive frames but the photos only have {len(positives)}"
        )
    if len(negatives) < n_negative:
        raise ValueError(
            f"need {n_negative} negative frames but the photos only have {len(negatives)}"
        )

    chosen = _pick_positives(positives, n_positive, rng) + rng.sample(negatives, n_negative)
    rng.shuffle(chosen)

    frames, truth = [], {}
    for k, (candidate, boxes) in enumerate(chosen):
        frame_id = f"f{k + 1:04d}"
        path = survey_dir / "frames" / f"{frame_id}.jpg"
        frames.append(
            FrameSpec(frame_id, k, candidate.source_image, candidate.x0, candidate.y0, path)
        )
        truth[frame_id] = boxes
    return frames, truth


def _pick_positives(
    positives: list[tuple[FrameCandidate, list[BoxLike]]], n: int, rng: random.Random
) -> list[tuple[FrameCandidate, list[BoxLike]]]:
    """Round-robin over source photos (in shuffled order) so photos repeat only when they must."""
    by_photo: dict[str, list[tuple[FrameCandidate, list[BoxLike]]]] = {}
    for item in positives:
        by_photo.setdefault(item[0].source_image, []).append(item)
    photos = list(by_photo)
    rng.shuffle(photos)
    picked = []
    while len(picked) < n:
        for photo in photos:
            if len(picked) < n and by_photo[photo]:
                picked.append(by_photo[photo].pop(rng.randrange(len(by_photo[photo]))))
    return picked


def write_survey(
    frames: Sequence[FrameSpec],
    truth: dict[str, list[BoxLike]],
    images: Sequence[LabeledImageLike],
    survey_dir: Path,
) -> None:
    """Write the frame JPEGs (q85), `frames.json` and `truth.json` under `survey_dir`."""
    paths = {image.path.name: image.path for image in images}
    survey_dir.mkdir(parents=True, exist_ok=True)
    for source_name in sorted({f.source_image for f in frames}):
        with Image.open(paths[source_name]) as photo:
            for f in (f for f in frames if f.source_image == source_name):
                f.path.parent.mkdir(parents=True, exist_ok=True)
                photo.crop((f.x0, f.y0, f.x0 + FRAME_W, f.y0 + FRAME_H)).convert("RGB").save(
                    f.path, quality=85
                )
    # Forward slashes and \n line endings, so these files hash the same on every OS.
    listing = [{**asdict(f), "path": f.path.as_posix()} for f in frames]
    _write_lf(survey_dir / "frames.json", json.dumps(listing, indent=2) + "\n")
    serialisable = {k: [[b.x1, b.y1, b.x2, b.y2] for b in v] for k, v in truth.items()}
    _write_lf(survey_dir / "truth.json", json.dumps(serialisable, indent=2) + "\n")


def _write_lf(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8", newline="\n")


# --- reading the HERIDAL test split without lane A (fallback for lane A's `load_split`) --------


@dataclass(frozen=True)
class PixelBox:
    x1: int
    y1: int
    x2: int
    y2: int

    def shifted(self, dx: int, dy: int) -> PixelBox:
        return PixelBox(self.x1 + dx, self.y1 + dy, self.x2 + dx, self.y2 + dy)


@dataclass(frozen=True)
class PhotoRecord:
    """Same shape as lane A's `LabeledImage`."""

    path: Path
    width: int
    height: int
    boxes: list[PixelBox]


def read_yolo_split(split_dir: Path) -> list[PhotoRecord]:
    """Read `<split_dir>/images/*.jpg` and `<split_dir>/labels/*.txt` (`0 cx cy w h`, normalised)."""
    photos = []
    for image_path in sorted((split_dir / "images").glob("*.jpg")):
        with Image.open(image_path) as image:
            width, height = image.size
        label = split_dir / "labels" / f"{image_path.stem}.txt"
        boxes = []
        for line in label.read_text().splitlines() if label.is_file() else []:
            parts = line.split()
            if len(parts) != 5:
                continue
            cx, cy, w, h = (float(v) for v in parts[1:])
            boxes.append(
                PixelBox(
                    round((cx - w / 2) * width),
                    round((cy - h / 2) * height),
                    round((cx + w / 2) * width),
                    round((cy + h / 2) * height),
                )
            )
        photos.append(PhotoRecord(image_path, width, height, boxes))
    return photos
