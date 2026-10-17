"""Deterministic simulated lawnmower flight path."""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import TYPE_CHECKING

from .project import METRES_PER_DEGREE

if TYPE_CHECKING:
    from sightline.contract import LatLon, Pose


@dataclass(frozen=True)
class FlightPlan:
    """Configuration for the simulated survey flight."""

    sector_nw: LatLon
    lines: int = 20
    frames_per_line: int = 25
    along_m: float = 12.0
    across_m: float = 16.0
    gsd_m: float = 0.02
    frame_w_px: int = 1000
    frame_h_px: int = 750

    # Validate the flight plan as soon as it is constructed.
    def __post_init__(self) -> None:
        numeric_values = (
            self.lines,
            self.frames_per_line,
            self.along_m,
            self.across_m,
            self.gsd_m,
            self.frame_w_px,
            self.frame_h_px,
        )
        if any(value <= 0 for value in numeric_values):
            raise ValueError("all flight-plan dimensions and spacings must be positive")

    # Return the footprint length in the east-west flight direction.
    @property
    def footprint_along_m(self) -> float:
        return self.frame_h_px * self.gsd_m

    # Return the footprint width perpendicular to each flight line.
    @property
    def footprint_across_m(self) -> float:
        return self.frame_w_px * self.gsd_m

    # Return the complete east-west extent covered by the survey.
    @property
    def sector_width_m(self) -> float:
        return self.footprint_along_m + self.along_m * (self.frames_per_line - 1)

    # Return the complete north-south extent covered by the survey.
    @property
    def sector_height_m(self) -> float:
        return self.footprint_across_m + self.across_m * (self.lines - 1)


# Generate the deterministic, alternating east-west survey poses.
def simulate_flight(plan: FlightPlan) -> list[Pose]:
    """Return poses in flight order for an east-west alternating path."""
    from sightline.contract import Pose

    poses: list[Pose] = []
    longitude_scale = METRES_PER_DEGREE * math.cos(math.radians(plan.sector_nw.lat))
    along_half_m = plan.footprint_along_m / 2.0
    across_half_m = plan.footprint_across_m / 2.0

    for line_index in range(plan.lines):
        heading_deg = 90.0 if line_index % 2 == 0 else 270.0
        south_m = across_half_m + plan.across_m * line_index
        latitude = plan.sector_nw.lat - south_m / METRES_PER_DEGREE

        for frame_index in range(plan.frames_per_line):
            ordered_index = (
                frame_index
                if line_index % 2 == 0
                else plan.frames_per_line - 1 - frame_index
            )
            east_m = along_half_m + plan.along_m * ordered_index
            longitude = plan.sector_nw.lon + east_m / longitude_scale
            poses.append(
                Pose(
                    lat=latitude,
                    lon=longitude,
                    alt_agl_m=None,
                    heading_deg=heading_deg,
                    gsd_m=plan.gsd_m,
                )
            )

    return poses
