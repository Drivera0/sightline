"""Real footage from a drone or phone: what each file says about where it was taken, and geotags for
frames cut from a video (``scripts/real_flight.py``, ``docs/REAL_FLIGHT.md``).

- ``read_photo_meta``: GPS, altitudes, gimbal, focal length, size and capture time of a JPEG, from
  EXIF and DJI XMP, with no requirement that the pose be complete (``pose.read_pose`` has that).
- ``parse_srt``: a DJI ``.SRT`` subtitle track. Two families exist in the wild: the newer bracketed
  one (``[latitude: 49.1] [longitude: -123.1] [rel_alt: 50.0 abs_alt: 120.3]``, with the DJI typo
  ``longtitude`` on some models) and the older ``GPS(lon,lat,alt) BAROMETER:50.3`` /
  ``GPS (lon, lat, sats), D 24.5m, H 10.2m`` lines.
- ``parse_flight_log``: an Airdata CSV or a DJI flight record exported to CSV.
- ``nearest``: the track point within a tolerance (1 s) of a time, or None. A frame with no match
  is skipped and counted: a position is never invented.
- ``write_geotag``: a copy of a JPEG with EXIF GPS (Pillow) and a DJI-style XMP packet carrying
  relative altitude and gimbal angles, plus ``sightline:`` fields naming which values were derived.
"""

from __future__ import annotations

import bisect
import csv
import io
import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from .camera import gsd, hfov_from_f35
from .pose import _as_float, _gps_decimal, _xmp_number

NADIR_TOLERANCE_DEG = 10.0  # the same test as pose.read_pose
MATCH_TOLERANCE_S = 1.0
FEET = 0.3048
WHATSAPP_NAME = re.compile(r"-WA\d{4}", re.IGNORECASE)
MESSENGER_MAX_SIDE_PX = 1600  # WhatsApp's default re-encode: longest side 1600 px, EXIF dropped

# --- one JPEG ----------------------------------------------------------------------------------


@dataclass
class PhotoMeta:
    """What a JPEG says about itself. ``None`` means absent, never zero."""

    path: Path
    width: int = 0
    height: int = 0
    has_exif: bool = False
    lat: float | None = None
    lon: float | None = None
    gps_alt_m: float | None = None  # EXIF GPSAltitude (above sea level)
    rel_alt_m: float | None = None  # DJI XMP RelativeAltitude (above take-off)
    yaw_deg: float | None = None  # DJI GimbalYawDegree
    pitch_deg: float | None = None  # DJI GimbalPitchDegree
    img_direction_deg: float | None = None  # EXIF GPSImgDirection (phones)
    f35_mm: float | None = None
    focal_mm: float | None = None
    make: str | None = None
    model: str | None = None
    software: str | None = None
    captured_at: str | None = None  # "2026:10:20 14:03:11" as EXIF writes it
    error: str | None = None

    @property
    def has_gps(self) -> bool:
        return self.lat is not None and self.lon is not None

    @property
    def gps_zero(self) -> bool:
        return self.has_gps and abs(self.lat or 0) < 1e-9 and abs(self.lon or 0) < 1e-9

    @property
    def nadir(self) -> bool:
        return self.pitch_deg is not None and abs(self.pitch_deg + 90.0) <= NADIR_TOLERANCE_DEG

    def missing_for_api(self) -> list[str]:
        """What ``POST /missions/{id}/photos`` would miss (``mission.pipeline.read_photo_pose``)."""
        need = {
            "GPS": self.has_gps and not self.gps_zero,
            "relative altitude": self.rel_alt_m is not None,
            "gimbal yaw": self.yaw_deg is not None,
            "35 mm focal length": self.f35_mm is not None,
            "gimbal pitch": self.pitch_deg is not None,
        }
        return [k for k, ok in need.items() if not ok]

    def gsd_m(self, height_m: float | None = None) -> tuple[float | None, str]:
        """Metres per pixel and where the height came from; ``(None, why)`` when unknown."""
        h, src = (
            (self.rel_alt_m, "relative altitude") if self.rel_alt_m else (height_m, "--height-m")
        )
        if not h or h <= 0:
            return None, "unknown: no relative altitude (give --height-m)"
        if not self.f35_mm or not self.width:
            return None, "unknown: no 35 mm focal length"
        try:
            return gsd(h, hfov_from_f35(self.f35_mm, self.width, self.height), self.width), src
        except ValueError as e:
            return None, f"unknown: {e}"

    def captured_dt(self) -> datetime | None:
        if not self.captured_at:
            return None
        try:
            return datetime.strptime(self.captured_at[:19], "%Y:%m:%d %H:%M:%S")
        except ValueError:
            return None


def read_photo_meta(path: Path) -> PhotoMeta:
    from PIL import ExifTags, Image, UnidentifiedImageError

    meta = PhotoMeta(path=path)
    try:
        with Image.open(path) as im:
            meta.width, meta.height = im.size
            exif = im.getexif()
    except (OSError, UnidentifiedImageError, SyntaxError, ValueError) as e:
        meta.error = f"not a readable image ({type(e).__name__})"
        return meta
    meta.has_exif = len(exif) > 0
    try:
        gps = exif.get_ifd(ExifTags.IFD.GPSInfo)
    except (AttributeError, KeyError):
        gps = {}
    try:
        details = exif.get_ifd(ExifTags.IFD.Exif)
    except (AttributeError, KeyError):
        details = {}
    meta.has_exif = meta.has_exif or bool(gps) or bool(details)
    meta.lat, meta.lon = _gps_decimal(gps, 2, 1), _gps_decimal(gps, 4, 3)
    alt = _as_float(gps.get(6)) if gps else None
    if alt is not None and gps.get(5) in (1, b"\x01"):
        alt = -alt
    meta.gps_alt_m = alt
    meta.img_direction_deg = _as_float(gps.get(17)) if gps else None
    meta.f35_mm = _as_float(details.get(41989, exif.get(41989))) or None
    meta.focal_mm = _as_float(details.get(37386, exif.get(37386)))
    meta.make = _text(exif.get(271))
    meta.model = _text(exif.get(272))
    meta.software = _text(exif.get(305))
    meta.captured_at = _text(details.get(36867) or exif.get(306))
    raw = path.read_bytes()
    meta.rel_alt_m = _xmp_number(raw, "RelativeAltitude")
    meta.yaw_deg = _xmp_number(raw, "GimbalYawDegree")
    meta.pitch_deg = _xmp_number(raw, "GimbalPitchDegree")
    return meta


def _text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bytes):
        value = value.decode("latin-1", errors="ignore")
    s = str(value).strip("\x00 ")
    return s or None


def looks_reencoded(meta: PhotoMeta) -> str | None:
    """Why a JPEG looks like a messenger re-encode (EXIF stripped), or None."""
    if WHATSAPP_NAME.search(meta.path.name):
        return "WhatsApp file name (IMG-…-WA0001): WhatsApp drops EXIF and re-encodes"
    if not meta.has_exif and meta.width and max(meta.width, meta.height) <= MESSENGER_MAX_SIDE_PX:
        return (
            f"no EXIF and {max(meta.width, meta.height)} px on the long side: looks re-encoded "
            "by a messenger app"
        )
    return None


# --- tracks: SRT and flight logs -----------------------------------------------------------------


@dataclass(frozen=True)
class TrackPoint:
    """One position in time. ``t_s``: seconds from the start of the video (SRT) or log."""

    t_s: float
    lat: float
    lon: float
    rel_alt_m: float | None = None
    abs_alt_m: float | None = None
    yaw_deg: float | None = None
    pitch_deg: float | None = None
    f35_mm: float | None = None
    when: datetime | None = None
    recording: bool | None = None  # flight logs: the camera was recording video


@dataclass
class Track:
    points: list[TrackPoint]
    source: str  # "DJI SRT" / "Airdata CSV" / "DJI flight record CSV"
    skipped: int = 0  # records with no usable position (no fix, 0,0)
    notes: list[str] = field(default_factory=list)

    def times(self) -> list[float]:
        return [p.t_s for p in self.points]


_NUM = r"[-+]?\d+(?:\.\d+)?"
_CUE_TIME = re.compile(
    r"(\d+):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d+):(\d{2}):(\d{2})[,.](\d{1,3})"
)
_DATETIME = re.compile(
    r"(\d{4})[-.:/](\d{2})[-.:/](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?"
)


def _field(text: str, *names: str) -> float | None:
    for name in names:
        m = re.search(rf"\[?\b{name}\s*[:=]\s*({_NUM})", text, re.IGNORECASE)
        if m:
            return float(m.group(1))
    return None


def _cue_seconds(h: str, m: str, s: str, ms: str) -> float:
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms.ljust(3, "0")) / 1000


def _parse_dt(text: str) -> datetime | None:
    m = _DATETIME.search(text)
    if not m:
        return None
    y, mo, d, h, mi, s, frac = m.groups()
    try:
        dt = datetime(int(y), int(mo), int(d), int(h), int(mi), int(s))
    except ValueError:
        return None
    if frac:
        dt += timedelta(seconds=float(f"0.{frac[:6]}"))
    return dt


def _srt_f35(value: float | None) -> float | None:
    """DJI writes ``focal_len`` as 24.00 on most models and 280 (tenths) on some."""
    if value is None or value <= 0:
        return None
    return value / 10 if value > 100 else value


def parse_srt_cue(body: str) -> dict[str, Any] | None:
    """One cue's text to fields; None when it has no position. Coordinates 0,0 (no fix) count as
    no position."""
    text = re.sub(r"<[^>]+>", " ", body)  # DJI wraps cues in <font size="28"> tags
    lat = _field(text, "latitude")
    lon = _field(text, "longt?itude")
    rel = _field(text, "rel_alt")
    abs_ = _field(text, "abs_alt")
    if lat is None or lon is None:
        old = re.search(rf"GPS\s*\(\s*({_NUM})\s*,\s*({_NUM})(?:\s*,\s*({_NUM})\s*M?)?\s*\)", text)
        if old is None:
            return None
        a, b = float(old.group(1)), float(old.group(2))
        lon, lat = (b, a) if abs(b) > 90 >= abs(a) else (a, b)  # DJI's order is (lon, lat)
        rel = _field(text, "BAROMETER")
        if rel is None:
            m = re.search(rf"\bH\s+({_NUM})\s*m\b", text)
            rel = float(m.group(1)) if m else None
    if abs_ is None:
        abs_ = _field(text, "altitude")
    if abs(lat) < 1e-9 and abs(lon) < 1e-9:
        return None
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return {
        "lat": lat,
        "lon": lon,
        "rel_alt_m": rel,
        "abs_alt_m": abs_,
        "yaw_deg": _field(text, "gb_yaw", "gimbal_yaw"),
        "pitch_deg": _field(text, "gb_pitch", "gimbal_pitch"),
        "f35_mm": _srt_f35(_field(text, "focal_len")),
        "when": _parse_dt(text),
    }


def parse_srt(text: str) -> Track:
    """Every cue with a position, by start time."""
    points: list[TrackPoint] = []
    skipped = 0
    for block in re.split(r"\r?\n\s*\r?\n", text.replace("﻿", "")):
        m = _CUE_TIME.search(block)
        if not m:
            continue
        body = block[m.end() :]
        fields = parse_srt_cue(body)
        if fields is None:
            skipped += 1
            continue
        points.append(TrackPoint(t_s=_cue_seconds(*m.groups()[:4]), **fields))
    points.sort(key=lambda p: p.t_s)
    return Track(points, "DJI SRT", skipped)


def _col(header: dict[str, str], *names: str) -> str | None:
    for n in names:
        if n in header:
            return header[n]
    return None


def parse_flight_log(text: str) -> Track:
    """An Airdata CSV (``time(millisecond)``, ``latitude``, ``height_above_takeoff(feet)``,
    ``gimbal_heading(degrees)``, ``isVideo``) or a DJI flight record CSV (``OSD.latitude``,
    ``OSD.flyTime [s]``, ``OSD.height [ft]``, ``GIMBAL.yaw``, ``CUSTOM.isVideo``)."""
    rows = list(csv.reader(io.StringIO(text.replace("﻿", ""))))
    if not rows:
        raise ValueError("empty flight log")
    head = {h.strip().lower(): i for i, h in enumerate(rows[0])}
    norm = {re.sub(r"\s+", "", h): h for h in head}

    def idx(*names: str) -> int | None:
        for n in names:
            key = re.sub(r"\s+", "", n.lower())
            if key in norm:
                return head[norm[key]]
        return None

    lat_i = idx("latitude", "osd.latitude", "lat")
    lon_i = idx("longitude", "osd.longitude", "lon", "lng")
    if lat_i is None or lon_i is None:
        raise ValueError("no latitude/longitude columns: not an Airdata or DJI flight record CSV")
    airdata = "time(millisecond)" in norm
    t_ms = idx("time(millisecond)")
    t_s = idx("osd.flytime [s]", "osd.flytime", "time(s)", "time")
    dt_i = idx("datetime(utc)", "custom.updatetime [utc]", "custom.updatetime", "datetime")
    h_ft = idx("height_above_takeoff(feet)", "osd.height [ft]")
    h_m = idx("height_above_takeoff(meters)", "osd.height [m]", "osd.height", "height")
    a_ft = idx("altitude_above_sealevel(feet)", "osd.altitude [ft]")
    a_m = idx("altitude_above_sealevel(meters)", "osd.altitude [m]", "osd.altitude")
    gyaw = idx("gimbal_heading(degrees)", "gimbal.yaw [360]", "gimbal.yaw")
    cyaw = idx("compass_heading(degrees)", "osd.yaw [360]", "osd.yaw")
    gpitch = idx("gimbal_pitch(degrees)", "gimbal.pitch")
    vid = idx("isvideo", "custom.isvideo")

    def num(row: list[str], i: int | None, scale: float = 1.0) -> float | None:
        if i is None or i >= len(row):
            return None
        v = _as_float(row[i].strip() or None)
        return None if v is None else v * scale

    points: list[TrackPoint] = []
    skipped, used_compass = 0, False
    t0_dt: datetime | None = None
    for k, row in enumerate(rows[1:]):
        lat, lon = num(row, lat_i), num(row, lon_i)
        when = _parse_dt(row[dt_i]) if dt_i is not None and dt_i < len(row) else None
        if t_ms is not None and (v := num(row, t_ms)) is not None:
            t = v / 1000
        elif t_s is not None and (v := num(row, t_s)) is not None:
            t = v
        elif when is not None:
            t0_dt = t0_dt or when
            t = (when - t0_dt).total_seconds()
        else:
            t = float(k)  # no clock at all: one row per second is a guess, said in the notes
        if lat is None or lon is None or (abs(lat) < 1e-9 and abs(lon) < 1e-9):
            skipped += 1
            continue
        yaw = num(row, gyaw)
        if yaw is None and (yaw := num(row, cyaw)) is not None:
            used_compass = True
        rec = row[vid].strip().lower() if vid is not None and vid < len(row) else ""
        points.append(
            TrackPoint(
                t_s=t,
                lat=lat,
                lon=lon,
                rel_alt_m=num(row, h_ft, FEET) if h_ft is not None else num(row, h_m),
                abs_alt_m=num(row, a_ft, FEET) if a_ft is not None else num(row, a_m),
                yaw_deg=None if yaw is None else yaw % 360,
                pitch_deg=num(row, gpitch),
                when=when,
                recording=None if not rec else rec not in ("0", "false", "no", "n/a"),
            )
        )
    points.sort(key=lambda p: p.t_s)
    track = Track(points, "Airdata CSV" if airdata else "DJI flight record CSV", skipped)
    if used_compass:
        track.notes.append("heading: aircraft compass (no gimbal heading column)")
    if t_ms is None and t_s is None and dt_i is None:
        track.notes.append("no time column: rows taken as one per second")
    return track


def recording_starts(track: Track) -> list[float]:
    """Log times (s) at which video recording started (``isVideo`` going 0 → 1)."""
    out, prev = [], False
    for p in track.points:
        if p.recording and not prev:
            out.append(p.t_s)
        prev = bool(p.recording)
    return out


def nearest(track: Track, t_s: float, tol_s: float = MATCH_TOLERANCE_S) -> TrackPoint | None:
    """The point nearest ``t_s`` if it is within ``tol_s``, else None."""
    times = track.times()
    if not times:
        return None
    i = bisect.bisect_left(times, t_s)
    best = min(
        (track.points[j] for j in (i - 1, i) if 0 <= j < len(times)),
        key=lambda p: abs(p.t_s - t_s),
    )
    return best if abs(best.t_s - t_s) <= tol_s else None


def distance_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat = math.radians((a[0] + b[0]) / 2)
    dy = (b[0] - a[0]) * 111_320.0
    dx = (b[1] - a[1]) * 111_320.0 * math.cos(lat)
    return math.hypot(dx, dy)


def course_deg(track: Track, t_s: float, window_s: float = 2.0, min_m: float = 3.0) -> float | None:
    """Course over ground around ``t_s`` (degrees from north), or None when the drone moved less
    than ``min_m`` in ``±window_s`` (hovering: no course to take)."""
    pts = [p for p in track.points if abs(p.t_s - t_s) <= window_s]
    if len(pts) < 2:
        return None
    a, b = pts[0], pts[-1]
    if distance_m((a.lat, a.lon), (b.lat, b.lon)) < min_m:
        return None
    dy = b.lat - a.lat
    dx = (b.lon - a.lon) * math.cos(math.radians((a.lat + b.lat) / 2))
    return math.degrees(math.atan2(dx, dy)) % 360


# --- writing a geotag ----------------------------------------------------------------------------

XMP_HEADER = b"http://ns.adobe.com/xap/1.0/\x00"


def _dms(value: float) -> tuple[float, float, float]:
    v = abs(value)
    d = int(v)
    m = int((v - d) * 60)
    s = round((v - d - m / 60) * 3600, 4)
    return (float(d), float(m), s)


def xmp_packet(fields: dict[str, float], notes: dict[str, str]) -> bytes:
    """A minimal XMP packet: ``drone-dji:`` numbers (what ``pose.read_pose`` reads) and
    ``sightline:`` notes on where they came from."""
    from xml.sax.saxutils import quoteattr

    attrs = " ".join(f'drone-dji:{k}="{v:+.2f}"' for k, v in fields.items())
    notes_s = " ".join(f"sightline:{k}={quoteattr(v)}" for k, v in notes.items())
    xml = (
        '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>'
        '<x:xmpmeta xmlns:x="adobe:ns:meta/">'
        '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        '<rdf:Description rdf:about="" xmlns:drone-dji="http://www.dji.com/drone-dji/1.0/"'
        ' xmlns:sightline="https://github.com/Drivera0/sightline/geotag/1.0/"'
        f" {attrs} {notes_s}/>"
        '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
    )
    return xml.encode("utf-8")


def insert_xmp(jpeg: bytes, packet: bytes) -> bytes:
    """``jpeg`` with an XMP APP1 segment after its APP0/APP1 (EXIF) segments."""
    if jpeg[:2] != b"\xff\xd8":
        raise ValueError("not a JPEG")
    seg = XMP_HEADER + packet
    if len(seg) + 2 > 0xFFFF:
        raise ValueError("XMP packet too large for one segment")
    i = 2
    while i + 4 <= len(jpeg) and jpeg[i] == 0xFF and jpeg[i + 1] in (0xE0, 0xE1):
        i += 2 + int.from_bytes(jpeg[i + 2 : i + 4], "big")
    return jpeg[:i] + b"\xff\xe1" + (len(seg) + 2).to_bytes(2, "big") + seg + jpeg[i:]


def write_geotag(
    image: Path | bytes,
    out: Path,
    *,
    lat: float,
    lon: float,
    rel_alt_m: float | None = None,
    abs_alt_m: float | None = None,
    yaw_deg: float | None = None,
    pitch_deg: float | None = None,
    f35_mm: float | None = None,
    when: datetime | None = None,
    notes: dict[str, str] | None = None,
    quality: int = 95,
) -> None:
    """Write ``out``: the image re-saved as JPEG with EXIF GPS (and altitude, 35 mm focal length,
    capture time) and a DJI-style XMP packet. Values left as None are left out, never filled."""
    from PIL import ExifTags, Image

    src = io.BytesIO(image) if isinstance(image, bytes) else image
    with Image.open(src) as im:
        rgb = im.convert("RGB")
        exif = im.getexif()
    g = exif.get_ifd(ExifTags.IFD.GPSInfo)
    g.clear()
    g.update(
        {
            0: b"\x02\x03\x00\x00",
            1: "N" if lat >= 0 else "S",
            2: _dms(lat),
            3: "E" if lon >= 0 else "W",
            4: _dms(lon),
        }
    )
    if abs_alt_m is not None:
        g.update({5: 0 if abs_alt_m >= 0 else 1, 6: round(abs(abs_alt_m), 2)})
    if yaw_deg is not None:
        g.update({16: "T", 17: round(yaw_deg % 360, 2)})
    details = exif.get_ifd(ExifTags.IFD.Exif)
    if f35_mm is not None:
        details[41989] = round(f35_mm)
    if when is not None:
        details[36867] = when.strftime("%Y:%m:%d %H:%M:%S")
        details[37521] = f"{when.microsecond // 1000:03d}"
    buf = io.BytesIO()
    rgb.save(buf, "JPEG", exif=exif, quality=quality)
    fields = {
        k: v
        for k, v in (
            ("RelativeAltitude", rel_alt_m),
            ("AbsoluteAltitude", abs_alt_m),
            ("GimbalYawDegree", None if yaw_deg is None else _signed_yaw(yaw_deg)),
            ("GimbalPitchDegree", pitch_deg),
        )
        if v is not None
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(insert_xmp(buf.getvalue(), xmp_packet(fields, notes or {})))


def _signed_yaw(yaw: float) -> float:
    """DJI writes yaw in -180..180."""
    y = yaw % 360
    return y - 360 if y > 180 else y
