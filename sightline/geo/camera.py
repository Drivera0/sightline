"""Camera field-of-view and ground-sampling-distance calculations."""

from __future__ import annotations

import math

FULL_FRAME_DIAGONAL_MM = 43.27


# Convert a 35 mm-equivalent focal length into horizontal field of view.
def hfov_from_f35(f35_mm: float, width_px: int, height_px: int) -> float:
    """Return horizontal field of view in degrees from 35 mm-equivalent focal length."""
    if f35_mm <= 0:
        raise ValueError("f35_mm must be positive")
    if width_px <= 0 or height_px <= 0:
        raise ValueError("image dimensions must be positive")

    equivalent_width_mm = FULL_FRAME_DIAGONAL_MM * width_px / math.hypot(width_px, height_px)
    return math.degrees(2.0 * math.atan(equivalent_width_mm / (2.0 * f35_mm)))


# Calculate how many metres of ground each horizontal image pixel represents.
def gsd(alt_agl_m: float, hfov_deg: float, width_px: int) -> float:
    """Return horizontal ground sample distance in metres per pixel."""
    if alt_agl_m <= 0:
        raise ValueError("alt_agl_m must be positive")
    if not 0 < hfov_deg < 180:
        raise ValueError("hfov_deg must be between 0 and 180")
    if width_px <= 0:
        raise ValueError("width_px must be positive")

    ground_width_m = 2.0 * alt_agl_m * math.tan(math.radians(hfov_deg) / 2.0)
    return ground_width_m / width_px
