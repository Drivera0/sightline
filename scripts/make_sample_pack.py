"""Sample drone photos a visitor can "submit": 20 of the demo's photos with GPS, altitude and heading in
their EXIF/XMP, so they land on the demo area along one leg of the survey's flight.

    bash web/scripts/fetch-caches.sh                       # once: the demo cache
    uv run python scripts/make_sample_pack.py              # writes runs/sample_pack/sightline-sample-photos.zip
    uv run python scripts/make_sample_pack.py --check http://127.0.0.1:8000   # and uploads it to a live mission

The photos are the demo cache's frames (HERIDAL, CC BY 3.0; ``CREDITS.txt`` in the zip carries the
citation the site's footer uses), f0256 to f0275: one east-bound line of the simulated survey at
49.36993 N, a photo every 12 m, one of them with people in it. Each gets the pose lane B's
``read_pose`` reads (EXIF GPS, the 35 mm focal length that gives the frame's ground size at 50 m, DJI
XMP altitude, yaw and a nadir gimbal) and a capture time two seconds after the one before. The zip
holds a README saying what they are and how to drop them in. Prints the zip's sha256.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import sys
import zipfile
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
CACHE = ROOT / "web/public/cache/demo"
OUT = ROOT / "runs/sample_pack/sightline-sample-photos.zip"
FIRST, COUNT = 256, 20  # f0256..f0275
ALT_M = 50.0
START = datetime.fromisoformat("2026-10-24T20:42:00+00:00")
MAX_BYTES = 40_000_000
LKP = {"lat": 49.37, "lon": -122.945}  # the demo map's last known point

CREDITS = """Photos: HERIDAL (Božić-Štulić, Marušić & Gotovac, 2019), CC BY 3.0.

D. Božić-Štulić, Ž. Marušić, S. Gotovac, "Deep Learning Approach in Aerial Imagery for Supporting
Land Search and Rescue Missions", International Journal of Computer Vision 127, 1256-1278 (2019).
Dataset: http://ipsar.fesb.unist.hr/HERIDAL%20database.html
Licence: Creative Commons Attribution 3.0 (https://creativecommons.org/licenses/by/3.0/).

Changes: each photo was cut and resized for Sightline's demo survey (1000 x 750 px) and its
EXIF/XMP was rewritten with a simulated position over Mount Seymour, BC. The positions are not
where the photos were taken.
"""

README = """Sightline sample photos
=======================

{n} aerial photos you can submit to a Sightline mission to see what happens when drone photos
land: each is placed on the map from its GPS, altitude and heading, the detector reads it, the
probability map lowers where it looked, and any candidate goes to review.

What they are: photos from the HERIDAL search-and-rescue dataset (CC BY 3.0, see CREDITS.txt),
with a SIMULATED position written into their EXIF/XMP: one east-bound line of a survey over the
Sightline demo area on Mount Seymour, BC (about 49.3699 N, 122.9450 W), 50 m above ground, a photo
every 12 m. Photo {people} has people in it.

How to use them:
- On the Sightline site: start a live mission at the demo area (last known point 49.37, -122.945),
  then drop the .jpg files on the photo panel (or pick them with the upload button).
- From a terminal, against a Sightline API:
      python -m sightline.client watch <folder with the photos> --api http://127.0.0.1:8000 --mission <id>
- Straight to the API: POST /missions/<id>/photos with up to 50 files (multipart, field "files").

They are a demo, not a real flight: never use them as evidence of where anyone was.
"""


def frames() -> list[dict]:
    survey = json.loads((CACHE / "survey.json").read_text())
    return survey["frames"][FIRST - 1 : FIRST - 1 + COUNT]


def _add(z: zipfile.ZipFile, name: str, data: bytes | str) -> None:
    """A member with a fixed time, so the same photos give the same zip (and sha256)."""
    z.writestr(zipfile.ZipInfo(name, date_time=(2026, 10, 24, 0, 0, 0)), data)


def build(out: Path = OUT) -> Path:
    """Write the zip; returns its path. Needs the demo cache."""
    from sightline.search.fleet import Crop, stamp

    picked = frames()
    out.parent.mkdir(parents=True, exist_ok=True)
    people = next((f["id"] for f in picked if f["n_candidates"]), None)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        for k, f in enumerate(picked):
            p = f["pose"]
            img = CACHE / f["file"]
            crop = Crop(img, (0, 0, f["width_px"], f["height_px"]), p["gsd_m"])
            taken = (START + timedelta(seconds=2 * k)).strftime("%Y-%m-%dT%H:%M:%SZ")
            data = stamp(crop, p["lat"], p["lon"], ALT_M, p["heading_deg"], taken,
                         description="Sightline sample photo: HERIDAL (CC BY 3.0), simulated position")  # fmt: skip
            _add(z, f"sightline-sample-photos/SIGHTLINE_{f['id']}.jpg", data)
        _add(
            z,
            "sightline-sample-photos/README.txt",
            README.format(n=len(picked), people=f"SIGHTLINE_{people}.jpg"),
        )
        _add(z, "sightline-sample-photos/CREDITS.txt", CREDITS)
    if buf.tell() > MAX_BYTES:
        raise SystemExit(f"the pack is {buf.tell() / 1e6:.1f} MB, over {MAX_BYTES / 1e6:g} MB")
    out.write_bytes(buf.getvalue())
    return out


def photos(zip_path: Path) -> list[tuple[str, bytes]]:
    with zipfile.ZipFile(zip_path) as z:
        return [(Path(n).name, z.read(n)) for n in sorted(z.namelist()) if n.endswith(".jpg")]


def check(api: str, zip_path: Path, token: str | None = None) -> dict:
    """Create a live mission at the demo's last known point and upload the pack's photos."""
    import httpx

    headers = {"Authorization": f"Bearer {token}"} if token else {}
    with httpx.Client(base_url=api, timeout=120, headers=headers) as http:
        mid = http.post("/missions", json={"name": "Sample photos check", "area_name": "Mount Seymour",
                                           "lkp": LKP}).raise_for_status().json()["mission_id"]  # fmt: skip
        files = [("files", (n, d, "image/jpeg")) for n, d in photos(zip_path)]
        r = http.post(f"/missions/{mid}/photos", files=files).raise_for_status().json()
    return {"mission": mid, **r}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--out", type=Path, default=OUT)
    ap.add_argument(
        "--check", metavar="API", help="upload the pack to a new live mission on this API"
    )
    args = ap.parse_args(argv)
    if not (CACHE / "survey.json").is_file():
        print(f"no {CACHE}/survey.json: run `bash web/scripts/fetch-caches.sh` first")
        return 1
    out = build(args.out)
    digest = hashlib.sha256(out.read_bytes()).hexdigest()
    print(f"wrote {out} ({out.stat().st_size / 1e6:.1f} MB, {COUNT} photos)")
    print(f"sha256 {digest}")
    if args.check:
        import os

        r = check(args.check, out, os.environ.get("SIGHTLINE_API_TOKEN"))
        print(
            f"mission {r['mission']}: {len(r['accepted'])} accepted, {len(r['rejected'])} rejected {r['rejected']}"
        )
        return 0 if len(r["accepted"]) == COUNT else 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
