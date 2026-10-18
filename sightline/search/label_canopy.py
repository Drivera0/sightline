"""Prepare 20 HERIDAL crops for hand-labelling canopy (lane C, §6.2).

The script picks varied 1000×750 crops, writes an empty labels file and a
contact sheet. A human fills in the canopy scores; this code never does.

Run: ``uv run python -m sightline.search.label_canopy``
"""

from __future__ import annotations

import argparse
import html
import json
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_IMAGES = Path("data/heridal/yolo_full/test/images")
DEFAULT_LABELS = Path("data/heridal/yolo_full/test/labels")
DEFAULT_OUT = Path("tests/search/fixtures/canopy_labels.json")
DEFAULT_WORK = Path("data/work/canopy_labels")
DEFAULT_SEED = 7
CROP_W_PX = 1000
CROP_H_PX = 750
STATS_SCALE = 4
DARK_THR = 60
NOTE = (
    "Hand labels: fraction of each crop that is tree canopy or deep shadow, scored by eye "
    "as 0, 0.25, 0.5, 0.75 or 1. Fill in canopy; null = not labelled yet. "
    "Crops from HERIDAL test images (CC BY 3.0)."
)
NEXT_STEP = (
    "Open data/work/canopy_labels/index.html, fill in canopy in "
    "tests/search/fixtures/canopy_labels.json, then run "
    "uv run python -m sightline.search.tune_canopy"
)


@dataclass(frozen=True)
class Crop:
    """One candidate crop of a source image, in full-resolution pixels."""

    image: str
    x0: int
    y0: int
    width_px: int = CROP_W_PX
    height_px: int = CROP_H_PX


# List the non-overlapping crop origins that fit inside an image.
def crop_origins(
    width_px: int, height_px: int, crop_w_px: int = CROP_W_PX, crop_h_px: int = CROP_H_PX
) -> list[tuple[int, int]]:
    """Return ``(x0, y0)`` for every whole crop of a regular grid, row by row."""
    return [
        (x0, y0)
        for y0 in range(0, height_px - crop_h_px + 1, crop_h_px)
        for x0 in range(0, width_px - crop_w_px + 1, crop_w_px)
    ]


# Read person box centres from a YOLO label file, in full-resolution pixels.
def person_centres(label_path: Path, width_px: int, height_px: int) -> list[tuple[float, float]]:
    """Return ``(u, v)`` box centres; a missing file means no people."""
    if not label_path.exists():
        return []
    centres = []
    for line in label_path.read_text().splitlines():
        parts = line.split()
        if len(parts) >= 5:
            centres.append((float(parts[1]) * width_px, float(parts[2]) * height_px))
    return centres


# Check whether any person centre falls inside a crop.
def crop_has_person(
    x0: int, y0: int, width_px: int, height_px: int, centres: Sequence[tuple[float, float]]
) -> bool:
    """True if a centre lies in ``[x0, x0 + width) × [y0, y0 + height)``."""
    return any(x0 <= u < x0 + width_px and y0 <= v < y0 + height_px for u, v in centres)


# Compute cheap terrain stats for one RGB crop.
def crop_stats(rgb: np.ndarray, dark_thr: int = DARK_THR) -> tuple[float, float, float]:
    """Return ``(mean ExG, dark-pixel fraction, mean grey gradient magnitude)``.

    ``rgb`` is an H×W×3 uint8 array. ExG = 2g − r − b on normalised colour; a
    pixel is dark when max(R, G, B) < ``dark_thr``; texture is the mean absolute
    difference between neighbouring grey pixels on a 0–255 scale.
    """
    arr = rgb.astype(np.float64)
    total = arr.sum(axis=2)
    total[total == 0] = 1.0
    r, g, b = (arr[..., i] / total for i in range(3))
    exg = float(np.mean(2 * g - r - b))
    dark = float(np.mean(rgb.max(axis=2) < dark_thr))
    grey = arr @ np.array([0.299, 0.587, 0.114])
    dx = np.abs(np.diff(grey, axis=1)).mean() if grey.shape[1] > 1 else 0.0
    dy = np.abs(np.diff(grey, axis=0)).mean() if grey.shape[0] > 1 else 0.0
    return exg, dark, float((dx + dy) / 2)


# Map each stats column to percentile ranks in [0, 1].
def rank_normalise(stats: np.ndarray) -> np.ndarray:
    """Rank-normalise each column so outliers don't dominate distances."""
    n = stats.shape[0]
    if n < 2:
        return np.zeros_like(stats, dtype=np.float64)
    ranks = np.argsort(np.argsort(stats, axis=0, kind="stable"), axis=0, kind="stable")
    return ranks.astype(np.float64) / (n - 1)


# Pick varied rows with seeded farthest-point sampling.
def select_crops(
    stats: np.ndarray,
    groups: Sequence[str],
    count: int = 20,
    max_per_group: int = 2,
    exclude: Sequence[bool] | None = None,
    seed: int = DEFAULT_SEED,
) -> list[int]:
    """Return ``count`` row indices that spread out over the stats space.

    Rows marked in ``exclude`` are never picked, and at most ``max_per_group``
    rows share a group (source image). Raises ``ValueError`` if too few rows
    are eligible.
    """
    n = stats.shape[0]
    if len(groups) != n:
        raise ValueError("groups must have one entry per stats row")
    eligible = np.ones(n, dtype=bool) if exclude is None else ~np.asarray(exclude, dtype=bool)
    points = rank_normalise(stats[eligible]) if eligible.any() else stats[eligible]
    full = np.zeros((n, stats.shape[1]))
    full[eligible] = points

    rng = np.random.default_rng(seed)
    per_group: dict[str, int] = {}
    chosen: list[int] = []
    min_dist = np.full(n, np.inf)

    def allowed() -> np.ndarray:
        ok = eligible.copy()
        for i in chosen:
            ok[i] = False
        for i in range(n):
            if per_group.get(groups[i], 0) >= max_per_group:
                ok[i] = False
        return ok

    while len(chosen) < count:
        ok = allowed()
        if not ok.any():
            raise ValueError(f"only {len(chosen)} eligible crops, {count} requested")
        if not chosen:
            pick = int(rng.choice(np.flatnonzero(ok)))
        else:
            score = np.where(ok, min_dist, -np.inf)
            pick = int(np.argmax(score))
        chosen.append(pick)
        per_group[groups[pick]] = per_group.get(groups[pick], 0) + 1
        min_dist = np.minimum(min_dist, np.linalg.norm(full - full[pick], axis=1))
    return chosen


# Build the labels document for the chosen crops.
def build_labels(crops: Sequence[Crop]) -> dict:
    """Return the ``canopy_labels.json`` document with every canopy left null."""
    frames = [
        {
            "id": f"c{i:02d}",
            "image": crop.image,
            "x0": crop.x0,
            "y0": crop.y0,
            "width_px": crop.width_px,
            "height_px": crop.height_px,
            "canopy": None,
        }
        for i, crop in enumerate(crops, start=1)
    ]
    return {"version": 1, "note": NOTE, "frames": frames}


# Check whether a labels file already holds human scores.
def has_labels(path: Path) -> bool:
    """True if ``path`` exists and any frame has a non-null canopy."""
    if not path.exists():
        return False
    doc = json.loads(path.read_text())
    return any(frame.get("canopy") is not None for frame in doc.get("frames", []))


# Write the labels file without destroying human scores.
def write_labels(path: Path, doc: dict, force: bool = False) -> None:
    """Write ``doc`` as JSON; refuse to overwrite filled-in labels unless ``force``."""
    if has_labels(path) and not force:
        raise FileExistsError(f"{path} already has canopy scores; use --force to overwrite")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(doc, indent=2) + "\n")


def _load_reduced(path: Path) -> tuple[Image.Image, int, int]:
    """Open a JPEG at about 1/``STATS_SCALE`` size; return it with the full size."""
    with Image.open(path) as img:
        width_px, height_px = img.size
        img.draft("RGB", (width_px // STATS_SCALE, height_px // STATS_SCALE))
        small = img.convert("RGB")
    return small, width_px, height_px


def _candidates(images_dir: Path, labels_dir: Path) -> tuple[list[Crop], np.ndarray, list[bool]]:
    """Return every grid crop, its stats and whether it contains a person."""
    crops: list[Crop] = []
    rows: list[tuple[float, float, float]] = []
    people: list[bool] = []
    for path in sorted(images_dir.glob("*.jpg")):
        small, width_px, height_px = _load_reduced(path)
        scale = small.width / width_px
        arr = np.asarray(small)
        centres = person_centres(labels_dir / f"{path.stem}.txt", width_px, height_px)
        image = (path if not path.is_absolute() else path.relative_to(REPO_ROOT)).as_posix()
        for x0, y0 in crop_origins(width_px, height_px):
            sx0, sy0 = round(x0 * scale), round(y0 * scale)
            sx1, sy1 = round((x0 + CROP_W_PX) * scale), round((y0 + CROP_H_PX) * scale)
            crops.append(Crop(image=image, x0=x0, y0=y0))
            rows.append(crop_stats(arr[sy0:sy1, sx0:sx1]))
            people.append(crop_has_person(x0, y0, CROP_W_PX, CROP_H_PX, centres))
    return crops, np.array(rows, dtype=np.float64), people


def _font(size: int) -> ImageFont.ImageFont | ImageFont.FreeTypeFont:
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def _write_work_files(doc: dict, work_dir: Path, root: Path) -> None:
    """Save each crop full size, a 5×4 contact sheet and a static index page."""
    work_dir.mkdir(parents=True, exist_ok=True)
    tile_w, tile_h, cols = 400, 300, 5
    frames = doc["frames"]
    rows = (len(frames) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * tile_w, rows * tile_h), "black")
    draw = ImageDraw.Draw(sheet)
    font = _font(56)
    for k, frame in enumerate(frames):
        box = (
            frame["x0"],
            frame["y0"],
            frame["x0"] + frame["width_px"],
            frame["y0"] + frame["height_px"],
        )
        with Image.open(root / frame["image"]) as img:
            crop = img.convert("RGB").crop(box)
        crop.save(work_dir / f"{frame['id']}.jpg", quality=92)
        tx, ty = (k % cols) * tile_w, (k // cols) * tile_h
        sheet.paste(crop.resize((tile_w, tile_h), Image.Resampling.BILINEAR), (tx, ty))
        draw.text(
            (tx + 10, ty + 6),
            frame["id"],
            fill="yellow",
            font=font,
            stroke_width=4,
            stroke_fill="black",
        )
    sheet.save(work_dir / "contact_sheet.jpg", quality=90)

    items = "\n".join(
        f"<section><h2>{html.escape(f['id'])}</h2>"
        f"<p>{html.escape(f['image'])} at x0={f['x0']}, y0={f['y0']}</p>"
        f'<img src="{html.escape(f["id"])}.jpg" alt="{html.escape(f["id"])}"></section>'
        for f in frames
    )
    page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Canopy labels</title>
<style>body{{font-family:sans-serif;margin:16px;background:#fff;color:#111}}
img{{width:100%;height:auto}}section{{margin-bottom:32px}}</style></head>
<body><h1>Canopy labels</h1>
<p>Score each crop by eye: the fraction that is tree canopy or deep shadow.
Use 0, 0.25, 0.5, 0.75 or 1 (0 = no trees or shadow &hellip; 1 = all trees or shadow).
Write the score in <code>tests/search/fixtures/canopy_labels.json</code>.</p>
<p><img src="contact_sheet.jpg" alt="contact sheet"></p>
{items}
</body></html>
"""
    (work_dir / "index.html").write_text(page)


def main(argv: Sequence[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--images", type=Path, default=DEFAULT_IMAGES)
    parser.add_argument("--labels", type=Path, default=DEFAULT_LABELS)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--work", type=Path, default=DEFAULT_WORK)
    parser.add_argument("--count", type=int, default=20)
    parser.add_argument("--max-per-image", type=int, default=2)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--force", action="store_true", help="overwrite filled-in labels")
    args = parser.parse_args(argv)

    if has_labels(args.out) and not args.force:
        raise SystemExit(f"{args.out} already has canopy scores; use --force to overwrite")
    crops, stats, people = _candidates(args.images, args.labels)
    if not crops:
        raise SystemExit(f"no images found in {args.images}")
    groups = [c.image for c in crops]
    picks = select_crops(stats, groups, args.count, args.max_per_image, people, args.seed)
    doc = build_labels([crops[i] for i in picks])
    write_labels(args.out, doc, force=args.force)
    _write_work_files(doc, args.work, Path.cwd())

    print(f"{len(crops)} candidate crops, {sum(people)} skipped (person inside)")
    for frame, i in zip(doc["frames"], picks, strict=True):
        exg, dark, tex = stats[i]
        print(
            f"  {frame['id']}  exg={exg:+.3f} dark={dark:.2f} texture={tex:5.1f}  "
            f"{Path(frame['image']).name} ({frame['x0']},{frame['y0']})"
        )
    print(f"Labels file:   {args.out}")
    print(f"Contact sheet: {args.work / 'contact_sheet.jpg'}")
    print(f"Crops:         {args.work}/c01.jpg ... c{len(picks):02d}.jpg")
    print(f"Index page:    {args.work / 'index.html'}")
    print(f"Next: {NEXT_STEP}")


if __name__ == "__main__":
    main()
