"""OpenCV 5 re-look tools for the verifier (docs/LANE_A_SPRINT.md §4, §5.5; A-V1).

When the detector isn't sure, these give the Nemotron VL model a better look at the spot than the
original crop. One tool per failure mode in docs/DETECTOR_LIMITS.md §2:

- clothing that matches the ground (white on limestone, dark on dark rock) → ``enhance_contrast``;
- a person too small to read in the frame → ``zoom_native`` from the original photo's pixels;
- people close together, sitting or lying → ``redetect_region``: the detector again on a native
  window and on a 2× upscale (a second box, or a reshaped one, is evidence).

The tools are pure (pixels in, pixels or boxes out). ``save`` stores an image through
``MissionStore.put_file`` and returns its path for ``Verdict.relook_crops`` and the trace.
"""

from __future__ import annotations

from typing import Any, Protocol

import cv2
import numpy as np

from sightline.ml.detect_cv import merge_slices, offset
from sightline.ml.types import RawDetection

Xyxy = tuple[float, float, float, float]

TOOLS_FOR: dict[str, list[str]] = {
    "low_contrast": ["enhance_contrast"],
    "small": ["zoom_native"],
    "group_or_lying": ["redetect_region"],
}

MIN_ZOOM_SIDE = 32  # px of the original; below this a zoom shows nothing but interpolation
BOX_COLOUR = (0, 255, 255)  # BGR yellow, visible on rock, grass and snow


class ArrayDetector(Protocol):
    def detect_array(self, img_bgr: np.ndarray, conf: float = 0.05) -> list[RawDetection]: ...


def to_orig(
    box_px_frame: Xyxy,
    frame_wh: tuple[int, int],
    orig_wh: tuple[int, int],
    origin: tuple[int, int] = (0, 0),
) -> tuple[int, int, int, int]:
    """A box in frame pixels mapped to the original photo: scaled by ``orig / frame`` (a frame
    downscaled from the photo), then shifted by ``origin`` (a frame cut from a larger photo at
    ``Frame.source.x0, y0``)."""
    sx, sy = orig_wh[0] / frame_wh[0], orig_wh[1] / frame_wh[1]
    x1, y1, x2, y2 = box_px_frame
    ox, oy = origin
    return (
        round(x1 * sx) + ox,
        round(y1 * sy) + oy,
        round(x2 * sx) + ox,
        round(y2 * sy) + oy,
    )


def square_window(box: Xyxy, side: int, width: int, height: int) -> tuple[int, int, int, int]:
    """A ``side`` px square centred on ``box``, moved (not cut) to fit inside the image; only an
    image smaller than ``side`` shrinks it."""
    side_x, side_y = min(side, width), min(side, height)
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    x1 = int(min(max(0, round(cx - side_x / 2)), width - side_x))
    y1 = int(min(max(0, round(cy - side_y / 2)), height - side_y))
    return x1, y1, x1 + side_x, y1 + side_y


def zoom_window(
    box: Xyxy, width: int, height: int, context: float = 2.5
) -> tuple[int, int, int, int]:
    """The square ``zoom_native`` cuts: ``context`` × the box's long side, at least
    ``MIN_ZOOM_SIDE``, and never larger than the image's short side, so it stays square."""
    long_side = max(box[2] - box[0], box[3] - box[1])
    side = min(max(MIN_ZOOM_SIDE, round(long_side * context)), width, height)
    return square_window(box, side, width, height)


def enhance_contrast(crop_bgr: np.ndarray, clip: float = 2.0, tiles: int = 8) -> np.ndarray:
    """CLAHE on the L channel (LAB) so colour is kept, then a light unsharp mask."""
    lab = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2LAB)
    l_chan, a_chan, b_chan = cv2.split(lab)
    l_chan = cv2.createCLAHE(clipLimit=clip, tileGridSize=(tiles, tiles)).apply(l_chan)
    out = cv2.cvtColor(cv2.merge((l_chan, a_chan, b_chan)), cv2.COLOR_LAB2BGR)
    blurred = cv2.GaussianBlur(out, (0, 0), sigmaX=1.0)
    return cv2.addWeighted(out, 1.5, blurred, -0.5, 0)


def zoom_native(
    orig_bgr: np.ndarray,
    box_px_orig: Xyxy,
    out_px: int = 384,
    context: float = 2.5,
) -> np.ndarray:
    """A square of ``context`` × the box's long side around it, cut from the original photo and
    resized to ``out_px`` (INTER_CUBIC up, INTER_AREA down)."""
    height, width = orig_bgr.shape[:2]
    x1, y1, x2, y2 = zoom_window(box_px_orig, width, height, context)
    window = orig_bgr[y1:y2, x1:x2]
    interp = cv2.INTER_CUBIC if out_px >= max(window.shape[:2]) else cv2.INTER_AREA
    return cv2.resize(window, (out_px, out_px), interpolation=interp)


def redetect_region(
    detector: ArrayDetector,
    orig_bgr: np.ndarray,
    box_px_orig: Xyxy,
    window_px: int = 1024,
    upscale: float = 2.0,
    conf: float = 0.05,
) -> list[RawDetection]:
    """The detector again around the box, in original-photo pixels, two passes merged like
    tiling (NMS 0.5):

    1. a ``window_px`` native window: one slice, so the box is seen without the frame's resize;
    2. the central ``window_px / upscale`` of it upscaled to ``window_px`` (INTER_CUBIC): people
       twice as large as the detector saw them, still one slice (two forward passes in all).
    """
    height, width = orig_bgr.shape[:2]
    nx1, ny1, nx2, ny2 = square_window(box_px_orig, window_px, width, height)
    native = detector.detect_array(orig_bgr[ny1:ny2, nx1:nx2], conf)

    ux1, uy1, ux2, uy2 = square_window(box_px_orig, round(window_px / upscale), width, height)
    small = orig_bgr[uy1:uy2, ux1:ux2]
    big = cv2.resize(
        small,
        (round(small.shape[1] * upscale), round(small.shape[0] * upscale)),
        interpolation=cv2.INTER_CUBIC,
    )
    sx, sy = small.shape[1] / big.shape[1], small.shape[0] / big.shape[0]
    upscaled = [
        ((d.box.x1 * sx, d.box.y1 * sy, d.box.x2 * sx, d.box.y2 * sy), d.conf)
        for d in detector.detect_array(big, conf)
    ]
    per_pass = [
        offset([((d.box.x1, d.box.y1, d.box.x2, d.box.y2), d.conf) for d in native], (nx1, ny1)),
        offset(upscaled, (ux1, uy1)),
    ]
    return merge_slices(per_pass, width, height)


def draw_boxes(
    orig_bgr: np.ndarray,
    box_px_orig: Xyxy,
    dets: list[RawDetection],
    out_px: int = 384,
    context: float = 2.5,
) -> np.ndarray:
    """``zoom_native`` of the spot with ``dets`` outlined: the image the VL model sees for
    ``redetect_region``. Draws on a copy of the window only, never on the photo."""
    height, width = orig_bgr.shape[:2]
    x1, y1, x2, _ = zoom_window(box_px_orig, width, height, context)
    scale = out_px / (x2 - x1)
    out = zoom_native(orig_bgr, box_px_orig, out_px, context).copy()
    for d in dets:
        p1 = (round((d.box.x1 - x1) * scale), round((d.box.y1 - y1) * scale))
        p2 = (round((d.box.x2 - x1) * scale), round((d.box.y2 - y1) * scale))
        cv2.rectangle(out, p1, p2, BOX_COLOUR, 2)
    return out


def save(store: Any, mission_id: str, detection_id: str, tool: str, img_bgr: np.ndarray) -> str:
    """JPEG-encode ``img_bgr`` to ``relook/<detection_id>-<tool>.jpg`` through
    ``store.put_file``; returns the path."""
    ok, buf = cv2.imencode(".jpg", img_bgr, [cv2.IMWRITE_JPEG_QUALITY, 92])
    if not ok:
        raise ValueError(f"could not encode the {tool} image for {detection_id}")
    return store.put_file(mission_id, f"relook/{detection_id}-{tool}.jpg", buf.tobytes())
