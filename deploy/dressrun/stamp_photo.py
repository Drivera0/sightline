"""Give a photo the drone metadata the mission API needs (EXIF GPS + 35 mm focal length, DJI XMP
altitude and gimbal), as tests/fixtures/drone_photos.py does for its synthetic photos.

    python deploy/dressrun/stamp_photo.py <in.jpg> <out.jpg> [--lat 43.5 --lon 16.4]

The dress run stamps demo-cache frame f0002 (a published frame the detector finds a person in) so
scripts/remote_check.py can send it through upload → worker → photo.processed without the HERIDAL
download. The pixels are unchanged (re-encoded at quality 95); only the metadata is added.
"""

from __future__ import annotations

import argparse
import io
from pathlib import Path

from PIL import ExifTags, Image


def stamp(src: Path, lat: float, lon: float) -> bytes:
    im = Image.open(src).convert("RGB")
    exif = Image.Exif()
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
    im.save(buf, "JPEG", exif=exif, comment=xmp, quality=95)
    return buf.getvalue()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("src", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--lat", type=float, default=43.5)  # remote_check's mission LKP
    ap.add_argument("--lon", type=float, default=16.4)
    args = ap.parse_args()
    args.out.write_bytes(stamp(args.src, args.lat, args.lon))
    print(f"stamped {args.src} -> {args.out}")


if __name__ == "__main__":
    main()
