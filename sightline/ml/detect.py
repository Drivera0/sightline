"""The person detector (docs/LANE_A_ML.md §5).

torch / ultralytics / sahi are imported lazily so this module imports on CPU-only machines
without the ``ml`` extra; calling the methods there raises a clear error.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sightline.ml.types import Box, RawDetection

PERSON_CLASS = 0  # COCO "person" for stock weights; the only class for our single-class weights


def _require(module: str) -> Any:
    try:
        return __import__(module)
    except ImportError as e:  # pragma: no cover - depends on the environment
        raise ImportError(
            f"{module} is not installed. Lane A detection needs the ml extra: `uv sync --extra ml` "
            f"(or pip install torch ultralytics sahi)."
        ) from e


def resolve_device(device: str = "auto") -> str:
    """``"auto"`` → ``"cuda:0"`` if a CUDA GPU is available, else ``"mps"`` (Apple silicon), else
    ``"cpu"``. Any other value is returned unchanged."""
    if device != "auto":
        return device
    torch = _require("torch")
    if torch.cuda.is_available():
        return "cuda:0"
    mps = getattr(getattr(torch, "backends", None), "mps", None)
    if mps is not None and mps.is_available():
        return "mps"
    return "cpu"


class Detector:
    """One set of YOLO weights with three inference modes."""

    def __init__(self, weights: Path, device: str = "auto", imgsz: int = 1024) -> None:
        self.weights = Path(weights)
        self.device = resolve_device(device)
        self.imgsz = imgsz
        ultralytics = _require("ultralytics")
        if not self.weights.exists():
            raise FileNotFoundError(self.weights)
        self.model = ultralytics.YOLO(str(self.weights))
        self._sahi_model: Any = None
        self._sahi_conf: float | None = None

    # ------------------------------------------------------------------ single pass

    def _predict(self, image: Path, conf: float, imgsz: int) -> list[RawDetection]:
        results = self.model.predict(
            str(image),
            imgsz=imgsz,
            conf=conf,
            device=self.device,
            classes=[PERSON_CLASS],
            verbose=False,
        )
        result = results[0]
        width, height = result.orig_shape[1], result.orig_shape[0]
        dets: list[RawDetection] = []
        if result.boxes is None or len(result.boxes) == 0:
            return dets
        xyxy = result.boxes.xyxy.cpu().numpy()
        confs = result.boxes.conf.cpu().numpy()
        for (x1, y1, x2, y2), c in zip(xyxy, confs, strict=True):
            box = _int_box(x1, y1, x2, y2, width, height)
            if box is not None:
                dets.append(RawDetection(box=box, conf=float(c)))
        return _sorted(dets)

    def detect_frame(self, image: Path, conf: float = 0.05) -> list[RawDetection]:
        """One pass at native size. For demo frames (1000×750), which fit in one 1024 tile."""
        return self._predict(image, conf, self.imgsz)

    def detect_resized(self, image: Path, conf: float = 0.05) -> list[RawDetection]:
        """Whole image resized so its long side is ``imgsz`` (1024), one pass: a 60 px person
        in a 4000 px photo becomes about 15 px. Only for the 'no tiling' ablation rows."""
        return self._predict(image, conf, self.imgsz)

    # ------------------------------------------------------------------ tiled

    def _sahi(self, conf: float) -> Any:
        if self._sahi_model is None or self._sahi_conf != conf:
            sahi = _require("sahi")
            self._sahi_model = sahi.AutoDetectionModel.from_pretrained(
                model_type="ultralytics",
                model_path=str(self.weights),
                confidence_threshold=conf,
                device=self.device,
                image_size=self.imgsz,
            )
            self._sahi_conf = conf
        return self._sahi_model

    def detect_tiled(
        self, image: Path, conf: float = 0.05, slice_px: int = 1024, overlap: float = 0.2
    ) -> list[RawDetection]:
        """SAHI sliced inference for full 4000×3000 images; boxes merged with NMS at IoU 0.5."""
        from sahi.predict import get_sliced_prediction

        result = get_sliced_prediction(
            str(image),
            self._sahi(conf),
            slice_height=slice_px,
            slice_width=slice_px,
            overlap_height_ratio=overlap,
            overlap_width_ratio=overlap,
            perform_standard_pred=False,
            postprocess_type="NMS",
            postprocess_match_metric="IOU",
            postprocess_match_threshold=0.5,
            verbose=0,
        )
        width, height = result.image_width, result.image_height
        dets: list[RawDetection] = []
        for pred in result.object_prediction_list:
            if pred.category.id != PERSON_CLASS:
                continue
            x1, y1, x2, y2 = pred.bbox.to_xyxy()
            box = _int_box(x1, y1, x2, y2, width, height)
            if box is not None:
                dets.append(RawDetection(box=box, conf=float(pred.score.value)))
        return _sorted(dets)


def _int_box(x1: float, y1: float, x2: float, y2: float, width: int, height: int) -> Box | None:
    """Round to ints, clip to the image, drop anything degenerate."""
    ix1, iy1 = max(0, round(x1)), max(0, round(y1))
    ix2, iy2 = min(width, round(x2)), min(height, round(y2))
    if ix2 <= ix1 or iy2 <= iy1:
        return None
    return Box(ix1, iy1, ix2, iy2)


def _sorted(dets: list[RawDetection]) -> list[RawDetection]:
    return sorted(dets, key=lambda d: d.conf, reverse=True)
