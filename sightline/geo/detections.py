"""Georeference detector boxes using their centre pixel."""

from __future__ import annotations

from typing import TYPE_CHECKING

from sightline.ml.types import Box

from .project import pixel_to_latlon

if TYPE_CHECKING:
    from sightline.contract import LatLon, Pose

SIMULATED_RADIUS_M = 10.0


# Convert a detection box centre into a GPS point and uncertainty radius.
def georef_detection(
    box: Box,
    pose: Pose,
    width_px: int,
    height_px: int,
    radius_m: float = SIMULATED_RADIUS_M,
) -> tuple[LatLon, float]:
    """Project a Lane A detection box centre to the ground."""
    if radius_m < 0:
        raise ValueError("radius_m must not be negative")

    u, v = box.center
    point = pixel_to_latlon(
        u,
        v,
        pose,
        width_px,
        height_px,
    )
    return point, radius_m
