"""Review-queue crops (docs/LANE_A_ML.md §5, 01_CONTRACT.md §7)."""

from __future__ import annotations

from pathlib import Path

from sightline.ml.types import Box


def crop_window(im, box, window_px: int = 128, out_px: int = 256):
    """``window_px`` square of the PIL RGB image ``im`` centred on ``box`` (``Box`` or x1, y1, x2,
    y2), padded with black at the image edges, upscaled to ``out_px`` square (a PIL image)."""
    from PIL import Image

    if isinstance(box, Box):
        cx, cy = box.center
    else:
        cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    half = window_px / 2
    left, top = round(cx - half), round(cy - half)
    canvas = Image.new("RGB", (window_px, window_px), (0, 0, 0))
    # Portion of the window that lies inside the image.
    sx1, sy1 = max(left, 0), max(top, 0)
    sx2, sy2 = min(left + window_px, im.width), min(top + window_px, im.height)
    if sx2 > sx1 and sy2 > sy1:
        canvas.paste(im.crop((sx1, sy1, sx2, sy2)), (sx1 - left, sy1 - top))
    return canvas.resize((out_px, out_px), Image.Resampling.BICUBIC)


def make_crop(image: Path, box: Box, out: Path, window_px: int = 128, out_px: int = 256) -> None:
    """``window_px`` square centred on the box centre, padded with black at the image edges,
    upscaled to ``out_px`` square, saved as JPEG quality 90."""
    from PIL import Image

    with Image.open(image) as im:
        crop = crop_window(im.convert("RGB"), box, window_px, out_px)
    out.parent.mkdir(parents=True, exist_ok=True)
    crop.save(out, "JPEG", quality=90)
