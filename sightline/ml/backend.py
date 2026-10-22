"""Which detector the pipeline runs (docs/LANE_A_SPRINT.md §5.2).

``SIGHTLINE_BACKEND=cv2`` (the default) runs the ONNX export through OpenCV 5's ``cv2.dnn``
(``CvDetector``); ``torch`` runs the same weights through Ultralytics + SAHI (``Detector``).
Both have ``detect_tiled``, which the pipeline calls on full-size photos. ``fake`` (smoke test,
no model files) returns two fixed boxes on every photo (``sightline/ml/fake.py``).

``SIGHTLINE_DETECT_URL`` (unset by default) sends the cv2 path to a detector served over HTTP
instead (``RemoteDetector``, sightline/ml/remote.py; the Nebius Serverless Endpoint of
deploy/nebius/ENDPOINT.md), with ``SIGHTLINE_DETECT_TOKEN`` as its bearer token. ``torch`` and
``fake`` ignore it.

If cv2 is asked for but no ONNX file exists, this falls back to Torch with a warning, and fails
with one error naming every path it tried when Torch can't run either.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from sightline.ml.detect import Detector
from sightline.ml.detect_cv import CvDetector
from sightline.ml.fake import FakeDetector
from sightline.ml.remote import RemoteDetector

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parents[2]
BACKENDS = ("cv2", "torch", "fake")  # fake: smoke test and demos without model files
DEFAULT_BACKEND = "cv2"
# web/scripts/fetch-model.sh downloads the release `model-onnx-v2` export here.
DEFAULT_ONNX = ROOT / "web/public/models/sightline-detector-v2.onnx"
DEFAULT_WEIGHTS = ROOT / "data/weights/release_v2/yolo11s_tiles_run1_best.pt"


def _abs(p: Path | str) -> Path:
    p = Path(p)
    return p if p.is_absolute() else ROOT / p


def onnx_candidates(onnx: Path | None, weights: Path | None) -> list[Path]:
    """Where to look for the ONNX export, first match wins: the argument, ``SIGHTLINE_ONNX``,
    the variable-size export next to the weights (``<stem>-dynamic.onnx``), the fixed-size one
    (``<stem>.onnx``, the release_v2 folder ships it), then ``DEFAULT_ONNX``."""
    if onnx is not None:
        return [_abs(onnx)]
    out = []
    if env := os.environ.get("SIGHTLINE_ONNX"):
        out.append(_abs(env))
    if weights is not None:
        pt = _abs(weights)
        out.append(pt.with_name(f"{pt.stem}-dynamic.onnx"))  # scripts/export_onnx.py
        out.append(pt.with_suffix(".onnx"))
    out.append(DEFAULT_ONNX)
    return list(dict.fromkeys(out))  # each path once, first position kept


def make_detector(
    *, weights: Path | None = None, onnx: Path | None = None, backend: str | None = None
) -> Detector | CvDetector | FakeDetector | RemoteDetector:
    """The detector for ``backend`` (default: env ``SIGHTLINE_BACKEND``, else ``"cv2"``).

    ``weights`` is the Torch ``.pt`` (default: ``SIGHTLINE_WEIGHTS``, else ``DEFAULT_WEIGHTS``);
    ``onnx`` is the cv2 export (see ``onnx_candidates``).
    """
    backend = (backend or os.environ.get("SIGHTLINE_BACKEND") or DEFAULT_BACKEND).lower()
    if backend not in BACKENDS:
        raise ValueError(f"SIGHTLINE_BACKEND must be one of {BACKENDS}, got {backend!r}")
    pt = _abs(weights or os.environ.get("SIGHTLINE_WEIGHTS") or DEFAULT_WEIGHTS)

    if backend == "fake":
        from sightline.ml.fake import FakeDetector

        return FakeDetector()
    if backend == "torch":
        return Detector(pt)

    if os.environ.get("SIGHTLINE_DETECT_URL"):
        return RemoteDetector.from_env()

    tried = onnx_candidates(onnx, pt)
    found = next((p for p in tried if p.is_file()), None)
    if found is not None:
        return CvDetector(found)

    where = ", ".join(str(p) for p in tried)
    log.warning("cv2 backend: no ONNX at %s; falling back to torch (%s)", where, pt)
    try:
        return Detector(pt)
    except (FileNotFoundError, ImportError) as e:
        raise FileNotFoundError(
            f"cv2 backend: no ONNX export at {where} (run `bash web/scripts/fetch-model.sh` or set "
            f"SIGHTLINE_ONNX), and the torch fallback failed: {e}"
        ) from e
