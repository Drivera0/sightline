"""Small JPEGs with what lane B's ``read_pose`` needs (EXIF GPS + 35 mm focal length, DJI XMP
relative altitude and gimbal yaw/pitch), for the mission API tests and ``scripts/smoke.sh``.

    uv run python tests/fixtures/drone_photos.py      # rewrites tests/fixtures/photos/*.jpg
"""

from __future__ import annotations

import io
from pathlib import Path

from PIL import ExifTags, Image, ImageDraw

LKP = {"lat": 49.375, "lon": -122.9375}  # Mount Seymour, as in the demo
OUT = Path(__file__).parent / "photos"


def drone_photo(
    lat: float = LKP["lat"],
    lon: float = LKP["lon"],
    *,
    gps: bool = True,
    w: int = 800,
    h: int = 600,
) -> bytes:
    im = Image.new("RGB", (w, h), (90, 110, 80))
    ImageDraw.Draw(im).rectangle((w // 3, h // 3, w // 3 + 20, h // 3 + 30), fill=(200, 40, 40))
    exif = Image.Exif()
    if gps:
        g = exif.get_ifd(ExifTags.IFD.GPSInfo)
        g.update(
            {
                1: "N" if lat >= 0 else "S",
                2: (abs(lat), 0.0, 0.0),
                3: "E" if lon >= 0 else "W",
                4: (abs(lon), 0.0, 0.0),
            }
        )
    exif.get_ifd(ExifTags.IFD.Exif)[41989] = 24  # 35 mm-equivalent focal length
    xmp = (
        b'<x:xmpmeta drone-dji:RelativeAltitude="+50.0" drone-dji:GimbalYawDegree="+0.0"'
        b' drone-dji:GimbalPitchDegree="-90.0"/>'
    )
    buf = io.BytesIO()
    im.save(buf, "JPEG", exif=exif, comment=xmp if gps else b"", quality=80)
    return buf.getvalue()


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    for k in range(3):  # three photos 11 m apart, flying north
        (OUT / f"DJI_{k + 1:04d}.JPG").write_bytes(drone_photo(LKP["lat"] + k * 1e-4))
    (OUT / "no_gps.jpg").write_bytes(drone_photo(gps=False))
    print(f"wrote {OUT}")
