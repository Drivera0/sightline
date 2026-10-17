"""Georeference detector boxes using their centre pixel."""

from __future__ import annotations

from collections.abc import Sequence
from typing import TYPE_CHECKING, TypeAlias

from .project import pixel_to_latlon

if TYPE_CHECKING:
    from sightline.contract import LatLon, Pose

Box: TypeAlias = Sequence[float]
SIMULATED_RADIUS_M = 10.0


# Convert a detection box centre into a GPS point and uncertainty radius.
def georef_detection(
    box: Box,
    pose: Pose,
    width_px: int,
    height_px: int,
    radius_m: float = SIMULATED_RADIUS_M,
) -> tuple[LatLon, float]:
    """Project a four-value ``[x1, y1, x2, y2]`` box centre to the ground."""
    if len(box) != 4:
        raise ValueError("box must contain x1, y1, x2, y2")
    x1, y1, x2, y2 = box
    if x2 <= x1 or y2 <= y1:
        raise ValueError("box must have positive width and height")
    if radius_m < 0:
        raise ValueError("radius_m must not be negative")

    point = pixel_to_latlon(
        (x1 + x2) / 2.0,
        (y1 + y2) / 2.0,
        pose,
        width_px,
        height_px,
    )
    return point, radius_m
