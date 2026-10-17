"""Geospatial projection, pose, flight-path, and detection helpers.

The contract-independent camera and projection API is exported here. Modules
that construct Lane D contract objects remain opt-in until that contract lands.
"""

from .camera import gsd, hfov_from_f35
from .project import footprint, latlon_to_pixel, pixel_to_latlon

__all__ = [
    "footprint",
    "gsd",
    "hfov_from_f35",
    "latlon_to_pixel",
    "pixel_to_latlon",
]
