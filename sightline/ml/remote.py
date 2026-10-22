"""``SIGHTLINE_DETECT_URL``: the detector behind HTTP (the Nebius Serverless Endpoint,
``sightline/serve/detect_app.py``) instead of in this process.

``RemoteDetector`` has the same ``detect_tiled(image, conf)`` as ``CvDetector``, so the mission
worker and the agent's re-detection use it unchanged. A photo on disk is sent as its own bytes
(no re-encode: the server decodes the same pixels ``cv2.imread`` would); pixels already in memory
(the re-look's crops) go as lossless PNG. ``SIGHTLINE_DETECT_TOKEN`` is sent as a bearer token.
A failed request raises; the pipeline already turns a detector error into a frame with no
detections and a note, so the photo is never lost.
"""

from __future__ import annotations

import os
from pathlib import Path

import cv2
import httpx
import numpy as np

from sightline.ml.types import Box, RawDetection

DEFAULT_TIMEOUT_S = 120.0  # a 4000x3000 photo is 20 slices; a small CPU endpoint needs seconds


class RemoteDetector:
    def __init__(
        self,
        url: str,
        token: str | None = None,
        timeout_s: float = DEFAULT_TIMEOUT_S,
        client: httpx.Client | None = None,
    ) -> None:
        self.url = url.rstrip("/")
        self.token = token
        self.client = client or httpx.Client(timeout=timeout_s)

    @classmethod
    def from_env(cls) -> RemoteDetector:
        url = os.environ["SIGHTLINE_DETECT_URL"]
        timeout = float(os.environ.get("SIGHTLINE_DETECT_TIMEOUT_S") or DEFAULT_TIMEOUT_S)
        return cls(url, token=os.environ.get("SIGHTLINE_DETECT_TOKEN") or None, timeout_s=timeout)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    def health(self) -> dict:
        r = self.client.get(f"{self.url}/healthz", headers=self._headers())
        r.raise_for_status()
        return r.json()

    def detect_tiled(
        self, image: Path | str | np.ndarray, conf: float = 0.05, **_: object
    ) -> list[RawDetection]:
        if isinstance(image, np.ndarray):
            ok, buf = cv2.imencode(".png", image)
            if not ok:
                raise ValueError("could not encode the pixels as PNG")
            name, body, mime = "pixels.png", buf.tobytes(), "image/png"
        else:
            p = Path(image)
            name, body = p.name, p.read_bytes()
            mime = "image/png" if p.suffix.lower() == ".png" else "image/jpeg"
        r = self.client.post(
            f"{self.url}/detect",
            params={"conf": conf},
            files={"photo": (name, body, mime)},
            headers=self._headers(),
        )
        r.raise_for_status()
        out = [RawDetection(Box(*map(int, b["box"])), float(b["conf"])) for b in r.json()["boxes"]]
        return sorted(out, key=lambda d: d.conf, reverse=True)

    def detect_array(self, img_bgr: np.ndarray, conf: float = 0.05) -> list[RawDetection]:
        return self.detect_tiled(img_bgr, conf)
