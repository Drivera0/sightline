"""``scripts/real_flight.py`` on synthetic footage: drone JPEGs, a phone photo, a stripped
messenger copy, a tiny ffmpeg video with a hand-written SRT and an Airdata log. ``run`` goes through
the real mission API (``create_app``) with a fake detector; ``--offline`` uses the fake backend.
No network, no GPU; the video tests skip when ffmpeg is missing."""

from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from sightline.api.app import create_app
from sightline.api.missions import MissionContext
from sightline.contract import EvidenceRef, Proposal
from sightline.geo.pose import read_pose
from sightline.mission import MissionStore
from sightline.mission.queue import LocalQueue
from sightline.ml.fake import FakeDetector as BackendFake
from sightline.ml.types import Box, RawDetection
from tests.fixtures.drone_photos import drone_photo
from tests.geo.test_geotag import AIRDATA, _phone_jpeg

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("real_flight", ROOT / "scripts" / "real_flight.py")
assert spec and spec.loader
rf = importlib.util.module_from_spec(spec)
sys.modules["real_flight"] = rf
spec.loader.exec_module(rf)

needs_ffmpeg = pytest.mark.skipif(not shutil.which("ffmpeg"), reason="ffmpeg not installed")

SRT = """1
00:00:00,000 --> 00:00:01,000
<font size="28">2026-10-18 14:03:11.000
[focal_len: 24.00] [latitude: 49.375000] [longitude: -122.937500] [rel_alt: 50.000 abs_alt: 650.200]</font>

2
00:00:01,000 --> 00:00:02,000
<font size="28">2026-10-18 14:03:12.000
[focal_len: 24.00] [latitude: 49.375090] [longitude: -122.937500] [rel_alt: 50.100 abs_alt: 650.300]</font>

3
00:00:02,000 --> 00:00:03,000
<font size="28">2026-10-18 14:03:13.000
[focal_len: 24.00] [latitude: 49.375180] [longitude: -122.937500] [rel_alt: 50.100 abs_alt: 650.300]</font>

4
00:00:03,000 --> 00:00:04,000
<font size="28">2026-10-18 14:03:14.000
[focal_len: 24.00] [latitude: 49.375270] [longitude: -122.937500] [rel_alt: 50.100 abs_alt: 650.300]</font>
"""


def _video(path: Path, seconds: int = 7) -> Path:
    subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi",
         "-i", "testsrc=size=320x240:rate=10", "-t", str(seconds), str(path)],
        check=True,
    )  # fmt: skip
    return path


def _oblique() -> bytes:
    return drone_photo().replace(b'GimbalPitchDegree="-90.0"', b'GimbalPitchDegree="-30.0"')


@pytest.fixture
def folder(tmp_path: Path) -> Path:
    f = tmp_path / "flight"
    f.mkdir()
    for i in range(3):
        (f / f"DJI_{i + 1:04d}.JPG").write_bytes(drone_photo(49.375 + i * 1e-4))
    (f / "IMG_0001.jpg").write_bytes(_phone_jpeg())
    Image.new("RGB", (1600, 1200), (80, 90, 70)).save(f / "IMG-20261020-WA0001.jpg")
    (f / "DJI_0009.JPG").write_bytes(_oblique())
    (f / "notes.txt").write_text("hello")
    return f


# --- inspect ----------------------------------------------------------------------------------


def test_inspect_verdicts_span_and_warnings(folder: Path) -> None:
    (folder / "flight.csv").write_text(AIRDATA)
    (folder / "DJI_0100.SRT").write_text(SRT)
    report = rf.inspect_folder(folder, height_m=30.0)
    v = {f["file"]: f for f in report["files"]}
    assert v["DJI_0001.JPG"]["verdict"] == "usable as-is"
    assert v["DJI_0001.JPG"]["gsd_cm"] == pytest.approx(9.01, abs=0.01)  # 50 m, 24 mm, 800 px
    assert v["IMG_0001.jpg"]["verdict"] == "needs geotag from log"
    assert "phone-style" in v["IMG_0001.jpg"]["why"]
    assert v["IMG_0001.jpg"]["gsd_from"] == "--height-m"
    assert v["IMG-20261020-WA0001.jpg"]["verdict"] == "unusable"
    assert "WhatsApp" in v["IMG-20261020-WA0001.jpg"]["why"]
    assert v["DJI_0009.JPG"]["verdict"] == "unusable" and "pitch -30" in v["DJI_0009.JPG"]["why"]
    assert v["notes.txt"]["verdict"] == "unusable"
    assert v["flight.csv"]["type"] == "flight log (Airdata CSV)"
    assert v["flight.csv"]["records"] == 6 and v["flight.csv"]["no_fix_records"] == 1
    assert v["DJI_0100.SRT"]["records"] == 4 and v["DJI_0100.SRT"]["duration_s"] == 3.0
    span = report["span"]
    assert span["photos"] == 6 and span["with_gps"] == 5
    assert span["bbox_lat_lon"] == [49.375, -122.9375, 49.3752, -122.9375]
    assert any("re-encoded" in w for w in report["warnings"])
    assert any("1 of 6 photos have no GPS" in w for w in report["warnings"])
    lines: list[str] = []
    rf.print_inspect(report, lines.append)
    text = "\n".join(lines)
    assert "-> usable as-is" in text and "WARNING: " in text and "verdicts: usable as-is 3" in text


def test_inspect_warns_when_gps_is_stripped_or_zero(tmp_path: Path) -> None:
    for i in range(2):
        Image.new("RGB", (1200, 900)).save(tmp_path / f"p{i}.jpg")
    (tmp_path / "zero.jpg").write_bytes(drone_photo(0.0, 0.0))
    report = rf.inspect_folder(tmp_path)
    assert {f["file"]: f["verdict"] for f in report["files"]}["zero.jpg"] == "unusable"
    assert any("GPS is 0,0 in 1 photos" in w for w in report["warnings"])
    only_stripped = tmp_path / "s"
    only_stripped.mkdir()
    Image.new("RGB", (1200, 900)).save(only_stripped / "a.jpg")
    assert rf.inspect_folder(only_stripped)["warnings"][0].startswith("GPS looks stripped")


@needs_ffmpeg
def test_inspect_sees_a_video_and_its_srt(tmp_path: Path) -> None:
    _video(tmp_path / "DJI_0100.MP4", 2)
    (tmp_path / "DJI_0100.SRT").write_text(SRT)
    (row,) = [f for f in rf.inspect_folder(tmp_path)["files"] if f["type"] == "video"]
    assert row["srt"] == "DJI_0100.SRT" and row["duration_s"] == pytest.approx(2.0, abs=0.2)
    assert row["verdict"] == "needs geotag from log" and "frames DJI_0100.MP4" in row["why"]


# --- frames -----------------------------------------------------------------------------------


def _frames_args(video: Path, out: Path, **kw) -> argparse.Namespace:
    return rf.parser().parse_args(["frames", str(video), "--out", str(out), *kw.pop("extra", [])])


@needs_ffmpeg
def test_frames_from_srt_skip_what_the_track_does_not_cover(tmp_path: Path) -> None:
    video = _video(tmp_path / "DJI_0100.MP4", 7)
    (tmp_path / "DJI_0100.SRT").write_text(SRT)  # found next to the video
    out = tmp_path / "frames"
    lines: list[str] = []
    args = _frames_args(video, out, extra=["--every", "2s", "--assume-nadir"])
    assert rf.cmd_frames(args, lines.append) == 0
    m = json.loads((out / "geotag.json").read_text())
    # frames at 0, 2, 4, 6 s; the track ends at 3 s: 4 s is within 1 s of it, 6 s is not
    assert m["extracted"] == 4 and m["written"] == 3 and m["skipped_count"] == 1
    assert m["skipped"] == [{"t_s": 6.0, "reason": "no track point within 1 s"}]
    f0, f2 = m["frames"][0], m["frames"][1]
    assert (f0["lat"], f0["rel_alt_m"], f0["f35_mm"]) == (49.375, 50.0, 24.0)
    assert f2["sources"]["yaw_deg"] == "derived (course over ground from the track)"
    assert f2["sources"]["pitch_deg"] == "owner-stated (--assume-nadir)"
    for f in m["frames"]:
        info = read_pose(out / f["file"])
        assert info is not None and info.nadir and info.pose.lat == pytest.approx(f["lat"])
    assert sorted(p.name for p in out.glob("*.jpg")) == [
        "DJI_0100_00000000ms.jpg",
        "DJI_0100_00002000ms.jpg",
        "DJI_0100_00004000ms.jpg",
    ]
    assert any("1 skipped" in s for s in lines)


@needs_ffmpeg
def test_frames_without_pitch_say_so_and_the_api_would_refuse(tmp_path: Path) -> None:
    video = _video(tmp_path / "v.mp4", 3)
    srt = tmp_path / "track.srt"
    srt.write_text(SRT)
    out = tmp_path / "frames"
    lines: list[str] = []
    rf.cmd_frames(_frames_args(video, out, extra=["--srt", str(srt)]), lines.append)
    assert any("--assume-nadir" in s for s in lines)
    infos = [read_pose(p) for p in out.glob("*.jpg")]
    assert infos and all(not i.nadir for i in infos if i)  # no pitch: the API says not nadir


@needs_ffmpeg
def test_frames_from_an_airdata_log(tmp_path: Path) -> None:
    video = _video(tmp_path / "v.mp4", 5)
    log = tmp_path / "flight.csv"
    log.write_text(AIRDATA)
    out = tmp_path / "frames"
    lines: list[str] = []
    args = _frames_args(video, out, extra=["--log", str(log), "--every", "1s", "--f35", "24"])
    rf.cmd_frames(args, lines.append)
    m = json.loads((out / "geotag.json").read_text())
    assert m["log_offset_s"] == 2.0  # the first isVideo row
    assert "the log has 2 recordings; using no. 1 (--clip)" in lines
    # video t = 0..4 → log t = 2..6; log t = 3 is a 0,0 row, but 2 s and 4 s are within 1 s
    assert m["written"] == 5 and m["skipped_count"] == 0
    first = m["frames"][0]
    assert first["sources"]["yaw_deg"] == "measured" and first["yaw_deg"] == 11.0
    assert first["sources"]["f35_mm"] == "owner-stated (--f35)"
    assert read_pose(out / first["file"]) is not None  # gimbal pitch from the log: -90


def test_parse_every() -> None:
    assert rf.parse_every("2s") == 2.0 and rf.parse_every("500ms") == 0.5
    assert rf.parse_every("1.5") == 1.5
    with pytest.raises(argparse.ArgumentTypeError):
        rf.parse_every("fast")


# --- run --------------------------------------------------------------------------------------


class Detector:
    """One candidate (0.8) and one low box, in original pixels."""

    def detect_tiled(self, path, conf: float = 0.05):
        return [RawDetection(Box(400, 300, 424, 340), 0.8), RawDetection(Box(10, 10, 20, 20), 0.07)]


class Hooks:
    """The agent stand-in: a candidate becomes a proposal, as the real agent would propose."""

    def on_detection(self, store: MissionStore, mid: str, det_id: str) -> None:
        if store.state(mid)["proposals"]:
            return
        store.add_proposal(
            mid,
            Proposal(
                id="",
                kind="promote_detection",
                summary=f"Promote {det_id} for review",
                reason="candidate",
                briefing=None,
                target={"detection": det_id},
                evidence=[EvidenceRef(kind="crop", ref=det_id, caption="crop")],
                status="pending",
                created_by="agent",
                created_at="2026-10-22T00:00:00Z",
                decided_at=None,
                decided_by=None,
                decision_reason=None,
                edits=None,
            ),
        )

    def __getattr__(self, name: str):
        if not name.startswith("on_"):
            raise AttributeError(name)
        return lambda *a: None


@pytest.fixture
def api(tmp_path: Path):
    store = MissionStore(tmp_path / "missions")
    ctx = MissionContext(store, queue=LocalQueue(), detector_factory=Detector, hooks=Hooks())
    ctx.start()
    app = create_app(cache_root=tmp_path / "cache", data_root=tmp_path / "up", missions=ctx)
    with TestClient(app) as client:
        yield client
    ctx.queue.stop()


def test_run_through_the_api(api, folder: Path, tmp_path: Path) -> None:
    out_dir = tmp_path / "report"
    lines: list[str] = []
    r = rf.run_api(
        api, folder, name="Lynn Canyon", out_dir=out_dir, proposal_wait_s=5, out=lines.append
    )
    assert r["photos_found"] == 6 and r["photos_sent"] == 3 and r["accepted"] == 3
    assert r["lkp_from"] == "the first photo's position (no --lkp given)"
    assert [p["name"] for p in r["photos"]] == ["DJI_0001.JPG", "DJI_0002.JPG", "DJI_0003.JPG"]
    reasons = {x["name"]: x["reason"] for x in r["not_sent"]}
    assert reasons["IMG_0001.jpg"].startswith("detector only: no drone pose (give --height-m")
    assert "WhatsApp" in reasons["IMG-20261020-WA0001.jpg"]
    assert "pitch -30" in reasons["DJI_0009.JPG"]
    det = r["photos"][0]["detections"][0]
    assert det["score"] == 0.8 and det["box_photo_px"] == [24, 40]  # 800×600 photo
    assert det["box_frame_px"] == [30, 50]  # the 1000×750 display frame
    assert len(r["top_crops"]) == 5 and r["top_crops"][0]["how"] == "server crop"
    assert r["top_crops"][-1]["how"] == "cut locally from the original"  # 0.07: no server crop
    assert all((out_dir / c["file"]).is_file() for c in r["top_crops"])
    assert r["proposals"][0]["kind"] == "promote_detection"
    assert r["timings_s"]["first_proposal_s"] is not None
    assert r["detector"] == "cv2"  # what /health names; the test injects its own detector
    r |= {"folder": str(folder), "started": "now", "label": rf.LABEL, "api": "http://test"}
    md = rf.report_md(r)
    assert "real flight, real detector, fleet simulated" in md
    assert "| DJI_0001.JPG | f0001-d01 | 0.80 | 24 × 40 |" in md
    assert "Source: not labelled" in md
    assert "clear" not in md.lower()


def test_run_sends_a_phone_photo_only_with_stated_values(api, tmp_path: Path) -> None:
    f = tmp_path / "phone"
    f.mkdir()
    (f / "IMG_0001.jpg").write_bytes(_phone_jpeg(direction=45.0))
    r = rf.run_api(
        api,
        f,
        height_m=30.0,
        assume_nadir=True,
        lkp=(49.375, -122.9375),
        out_dir=tmp_path / "rep",
        proposal_wait_s=5,
        out=lambda s: None,
    )
    assert r["accepted"] == 1 and r["lkp_from"] == "given (--lkp)"
    staged = tmp_path / "rep" / "staged" / "IMG_0001.jpg"
    info = read_pose(staged)
    assert info is not None and info.pose.alt_agl_m == 30.0 and info.pose.heading_deg == 45.0
    assert b"pose completed from values the owner stated" in staged.read_bytes()
    assert r["photos"][0]["gsd_m"] > 0


def test_run_refuses_a_folder_with_nothing_the_api_can_place(api, tmp_path: Path) -> None:
    (tmp_path / "a.jpg").write_bytes(_phone_jpeg())
    with pytest.raises(SystemExit, match="--offline"):
        rf.run_api(api, tmp_path, out_dir=tmp_path / "rep", out=lambda s: None)


def test_run_offline_with_the_fake_backend(folder: Path, tmp_path: Path) -> None:
    r = rf.run_offline(folder, out_dir=tmp_path / "rep", detector=BackendFake(), out=lambda s: None)
    assert r["mode"] == "offline" and r["detector"] == "FakeDetector"
    assert len(r["photos"]) == 6  # every readable JPEG, GPS or not
    assert all(c["how"] == "cut locally from the original" for c in r["top_crops"])
    r |= {"folder": str(folder), "started": "now", "label": rf.LABEL}
    rf.write_report(r, tmp_path / "rep")
    md = (tmp_path / "rep" / "report.md").read_text()
    assert "offline" in md and "Proposals" not in md
    assert "fake detector (fixed boxes, no model): not for the take" in md
    assert json.loads((tmp_path / "rep" / "report.json").read_text())["mode"] == "offline"


def test_cmd_run_offline_writes_the_report(folder: Path, tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("SIGHTLINE_BACKEND", "fake")
    out = tmp_path / "rep"
    args = rf.parser().parse_args(["run", str(folder), "--offline", "--out", str(out)])
    assert rf.cmd_run(args, out=lambda s: None) == 0
    assert (out / "report.md").is_file() and (out / "crops").is_dir()


# --- label ------------------------------------------------------------------------------------


def test_label_writes_provenance_the_report_cites(folder: Path, tmp_path: Path) -> None:
    asked: list[str] = []
    args = rf.parser().parse_args(
        ["label", str(folder), "--source", "friend's DJI Mini 3, 2026-10"]
    )
    rf.cmd_label(args, out=lambda s: None, ask=lambda q: asked.append(q) or "may be shown")
    prov = json.loads((folder / "provenance.json").read_text())
    assert asked and prov["permission"] == "may be shown"
    assert prov["label"] == "real flight, real detector, fleet simulated"
    assert prov["fields"]["relative altitude (DJI XMP)"] == "measured in 4 of 6 photos"
    r = rf.run_offline(folder, out_dir=tmp_path / "rep", detector=BackendFake(), out=lambda s: None)
    r |= {"folder": str(folder), "started": "now", "label": rf.LABEL}
    r["provenance"] = rf.load_provenance(folder)
    assert "Source: friend's DJI Mini 3, 2026-10; permission: may be shown" in rf.report_md(r)
    # inspect skips its own sidecar
    assert "provenance.json" not in {f["file"] for f in rf.inspect_folder(folder)["files"]}


@needs_ffmpeg
def test_label_on_frames_reports_what_was_derived(tmp_path: Path) -> None:
    video = _video(tmp_path / "DJI_0100.MP4", 3)
    (tmp_path / "DJI_0100.SRT").write_text(SRT)
    out = tmp_path / "frames"
    rf.cmd_frames(_frames_args(video, out, extra=["--assume-nadir"]), lambda s: None)
    fields = rf.field_sources(out)
    assert fields["lat"] == "measured in 2"
    assert fields["pitch_deg"] == "owner-stated (--assume-nadir) in 2"
    assert "SRT DJI_0100.SRT" in fields["note"]
