"""Best-effort EXIF/XMP reader for real drone image poses."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .camera import gsd, hfov_from_f35

if TYPE_CHECKING:
    from sightline.contract import Pose


@dataclass(frozen=True)
class RealPoseInfo:
    """Pose plus source-camera attributes that do not enter the cache contract."""

    pose: Pose
    pitch_deg: float | None
    camera_model: str | None
    nadir: bool


# Read the complete pose needed for projection from an original drone JPEG.
def read_pose(image: Path) -> RealPoseInfo | None:
    """Read a complete nadir projection pose from standard EXIF and DJI XMP.

    Returns ``None`` when latitude, longitude, relative altitude, heading, or
    35 mm-equivalent focal length is absent, as required by the Lane B spec.
    """
    from PIL import ExifTags, Image

    with Image.open(image) as opened:
        exif = opened.getexif()
        width_px, height_px = opened.size

    try:
        gps = exif.get_ifd(ExifTags.IFD.GPSInfo)
    except (AttributeError, KeyError):
        gps = exif.get(34853)

    lat = _gps_decimal(gps, 2, 1)
    lon = _gps_decimal(gps, 4, 3)
    f35_mm = _as_float(exif.get(41989))
    camera_model_value = exif.get(272)
    camera_model = str(camera_model_value).strip() if camera_model_value else None

    raw = image.read_bytes()
    relative_altitude_m = _xmp_number(raw, "RelativeAltitude")
    yaw_deg = _xmp_number(raw, "GimbalYawDegree")
    pitch_deg = _xmp_number(raw, "GimbalPitchDegree")

    required = (lat, lon, relative_altitude_m, yaw_deg, f35_mm)
    if any(value is None for value in required):
        return None

    assert lat is not None
    assert lon is not None
    assert relative_altitude_m is not None
    assert yaw_deg is not None
    assert f35_mm is not None

    from sightline.contract import Pose

    hfov_deg = hfov_from_f35(f35_mm, width_px, height_px)
    pose = Pose(
        lat=lat,
        lon=lon,
        alt_agl_m=relative_altitude_m,
        heading_deg=yaw_deg % 360.0,
        gsd_m=gsd(relative_altitude_m, hfov_deg, width_px),
    )
    return RealPoseInfo(
        pose=pose,
        pitch_deg=pitch_deg,
        camera_model=camera_model,
        nadir=pitch_deg is not None and abs(pitch_deg + 90.0) <= 10.0,
    )


# Convert an EXIF degrees-minutes-seconds coordinate into signed decimal degrees.
def _gps_decimal(
    gps: Any,
    coordinate_key: int,
    reference_key: int,
) -> float | None:
    if not gps:
        return None
    coordinate = gps.get(coordinate_key)
    reference = gps.get(reference_key)
    if coordinate is None or reference is None or len(coordinate) != 3:
        return None

    degrees, minutes, seconds = (_as_float(value) for value in coordinate)
    if degrees is None or minutes is None or seconds is None:
        return None
    decimal = degrees + minutes / 60.0 + seconds / 3600.0
    if str(reference).upper() in {"S", "W"}:
        decimal = -decimal
    return decimal


# Extract one numeric DJI attribute from embedded XMP text.
def _xmp_number(raw: bytes, name: str) -> float | None:
    text = raw.decode("latin-1", errors="ignore")
    escaped = re.escape(name)
    patterns = (
        rf'drone-dji:{escaped}=["\']\s*([+-]?[0-9]+(?:\.[0-9]+)?)',
        rf'<drone-dji:{escaped}>\s*([+-]?[0-9]+(?:\.[0-9]+)?)',
    )
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            return float(match.group(1))
    return None


# Safely normalize EXIF rational and numeric values to floats.
def _as_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError, ZeroDivisionError):
        return None
