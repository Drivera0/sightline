"""``sightline.geo.geotag``: DJI SRT tracks in both formats seen in the wild, Airdata and DJI flight
record CSVs, matching within 1 s (never inventing a position) and writing a geotag ``read_pose``
accepts. Every file is made here; no network, no GPU."""

from __future__ import annotations

import io
from pathlib import Path

import pytest
from PIL import ExifTags, Image

from sightline.geo.geotag import (
    course_deg,
    looks_reencoded,
    nearest,
    parse_flight_log,
    parse_srt,
    read_photo_meta,
    recording_starts,
    write_geotag,
)
from sightline.geo.pose import read_pose
from tests.fixtures.drone_photos import drone_photo

# DJI Mini 3 / Air 2S style: <font> tags, one cue per frame or per second.
SRT_NEW = """1
00:00:00,000 --> 00:00:00,033
<font size="28">FrameCnt: 1, DiffTime: 33ms
2026-10-18 14:03:11.123
[iso: 100] [shutter: 1/500.0] [fnum: 1.7] [ev: 0] [focal_len: 24.00] [latitude: 49.375000] [longitude: -122.937500] [rel_alt: 50.000 abs_alt: 650.200] [ct: 5500] </font>

2
00:00:01,000 --> 00:00:01,033
<font size="28">FrameCnt: 31, DiffTime: 33ms
2026-10-18 14:03:12.123
[iso: 100] [focal_len: 24.00] [latitude: 49.375090] [longitude: -122.937500] [rel_alt: 50.100 abs_alt: 650.300] [gb_yaw: 12.5 gb_pitch: -89.9 gb_roll: 0.0] </font>

3
00:00:02,000 --> 00:00:02,033
<font size="28">[latitude: 0.000000] [longitude: 0.000000] [rel_alt: 0.000 abs_alt: 0.000]</font>
"""

# Mavic Air 2: DJI's own typo "longtitude", "altitude" for the absolute one, focal_len in tenths.
SRT_AIR2 = """1
00:00:00,000 --> 00:00:01,000
[iso : 110] [shutter : 1/200.0] [fnum : 280] [ev : 0] [ct : 5500] [color_md : default] [focal_len : 240] [latitude: 46.123456] [longtitude: 7.654321] [altitude: 1890.12]
"""

# Phantom 4 / Mavic Pro: GPS(lon, lat, alt-or-sats) and BAROMETER height above take-off.
SRT_OLD = """1
00:00:00,000 --> 00:00:01,000
HOME(-122.9375,49.3750) 2017.08.05 14:11:51
GPS(-122.9376,49.3751,16) BAROMETER:51.9
ISO:100 Shutter:60 EV:0 Fnum:F2.2

2
00:00:01,000 --> 00:00:02,000
HOME(-122.9375,49.3750) 2017.08.05 14:11:52
GPS(-122.9376,49.3752,16) BAROMETER:52.1
"""

# Mavic 2 Pro: one line, comma separated.
SRT_MAVIC2 = """1
00:00:00,000 --> 00:00:01,000
F/2.8, SS 320, ISO 100, EV 0, DZOOM 1.000, GPS (-122.4194, 37.7749, 19), D 24.5m, H 10.2m, H.S 0.00m/s, V.S 0.00m/s
"""

AIRDATA = """time(millisecond),datetime(utc),latitude,longitude,height_above_takeoff(feet),altitude_above_seaLevel(feet),compass_heading(degrees),gimbal_heading(degrees),gimbal_pitch(degrees),isPhoto,isVideo
0,2026-10-18 21:03:10,49.375000,-122.937500,0,2100,10,10,-90,0,0
1000,2026-10-18 21:03:11,49.375000,-122.937500,100,2200,10,10,-90,0,0
2000,2026-10-18 21:03:12,49.375090,-122.937500,164,2264,10,11,-90,0,1
3000,2026-10-18 21:03:13,0,0,164,2264,10,12,-90,0,1
4000,2026-10-18 21:03:14,49.375270,-122.937500,164,2264,10,13,-90,0,1
5000,2026-10-18 21:03:15,49.375360,-122.937500,164,2264,10,13,-90,0,0
6000,2026-10-18 21:03:16,49.375450,-122.937500,164,2264,10,13,-90,0,1
"""

FLIGHT_RECORD = """CUSTOM.date [local],CUSTOM.updateTime [local],OSD.flyTime [s],OSD.latitude,OSD.longitude,OSD.height [ft],OSD.yaw [360],GIMBAL.pitch,CUSTOM.isVideo
10/18/2026,2:03:10.10 PM,0.0,49.375,-122.9375,0.0,90,-90,
10/18/2026,2:03:10.20 PM,0.1,49.375,-122.9374,32.8,90,-90,Recording
"""


def test_srt_new_format_keeps_fields_and_drops_no_fix() -> None:
    track = parse_srt(SRT_NEW)
    assert len(track.points) == 2 and track.skipped == 1  # the 0,0 cue is not a position
    a, b = track.points
    assert (a.lat, a.lon, a.rel_alt_m, a.abs_alt_m, a.f35_mm) == (
        49.375,
        -122.9375,
        50.0,
        650.2,
        24.0,
    )
    assert a.when is not None and a.when.second == 11 and a.when.microsecond == 123000
    assert a.yaw_deg is None and (b.yaw_deg, b.pitch_deg) == (12.5, -89.9)
    assert b.t_s == 1.0


def test_srt_air2_typo_and_tenths_focal_length() -> None:
    (p,) = parse_srt(SRT_AIR2).points
    assert (p.lat, p.lon, p.abs_alt_m, p.rel_alt_m, p.f35_mm) == (
        46.123456,
        7.654321,
        1890.12,
        None,
        24.0,
    )


def test_srt_old_gps_format_is_lon_lat() -> None:
    track = parse_srt(SRT_OLD)
    assert [(p.lat, p.lon, p.rel_alt_m) for p in track.points] == [
        (49.3751, -122.9376, 51.9),
        (49.3752, -122.9376, 52.1),
    ]
    (m2,) = parse_srt(SRT_MAVIC2).points
    assert (m2.lat, m2.lon, m2.rel_alt_m) == (37.7749, -122.4194, 10.2)


def test_nearest_never_reaches_past_the_tolerance() -> None:
    track = parse_srt(SRT_NEW)
    assert nearest(track, 0.4) is track.points[0]
    assert nearest(track, 1.9) is track.points[1]  # 0.9 s from the last fix
    assert nearest(track, 2.2) is None  # the 2 s cue had no fix: nothing within 1 s
    assert nearest(track, -1.5) is None


def test_airdata_log_feet_recording_and_no_fix_rows() -> None:
    track = parse_flight_log(AIRDATA)
    assert track.source == "Airdata CSV" and track.skipped == 1
    p = nearest(track, 2.0)
    assert p is not None and p.rel_alt_m == pytest.approx(50.0, abs=0.02)  # 164 ft
    assert p.yaw_deg == 11 and p.pitch_deg == -90
    assert recording_starts(track) == [2.0, 6.0]  # two clips; the 0,0 row didn't end the first


def test_dji_flight_record_log() -> None:
    track = parse_flight_log(FLIGHT_RECORD)
    assert track.source == "DJI flight record CSV"
    assert [p.t_s for p in track.points] == [0.0, 0.1]
    assert track.points[1].rel_alt_m == pytest.approx(10.0, abs=0.01)
    assert track.points[1].yaw_deg == 90  # aircraft compass: said in the notes
    assert track.notes == ["heading: aircraft compass (no gimbal heading column)"]
    assert recording_starts(track) == [0.1]


def test_flight_log_without_positions_is_refused() -> None:
    with pytest.raises(ValueError, match="latitude"):
        parse_flight_log("a,b\n1,2\n")


def test_course_over_ground() -> None:
    track = parse_flight_log(AIRDATA)
    assert course_deg(track, 4.0) == pytest.approx(0.0, abs=0.5)  # flying north
    assert course_deg(track, 0.5, window_s=0.6) is None  # parked: no course


def test_written_geotag_is_what_read_pose_needs(tmp_path: Path) -> None:
    src = tmp_path / "frame.jpg"
    Image.new("RGB", (400, 300), (90, 100, 80)).save(src)
    out = tmp_path / "tagged.jpg"
    write_geotag(
        src,
        out,
        lat=49.3751,
        lon=-122.9376,
        rel_alt_m=50.0,
        abs_alt_m=650.2,
        yaw_deg=350.0,
        pitch_deg=-90.0,
        f35_mm=24.0,
        notes={"NotMeasured": "pitch_deg: owner-stated (--assume-nadir)"},
    )
    info = read_pose(out)
    assert info is not None and info.nadir
    assert info.pose.lat == pytest.approx(49.3751, abs=1e-7)
    assert info.pose.lon == pytest.approx(-122.9376, abs=1e-7)
    assert info.pose.alt_agl_m == 50.0 and info.pose.heading_deg == pytest.approx(350.0)
    meta = read_photo_meta(out)
    assert meta.gps_alt_m == pytest.approx(650.2) and meta.img_direction_deg == pytest.approx(350)
    assert b"owner-stated (--assume-nadir)" in out.read_bytes()
    with Image.open(out) as im:  # still a plain JPEG any viewer opens
        assert im.format == "JPEG" and im.size == (400, 300)


def test_missing_values_are_left_out_not_filled(tmp_path: Path) -> None:
    out = tmp_path / "tagged.jpg"
    write_geotag(drone_photo(gps=False), out, lat=49.375, lon=-122.9375, rel_alt_m=50.0)
    assert read_pose(out) is None  # no yaw, no pitch: the API would refuse it, as it should
    meta = read_photo_meta(out)
    assert meta.has_gps and meta.yaw_deg is None and meta.pitch_deg is None
    assert meta.missing_for_api() == ["gimbal yaw", "gimbal pitch"]


def _phone_jpeg(lat=49.375, lon=-122.9375, direction=None, name="IMG_0001.jpg") -> bytes:
    im = Image.new("RGB", (4032, 3024), (100, 110, 90))
    exif = Image.Exif()
    exif[271], exif[272] = "Apple", "iPhone 15"
    g = exif.get_ifd(ExifTags.IFD.GPSInfo)
    g.update({1: "N", 2: (abs(lat), 0.0, 0.0), 3: "W", 4: (abs(lon), 0.0, 0.0)})
    if direction is not None:
        g[17] = direction
    d = exif.get_ifd(ExifTags.IFD.Exif)
    d[41989], d[36867] = 26, "2026:10:18 14:03:11"
    buf = io.BytesIO()
    im.save(buf, "JPEG", exif=exif, quality=60)
    return buf.getvalue()


def test_phone_photo_gsd_needs_a_stated_height(tmp_path: Path) -> None:
    p = tmp_path / "IMG_0001.jpg"
    p.write_bytes(_phone_jpeg(direction=45.0))
    meta = read_photo_meta(p)
    assert meta.has_gps and meta.rel_alt_m is None and meta.img_direction_deg == 45.0
    g, why = meta.gsd_m()
    assert g is None and "give --height-m" in why
    g, why = meta.gsd_m(height_m=30.0)
    assert why == "--height-m" and g == pytest.approx(0.0103, abs=0.0005)


def test_stripped_and_messenger_photos(tmp_path: Path) -> None:
    wa = tmp_path / "IMG-20261020-WA0001.jpg"
    Image.new("RGB", (1600, 1200)).save(wa)
    plain = tmp_path / "photo.jpg"
    Image.new("RGB", (1280, 960)).save(plain)
    assert "WhatsApp" in (looks_reencoded(read_photo_meta(wa)) or "")
    assert "messenger" in (looks_reencoded(read_photo_meta(plain)) or "")
    assert looks_reencoded(read_photo_meta(_write(tmp_path / "d.jpg", drone_photo()))) is None


def _write(p: Path, data: bytes) -> Path:
    p.write_bytes(data)
    return p


def test_piexif_made_photo_is_read(tmp_path: Path) -> None:
    piexif = pytest.importorskip("piexif")  # the "sim" extra; not installed in CI
    gps = {
        piexif.GPSIFD.GPSLatitudeRef: b"N",
        piexif.GPSIFD.GPSLatitude: ((49, 1), (22, 1), (3000, 100)),
        piexif.GPSIFD.GPSLongitudeRef: b"W",
        piexif.GPSIFD.GPSLongitude: ((122, 1), (56, 1), (1500, 100)),
    }
    data = piexif.dump({"0th": {}, "Exif": {}, "GPS": gps})
    p = tmp_path / "p.jpg"
    Image.new("RGB", (100, 80)).save(p, exif=data)
    meta = read_photo_meta(p)
    assert meta.lat == pytest.approx(49.375) and meta.lon == pytest.approx(-122.9375)
