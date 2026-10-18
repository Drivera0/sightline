"""Geospatial projection, pose, flight-path, and detection helpers."""

from __future__ import annotations

import math
from dataclasses import dataclass

from sightline.contract import LatLon, Pose
from sightline.ml.types import Box

from .camera import gsd, hfov_from_f35
from .constants import LKP, SECTOR_NW
from .detections import georef_detection as _georef_detection
from .flight import FlightPlan
from .flight import simulate_flight as _simulate_flight
from .position_error import PinErrorSummary, measure_pin_errors, summarize_pin_errors
from .project import METRES_PER_DEGREE, footprint, latlon_to_pixel, pixel_to_latlon
from .real import RealPhoto, RealPhotoSelection, cluster_real_photos, select_real_photos

AREA_NAME = "Mount Seymour, North Vancouver (simulated flight path)"
DEMO_FRAME_COUNT = 500


@dataclass(frozen=True)
class SimulatedFlight:
    """Lane D adapter result containing poses and the survey-area metadata."""

    poses: list[Pose]
    lkp: LatLon
    area_name: str


# Choose a compact lawnmower shape that supports both the demo and uploaded frame counts.
def _flight_shape(n_frames: int) -> tuple[int, int]:
    if n_frames <= 0:
        raise ValueError("n_frames must be positive")
    if n_frames % 25 == 0:
        frames_per_line = 25
    elif n_frames % 5 == 0 and n_frames <= 250:
        frames_per_line = 5
    else:
        frames_per_line = min(25, n_frames)
    lines = math.ceil(n_frames / frames_per_line)
    return lines, frames_per_line


# Centre a generated survey sector on the shared LKP.
def _centred_sector_nw(plan: FlightPlan) -> LatLon:
    latitude = LKP.lat + plan.sector_height_m / (2.0 * METRES_PER_DEGREE)
    longitude_scale = METRES_PER_DEGREE * math.cos(math.radians(LKP.lat))
    longitude = LKP.lon - plan.sector_width_m / (2.0 * longitude_scale)
    return LatLon(lat=latitude, lon=longitude)


# Adapt Lane B's FlightPlan API to Lane D's frame-count pipeline interface.
def simulate_flight(n_frames: int, seed: int = 7) -> SimulatedFlight:
    """Return exactly one deterministic simulated pose per pipeline frame."""
    lines, frames_per_line = _flight_shape(n_frames)
    initial_plan = FlightPlan(
        sector_nw=LKP,
        lines=lines,
        frames_per_line=frames_per_line,
    )
    sector_nw = SECTOR_NW if n_frames == DEMO_FRAME_COUNT else _centred_sector_nw(initial_plan)
    plan = FlightPlan(
        sector_nw=sector_nw,
        lines=lines,
        frames_per_line=frames_per_line,
    )
    # The path is deterministic by construction; the argument preserves Lane D's seeded API.
    _ = seed
    return SimulatedFlight(
        poses=_simulate_flight(plan)[:n_frames],
        lkp=LKP,
        area_name=AREA_NAME,
    )


# Adapt Lane D's pose-first pixel tuple to Lane B's Box-first projection function.
def georef_detection(
    pose: Pose,
    box_px: tuple[int, int, int, int],
    width_px: int,
    height_px: int,
) -> tuple[float, float, float]:
    """Return a detection centre as the pipeline's `(lat, lon, radius_m)` tuple."""
    point, radius_m = _georef_detection(
        Box(*box_px),
        pose,
        width_px,
        height_px,
    )
    return point.lat, point.lon, radius_m


__all__ = [
    "PinErrorSummary",
    "RealPhoto",
    "RealPhotoSelection",
    "SimulatedFlight",
    "cluster_real_photos",
    "footprint",
    "georef_detection",
    "gsd",
    "hfov_from_f35",
    "latlon_to_pixel",
    "measure_pin_errors",
    "pixel_to_latlon",
    "select_real_photos",
    "simulate_flight",
    "summarize_pin_errors",
]
