"""The person detector (docs/LANE_A_ML.md §5).

torch / ultralytics / sahi are imported lazily so this module imports on CPU-only machines
without the ``ml`` extra; calling the methods there raises a clear error.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from sightline.ml.types import Box, RawDetection

PERSON_CLASS = 0  # COCO "person" for stock weights; the only class for our single-class weights

# Tiled-inference defaults, kept after a sweep on the annotated **val** split only (95 photos,
# 333 people; scripts/tune_on_val.py, docs/LANE_A_ML.md §6.3a). 90 settings were tried: overlap
# 0.1/0.2/0.3 x NMS/NMM/GREEDYNMM x IOU/IOS x match 0.3-0.7, threshold re-chosen by max F2 each.
# These defaults: val F2 0.831 (P 0.735, R 0.859, AP50 0.861 at threshold 0.29). The best
# (overlap 0.1, NMS, IOU 0.5) reached val F2 0.846, but a paired bootstrap over val photos
# (2,000 resamples, seed 7) gave dF2 +0.015, 95 % CI [-0.007, +0.038]: not clearly better, so
# nothing changed. At overlap 0.2 every IOS setting had lower val AP50 (at most 0.850).
SLICE_PX = 1024
SLICE_OVERLAP = 0.2
MERGE_TYPE = "NMS"
MERGE_METRIC = "IOU"
MERGE_THRESHOLD = 0.5

# Test-time augmentation for tiled inference, adopted on val (scripts/tta_on_val.py,
# docs/LANE_A_ML.md §6.3a): the photo and its left-right mirror, each tiled and merged as above,
# then fused with weighted box fusion (IoU 0.55). Val F2 0.857 (P 0.797, R 0.874, AP50 0.889 at
# threshold 0.32) vs 0.831 without TTA; paired bootstrap dF2 +0.027, 95 % CI [+0.004, +0.048];
# 0.62 s per photo vs 0.32 s in the same measurement. Pooled NMS instead of WBF was not clearly
# better (dF2 +0.003); 4 and 8 views with WBF were clearly better but not better than 2 views, and
# 8 views took 2.4 s per photo. Scored once on test (threshold 0.32): P 0.835, R 0.858, AP50 0.872
# at 0.50 s vs single view P 0.802, R 0.864, AP50 0.868 at 0.25 s, within noise. The demo frames
# were detected single-view, so single view stays the default and the reported model; pass
# tta=("id", "hflip") for the mirror setting.
TTA_VIEWS: tuple[str, ...] = ("id",)
TTA_WBF_IOU = 0.55


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
        """Whole image resized so its long side is ``imgsz``, one pass, no slicing.

        At the default 1024 a 60 px person in a 4000 px photo becomes about 15 px (the
        "shrunk photo" ablation rows). ``Detector(..., imgsz=4000)`` runs the photo at native
        scale instead (letterboxed to 4000x3008), the fair no-tiling baseline for weights trained
        on full-resolution tiles (scripts/evaluate_no_tiling.py)."""
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

    def slice_predictions(
        self,
        image: Path | Any,
        conf: float = 0.05,
        slice_px: int = SLICE_PX,
        overlap: float = SLICE_OVERLAP,
    ) -> tuple[list[tuple[float, float, float, float, float]], int, int]:
        """SAHI sliced inference with **no** merge: every per-slice box in full-image pixels.

        ``image`` is a path or an RGB ``numpy`` array (used for test-time augmentation).
        Returns ``([(x1, y1, x2, y2, conf), ...], width, height)``. ``merge_slices`` turns this
        into the final detections, so a merge setting can be swept on val without re-running
        the model.
        """
        from sahi import predict as sahi_predict
        from sahi.predict import get_sliced_prediction

        sahi_predict.POSTPROCESS_NAME_TO_CLASS.setdefault(_NO_MERGE, _NoMerge)
        result = get_sliced_prediction(
            str(image) if isinstance(image, Path | str) else image,
            self._sahi(conf),
            slice_height=slice_px,
            slice_width=slice_px,
            overlap_height_ratio=overlap,
            overlap_width_ratio=overlap,
            perform_standard_pred=False,
            postprocess_type=_NO_MERGE,
            force_postprocess_type=True,
            verbose=0,
        )
        raw = [
            (*p.bbox.to_xyxy(), float(p.score.value))
            for p in result.object_prediction_list
            if p.category.id == PERSON_CLASS
        ]
        return raw, result.image_width, result.image_height

    def detect_tiled(
        self,
        image: Path,
        conf: float = 0.05,
        slice_px: int = SLICE_PX,
        overlap: float = SLICE_OVERLAP,
        merge: str = MERGE_TYPE,
        match_metric: str = MERGE_METRIC,
        match_threshold: float = MERGE_THRESHOLD,
        tta: tuple[str, ...] = TTA_VIEWS,
    ) -> list[RawDetection]:
        """SAHI sliced inference for full 4000×3000 images, slices merged with ``merge_slices``.

        With more than one ``tta`` view (names from ``sightline.ml.tta.TRANSFORMS``), each view
        of the photo is tiled and merged on its own, mapped back, and the views are fused with
        weighted box fusion; a box seen in one view of two keeps half its confidence.
        """
        if tuple(tta) == ("id",):
            raw, width, height = self.slice_predictions(image, conf, slice_px, overlap)
            return merge_slices(raw, width, height, merge, match_metric, match_threshold)

        import numpy as np
        from PIL import Image

        from sightline.ml.tta import boxes_back, to_float_boxes, transform_image
        from sightline.ml.tta import weighted_box_fusion as wbf

        with Image.open(image) as src:
            pixels = np.asarray(src.convert("RGB"))
        height, width = pixels.shape[:2]
        views = []
        for name in tta:
            raw, vw, vh = self.slice_predictions(
                transform_image(pixels, name), conf, slice_px, overlap
            )
            merged = merge_slices(raw, vw, vh, merge, match_metric, match_threshold)
            views.append(boxes_back(to_float_boxes(merged), name, width, height))
        dets: list[RawDetection] = []
        for x1, y1, x2, y2, c in wbf(views, TTA_WBF_IOU):
            if c < conf:  # fused confidence below the save threshold: dropped, as in one view
                continue
            box = _int_box(x1, y1, x2, y2, width, height)
            if box is not None:
                dets.append(RawDetection(box=box, conf=float(c)))
        return _sorted(dets)


_NO_MERGE = "SIGHTLINE_NO_MERGE"


class _NoMerge:
    """SAHI postprocess that keeps every slice prediction (registered under ``_NO_MERGE``)."""

    def __init__(self, **_: Any) -> None:
        pass

    def __call__(self, predictions: list[Any]) -> list[Any]:
        return predictions


def merge_slices(
    raw: list[tuple[float, float, float, float, float]],
    width: int,
    height: int,
    merge: str = MERGE_TYPE,
    match_metric: str = MERGE_METRIC,
    match_threshold: float = MERGE_THRESHOLD,
) -> list[RawDetection]:
    """Merge per-slice boxes with one of SAHI's postprocesses (NMS, NMM, GREEDYNMM, LSNMS),
    then round and clip to the image. Same code path as SAHI's own merge after slicing."""
    from sahi.postprocess.combine import (
        GreedyNMMPostprocess,
        LSNMSPostprocess,
        NMMPostprocess,
        NMSPostprocess,
    )
    from sahi.prediction import ObjectPrediction

    classes = {
        "NMS": NMSPostprocess,
        "NMM": NMMPostprocess,
        "GREEDYNMM": GreedyNMMPostprocess,
        "LSNMS": LSNMSPostprocess,
    }
    preds = [
        ObjectPrediction(
            bbox=[x1, y1, x2, y2],
            category_id=PERSON_CLASS,
            category_name="person",
            score=c,
            full_shape=[height, width],
        )
        for x1, y1, x2, y2, c in raw
    ]
    if len(preds) > 1:
        post = classes[merge](
            match_threshold=match_threshold, match_metric=match_metric, class_agnostic=False
        )
        preds = post(preds)
    dets: list[RawDetection] = []
    for pred in preds:
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
