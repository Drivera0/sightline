"""Nadir, flat-ground projection between image pixels and WGS84 coordinates."""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from sightline.contract import LatLon, Pose

METRES_PER_DEGREE = 111_320.0


# Project one image pixel onto the ground using its frame pose.
def pixel_to_latlon(
    u: float,
    v: float,
    pose: Pose,
    width_px: int,
    height_px: int,
) -> LatLon:
    """Project an image pixel to the ground using the documented nadir model."""
    _validate_dimensions(width_px, height_px)
    theta = math.radians(pose.heading_deg)
    x_m = (u - width_px / 2.0) * pose.gsd_m
    y_m = (height_px / 2.0 - v) * pose.gsd_m

    east_m = x_m * math.cos(theta) + y_m * math.sin(theta)
    north_m = -x_m * math.sin(theta) + y_m * math.cos(theta)
    latitude = pose.lat + north_m / METRES_PER_DEGREE
    longitude = pose.lon + east_m / (METRES_PER_DEGREE * math.cos(math.radians(pose.lat)))

    from sightline.contract import LatLon

    return LatLon(lat=latitude, lon=longitude)


# Convert a ground coordinate back into the corresponding image pixel.
def latlon_to_pixel(
    p: LatLon,
    pose: Pose,
    width_px: int,
    height_px: int,
) -> tuple[float, float]:
    """Invert :func:`pixel_to_latlon` for the same local flat-ground model."""
    _validate_dimensions(width_px, height_px)
    east_m = (p.lon - pose.lon) * METRES_PER_DEGREE * math.cos(math.radians(pose.lat))
    north_m = (p.lat - pose.lat) * METRES_PER_DEGREE
    theta = math.radians(pose.heading_deg)

    x_m = east_m * math.cos(theta) - north_m * math.sin(theta)
    y_m = east_m * math.sin(theta) + north_m * math.cos(theta)
    u = width_px / 2.0 + x_m / pose.gsd_m
    v = height_px / 2.0 - y_m / pose.gsd_m
    return u, v


# Project the four image corners into the contract's footprint order.
def footprint(
    pose: Pose,
    width_px: int,
    height_px: int,
) -> list[tuple[float, float]]:
    """Return image corners as ``[lon, lat]`` pairs in TL, TR, BR, BL order."""
    corners_px = (
        (0.0, 0.0),
        (float(width_px), 0.0),
        (float(width_px), float(height_px)),
        (0.0, float(height_px)),
    )
    return [
        (point.lon, point.lat)
        for point in (pixel_to_latlon(u, v, pose, width_px, height_px) for u, v in corners_px)
    ]


# Reject invalid image dimensions before applying projection math.
def _validate_dimensions(width_px: int, height_px: int) -> None:
    if width_px <= 0 or height_px <= 0:
        raise ValueError("image dimensions must be positive")
