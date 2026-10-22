"""``SIGHTLINE_BACKEND=fake``: a detector for the smoke test and demos without the model files.

It finds nothing: it returns the same two boxes on every photo, one candidate (0.80) at the centre
and one near miss (0.20) beside it, so every pipeline path runs (crops, near-miss crops, hooks). Never
use it for numbers; ``/health`` reports ``"backend": "fake"`` so nobody mistakes it for the model.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np

from sightline.ml.types import Box, RawDetection


class FakeDetector:
    def detect_tiled(
        self, image: Path | np.ndarray, conf: float = 0.05, **_: object
    ) -> list[RawDetection]:
        if isinstance(image, np.ndarray):
            h, w = image.shape[:2]
        else:
            from PIL import Image

            with Image.open(image) as im:
                w, h = im.size
        cx, cy, s = w // 2, h // 2, max(8, min(w, h) // 50)
        out = [
            RawDetection(Box(cx - s, cy - s, cx + s, cy + 2 * s), 0.80),
            RawDetection(Box(cx + 4 * s, cy, cx + 6 * s, cy + 3 * s), 0.20),
        ]
        return [d for d in out if d.conf >= conf]
