# Real flight: a friend's footage through the live API

`scripts/real_flight.py` takes real aerial footage, checks what it says about where it was taken, and
sends it through the live API with one command. **Status:** built and tested on synthetic files; no real footage has been run through it yet. Shared parsing and geotag writing live in
`sightline/geo/geotag.py`. Tests: `tests/geo/test_geotag.py` and `tests/client/test_real_flight.py`.
They use synthetic files only: JPEGs with EXIF GPS, a stripped messenger copy, a phone photo, a tiny
ffmpeg video with a hand-written SRT, and an Airdata CSV. No network or GPU is needed.

**Any screenshot or clip of this run is labelled "real flight, real detector, fleet simulated".** The
photos and the detector are real. Nothing about the drone fleet in this run is real: no fleet flew, and
any drone icons, legs or relays on screen come from the simulator (`sightline/search/fleet.py`).

## The three forms the footage may come in

| Form | What it carries | What to do |
|---|---|---|
| 1. Drone photos (DJI JPEGs from the SD card or a cloud link) | EXIF GPS, 35 mm focal length, capture time; DJI XMP `drone-dji:RelativeAltitude`, `GimbalYawDegree`, `GimbalPitchDegree` | `inspect`, then `run`. Nothing is added. |
| 2. Drone video (`DJI_0001.MP4`) | Its `.SRT` subtitle file (next to it, or as a track inside the MP4), or a flight log (Airdata CSV, or a DJI flight record exported to CSV) | `frames` cuts JPEGs every N seconds and geotags each from the track, then `run` on the frames folder |
| 3. Phone photos | Plain EXIF GPS, often a compass direction (`GPSImgDirection`); no height above ground and no gimbal | `inspect --height-m H` gives a GSD estimate. `run --height-m H --assume-nadir` sends them with those values recorded as owner-stated. Without them, the detector runs on the photos (`run --offline`) and nothing goes on the map. |

Ask for the original files: a USB copy, the SD card, or a Google Drive or Dropbox link. WhatsApp,
Messenger and most chat apps drop EXIF and re-encode to about 1600 px, which removes the GPS. `inspect`
warns when it sees this.

## Commands

```bash
# 1. What is in the folder: per file type, GPS, altitudes, gimbal, focal length, size, time, GSD, verdict
uv run python scripts/real_flight.py inspect ~/footage/lynn [--height-m 40] [--json]

# 2. A video: cut a frame every 2 s and geotag it from the SRT (found next to the video if not given)
uv run python scripts/real_flight.py frames ~/footage/DJI_0001.MP4 --every 2s --out ~/footage/frames
#    ...or from a flight log; video t=0 is the log's first isVideo row unless --log-offset S is given
uv run python scripts/real_flight.py frames ~/footage/DJI_0001.MP4 --log ~/footage/airdata.csv \
    --every 2s --out ~/footage/frames [--clip 2] [--log-offset 31.5]
#    options when the track lacks a value: --assume-nadir (camera pointed straight down), --heading DEG,
#    --f35 MM, --height-m M. Each is recorded as owner-stated, per frame.

# 3. The owner's provenance line, cited by every report
uv run python scripts/real_flight.py label ~/footage/frames \
    --source "friend's DJI Mini 3, Lynn Canyon, 2026-10-18" --permission "may be shown in the demo"

# 4. Through the live API (capture order, same client path as `python -m sightline.client watch`)
export SIGHTLINE_API_TOKEN=...   # only when the API wants a write token
uv run python scripts/real_flight.py run ~/footage/frames --api https://<address> \
    --mission "Real flight: Lynn Canyon" [--lkp 49.3437,-123.0193] [--mission-id ID] [--pace 2]
#    a quick check with no server: the detector on this machine
uv run python scripts/real_flight.py run ~/footage/frames --offline
```

### inspect

For each file `inspect` prints the type, then for a photo its GPS, GPS altitude, relative altitude,
gimbal yaw and pitch, focal length, 35 mm focal length, size, camera and capture time. It computes
the ground sampling distance from relative altitude, 35 mm focal length and width
(`sightline/geo/camera.py`). Then it gives one verdict:

- **usable as-is**: the API will accept the photo. It has GPS, relative altitude, gimbal yaw, 35 mm
  focal length, and a gimbal pitch within 10° of straight down. These are the same checks as
  `read_photo_pose` in `sightline/mission/pipeline.py`.
- **needs geotag from log**: a video (cut frames with `frames`), a photo with GPS but no drone pose
  (phone style), or a photo with no GPS but a capture time a log could match.
- **unusable**, with the reason: GPS 0,0, no EXIF at all (a messenger copy), oblique (the map can't
  place it, though the detector can still look at it), unreadable, RAW, or not footage.

It also prints the flight's span (bounding box, first and last capture time, photo count) and warns
when GPS looks stripped: none of the photos has GPS, some are 0,0, a WhatsApp file name, or no EXIF
with 1600 px or less on the long side.

### frames

ffmpeg's `select` filter picks one frame per `--every` seconds, and `showinfo` gives each frame's exact
time. Each frame takes the track point nearest its time. If no point is within 1 s, the frame is
**skipped and counted**: a position is never invented. Two SRT families are read. One is the
bracketed `[latitude: …] [longitude: …] [rel_alt: … abs_alt: …]`, which also covers DJI's
`longtitude` typo, `[altitude: …]`, `focal_len` written in tenths, and `gb_yaw`/`gb_pitch` when present.
The other is the older `GPS(lon,lat,…) BAROMETER:…` and `GPS (lon, lat, sats), … H 10.2m`. Positions
of 0,0 (no fix) are dropped. Logs can be Airdata CSV (feet converted, gimbal heading, `isVideo`) or a DJI
flight record CSV (`OSD.*`, `GIMBAL.*`, `CUSTOM.isVideo`).

EXIF (GPS, GPS altitude, compass direction, 35 mm focal length, capture time) is written with Pillow,
a base dependency. piexif is only in the `sim` extra, and exiftool is not on the dev machine or in CI.
The XMP packet carries the `drone-dji:` values the API reads, plus `sightline:Source` and
`sightline:NotMeasured`, which name every value that came from somewhere other than the track.
`geotag.json` in the output folder lists, per frame, which values are measured, derived or owner-stated:

- **measured**: from the SRT or the log.
- **derived**: the camera heading taken as the course over ground (±2 s, at least 3 m moved) when the
  track has no gimbal yaw. A hovering drone has no course, so no heading is written.
- **owner-stated**: `--assume-nadir`, `--heading`, `--f35` or `--height-m`.

Without a gimbal pitch (most SRTs have none), the API refuses the frames as not nadir.
`frames` says so, and `--assume-nadir` is the owner's statement that the camera pointed down.

### run

1. Reads every JPEG and sorts them by capture time (then name). Photos the API can't place are
   reported as not sent, with the reason. A phone photo is sent only when `--height-m`,
   `--assume-nadir` and a heading (EXIF compass direction or `--heading`) are all given. It is then
   sent as a copy in `runs/real_flight/<ts>/staged/` that records those values as owner-stated.
   Photos over 28 MB (`sightline/api/limits.py`) are not sent.
2. Creates a mission (mode `live`). The last-known point is `--lkp`, or else the first photo's
   position, and the report says which. `--mission-id` sends to an existing mission instead.
3. Uploads one photo per request through `sightline.client.upload`, the same function `watch` uses.
   It sends `Authorization: Bearer $SIGHTLINE_API_TOKEN` when the variable is set. A 429 waits for
   `Retry-After` (the limit is 600 writes a minute), and `--pace S` spaces the photos out.
4. Polls `/survey`, `/detections`, `/state` and `/trace` until every accepted photo is a frame or a
   `photo.failed`, then waits up to `--proposal-wait-s` (default 60 s) for a proposal.
5. Writes `runs/real_flight/<ts>/report.md` and `report.json`. They cover photos sent, accepted,
   rejected and failed, and every detection with its score and box size, both in photo pixels and in
   the 1000 × 750 display frame. They list the top 5 crops, saved to `crops/` (the server's crop, or
   one cut locally from the original for a detection below 0.29), and the mission's proposals. They
   give the time from the first photo sent to the first frame, the first detection and the first
   proposal. These times are measured by polling once a second, so each is good to about 1 s. The
   report names the detector backend from `/health`. A fake backend is flagged as not for the take.

`--offline` runs `make_detector()` on this machine (cv2 by default, or `SIGHTLINE_BACKEND`) on every
readable JPEG. It writes the same report with no mission, map or proposals.

### label

`label` writes `provenance.json` into the folder: the source line, the owner's permission or licence
line (asked for when it is not given), who recorded it, the time, the screenshot label, and the
**fields**. For camera photos the fields count how many photos carry each pose value measured in their
own EXIF/XMP. For frames they repeat `geotag.json`'s measured, derived and owner-stated counts.
`run` copies it into the report.

## What counts for the judges

| Real, and counted | Labelled simulated or stated |
|---|---|
| The footage, its GPS, and its altitude from EXIF/XMP, the SRT or the log | The drone fleet: any drone, leg, link or relay on screen |
| The detector (the API's backend, named in the report) and every score and box | Any value in `NotMeasured` / `geotag.json` that is derived or owner-stated |
| Frames, footprints and pins placed from the measured pose | The last-known point, when it is the first photo's position (the report says so) |
| The times from the first photo to the first frame, detection and proposal, as measured | Proposals made by the scripted or fake agent when the server runs with `SIGHTLINE_FAKE_LLM=1` |

Searched areas are reported with their POD, as everywhere in Sightline. The run never says an area
holds no one.

## The one-command recipe for the on-camera take

Do the preparation before recording. Start the AWS instance and check it with
`uv run python scripts/remote_check.py --api https://<address>`. Then run `inspect` on the folder and
fix anything that is not **usable as-is**: `frames` for a video, `label` for provenance. Then record
one command:

```bash
SIGHTLINE_API_TOKEN=... uv run python scripts/real_flight.py run ~/footage/frames \
    --api https://<address> --mission "Real flight: Lynn Canyon" --lkp 49.3437,-123.0193 --pace 2
```

With the command post open on the new mission, the photos land in capture order. The detections show
on the map with their crops, and the terminal ends on the report: photos sent, the top detections,
the proposals, and the seconds from the first photo to the first proposal. The caption on screen is
**"real flight, real detector, fleet simulated"**, with the source line from `provenance.json`.
