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


# --- block layout: neighbouring crops of one photo sit next to each other on the ground ----------

BLOCK_LINES = 4  # a 4000 px photo row is 4 crops wide, so a band of 4 flight lines holds one row
FRAMES_PER_LINE = 25  # lane B's 500-frame flight: 20 lines x 25 frames, alternating east / west


@dataclass(frozen=True)
class _Block:
    """Consecutive rows of one photo, listed bottom row first (bottom = west end on the ground)."""

    photo: str
    rows: tuple[int, ...]  # image rows, descending
    positive_row: int | None = None


def build_block_survey(
    images: Sequence[LabeledImageLike],
    n_frames: int = 500,
    n_positive: int = 6,
    seed: int = 7,
    survey_dir: Path = Path("data/survey"),
    frames_per_line: int = FRAMES_PER_LINE,
) -> tuple[list[FrameSpec], dict[str, list[BoxLike]]]:
    """Like `build_survey`, but crops of the same photo keep their arrangement on the ground.

    The flight is bands of `BLOCK_LINES` lines. A photo row (4 crops) fills one position across a
    band: crop column c goes on line `band * 4 + c` (image right = south). Consecutive rows of one
    photo fill consecutive positions, the image's top towards the east. So within a block the
    ground layout matches the photo on both flight directions (on westbound lines each crop is shown
    rotated 180 degrees, as every frame on those lines is).

    Only rows whose 4 crops are all negative are used, plus `n_positive` rows holding exactly one
    positive crop (one per photo), each with the negative rows above it. Blocks are shuffled, so the
    positives land at random places. Ambiguous crops (a person cut by the crop edge) are never used.
    """
    per_band = BLOCK_LINES * frames_per_line
    if n_frames % per_band:
        raise ValueError(f"the block layout needs n_frames to be a multiple of {per_band}")
    n_bands = n_frames // per_band
    rng = random.Random(seed)

    # Label every crop, then classify each photo row.
    cut = cut_frames(sorted(images, key=lambda image: image.path.name))
    crops: dict[tuple[str, int, int], tuple[FrameLabel, list[BoxLike]]] = {}
    rows_of: dict[str, int] = {}
    for c, label, boxes in cut:
        col, row = c.x0 // FRAME_W, c.y0 // FRAME_H
        crops[(c.source_image, col, row)] = (label, boxes)
        rows_of[c.source_image] = max(rows_of.get(c.source_image, 0), row + 1)

    def row_kind(photo: str, row: int) -> str:
        labels = [crops.get((photo, col, row), ("missing", []))[0] for col in range(BLOCK_LINES)]
        if all(lab == "negative" for lab in labels):
            return "negative"
        if labels.count("positive") == 1 and labels.count("negative") == BLOCK_LINES - 1:
            return "positive"
        return "unusable"

    photos = sorted(rows_of)
    kinds = {(p, r): row_kind(p, r) for p in photos for r in range(rows_of[p])}

    # Positive blocks: one positive row per photo, plus the negative rows directly above it.
    candidates = [p for p in photos if any(kinds[(p, r)] == "positive" for r in range(rows_of[p]))]
    if len(candidates) < n_positive:
        raise ValueError(
            f"need {n_positive} photos with a usable positive row, found {len(candidates)}"
        )
    used: set[tuple[str, int]] = set()
    positive_blocks: list[_Block] = []
    for photo in rng.sample(candidates, n_positive):
        row = rng.choice([r for r in range(rows_of[photo]) if kinds[(photo, r)] == "positive"])
        rows = [row]
        while rows[-1] - 1 >= 0 and kinds[(photo, rows[-1] - 1)] == "negative":
            rows.append(rows[-1] - 1)
        used.update((photo, r) for r in rows)
        positive_blocks.append(_Block(photo, tuple(rows), positive_row=row))

    # Negative blocks: maximal runs of consecutive negative rows not already used.
    negative_blocks: list[_Block] = []
    for photo in photos:
        run: list[int] = []
        for r in range(rows_of[photo]):
            if kinds[(photo, r)] == "negative" and (photo, r) not in used:
                run.append(r)
            else:
                if run:
                    negative_blocks.append(_Block(photo, tuple(reversed(run))))
                run = []
        if run:
            negative_blocks.append(_Block(photo, tuple(reversed(run))))
    rng.shuffle(negative_blocks)

    # Insert the positives at random places, but before the last negative block needed to fill the
    # flight, so they are always placed. Then fill the bands west to east.
    need = n_bands * frames_per_line
    have, m = sum(len(b.rows) for b in positive_blocks), 0
    while m < len(negative_blocks) and have < need:
        have += len(negative_blocks[m].rows)
        m += 1
    sequence = list(negative_blocks)
    for block in positive_blocks:
        sequence.insert(rng.randint(0, max(0, m - 1)), block)
        m += 1

    placed: list[tuple[int, int, str, int]] = []  # (band, position, photo, row)
    band, pos = 0, 0
    placed_positive = 0
    for block in sequence:
        if band == n_bands:
            break
        rows = block.rows[: frames_per_line - pos]  # keep the west (bottom) end if it must be cut
        placed_positive += block.positive_row in rows
        for row in rows:
            placed.append((band, pos, block.photo, row))
            pos += 1
        if pos == frames_per_line:
            band, pos = band + 1, 0
    if band < n_bands:
        raise ValueError("not enough person-free photo rows to fill the flight")
    if placed_positive != n_positive:
        raise ValueError("a positive block could not be placed")

    # Every placed row becomes 4 frames, one per line of its band; ids follow the flight order.
    specs: list[tuple[int, str, int, int]] = []
    for b, p, photo, row in placed:
        for col in range(BLOCK_LINES):
            line = b * BLOCK_LINES + col
            k = p if line % 2 == 0 else frames_per_line - 1 - p
            specs.append((line * frames_per_line + k, photo, col, row))
    specs.sort()

    frames: list[FrameSpec] = []
    truth: dict[str, list[BoxLike]] = {}
    for flight_index, photo, col, row in specs:
        frame_id = f"f{flight_index + 1:04d}"
        label, boxes = crops[(photo, col, row)]
        path = survey_dir / "frames" / f"{frame_id}.jpg"
        frames.append(FrameSpec(frame_id, flight_index, photo, col * FRAME_W, row * FRAME_H, path))
        truth[frame_id] = list(boxes) if label == "positive" else []
    return frames, truth


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
