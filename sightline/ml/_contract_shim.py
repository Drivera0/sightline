"""Lane A's local copy of the metrics shapes from docs/01_CONTRACT.md §9.

Lane D owns ``sightline/contract.py``. Until it exists, ``sightline.ml.evaluate`` falls back
to these models; once D lands the real contract, the ``try/except`` import in ``evaluate.py``
picks it up and this file becomes dead code. Field names and types mirror §9 exactly.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class VocScores(BaseModel):
    precision: float = Field(ge=0, le=1)
    recall: float = Field(ge=0, le=1)
    ap50: float = Field(ge=0, le=1)


class SarScores(BaseModel):
    precision: float = Field(ge=0, le=1)
    recall: float = Field(ge=0, le=1)
    ap: float = Field(ge=0, le=1)


class DetectorMetrics(BaseModel):
    model: str
    test_images: int
    tiled: bool
    threshold: float
    voc: VocScores
    sar: SarScores
    recall: float
    seconds_per_image: float


class Ablation(BaseModel):
    name: str
    voc: VocScores
