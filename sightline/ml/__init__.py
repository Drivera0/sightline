"""Lane A: the person detector (data prep, detection, evaluation).

Heavy dependencies (torch, ultralytics, sahi) are imported lazily inside ``Detector`` so this
package imports on CPU-only machines.
"""

from sightline.ml.crops import make_crop
from sightline.ml.data import load_split
from sightline.ml.detect import Detector
from sightline.ml.survey import run_survey
from sightline.ml.types import Box, LabeledImage, RawDetection

__all__ = [
    "Box",
    "Detector",
    "LabeledImage",
    "RawDetection",
    "load_split",
    "make_crop",
    "run_survey",
]
