"""Upload API: frames are streamed to disk one at a time."""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

import sightline.api.app as api
from sightline.api.app import create_app
from sightline.pipeline.lanes import Lanes

LANE_NAMES = [
    "simulate_flight",
    "footprint",
    "georef_detection",
    "run_survey",
    "load_split",
    "build_map",
    "simulate",
]


def no_lanes() -> Lanes:
    return Lanes(overrides={name: None for name in LANE_NAMES})


def jpeg_bytes(size=(400, 300), colour=(90, 120, 80)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, colour).save(buffer, "JPEG")
    return buffer.getvalue()


def make_zip(members: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in members.items():
            archive.writestr(name, data)
    return buffer.getvalue()


def client_for(tmp_path: Path) -> TestClient:
    app = create_app(
        cache_root=tmp_path / "cache", data_root=tmp_path / "up", lanes_factory=no_lanes
    )
    return TestClient(app, raise_server_exceptions=False)


def upload(client: TestClient, data: bytes):
    return client.post("/survey", files={"file": ("photos.zip", data, "application/zip")})


# ---------------------------------------------------------------- streaming


def test_photos_are_decoded_one_at_a_time_not_all_up_front(monkeypatch):
    decoded = []
    real_decode = api._decode
    monkeypatch.setattr(
        api, "_decode", lambda name, data: decoded.append(name) or real_decode(name, data)
    )
    archive = zipfile.ZipFile(io.BytesIO(make_zip({f"p{i}.jpg": jpeg_bytes() for i in range(5)})))
    members = api._select_members(archive, max_images=10, max_unpacked_bytes=10**9)

    frames = api._iter_frames(archive, members)
    next(frames)
    assert decoded == ["p0.jpg"]
    next(frames)
    assert decoded == ["p0.jpg", "p1.jpg"]


def test_each_frame_is_saved_to_disk_before_the_next_photo_is_decoded(tmp_path, monkeypatch):
    frames_on_disk_at_decode = []
    real_decode = api._decode

    def watching_decode(name, data):
        folders = list((tmp_path / "up").glob("*/survey/frames"))
        frames_on_disk_at_decode.append(len(list(folders[0].glob("*.jpg"))) if folders else 0)
        return real_decode(name, data)

    monkeypatch.setattr(api, "_decode", watching_decode)

    response = upload(client_for(tmp_path), make_zip({f"p{i}.jpg": jpeg_bytes() for i in range(4)}))

    assert response.status_code == 202
    assert frames_on_disk_at_decode == [0, 1, 2, 3]


def test_a_rejected_upload_leaves_no_files_behind(tmp_path):
    members = {"a.jpg": jpeg_bytes(), "b.jpg": b"not an image", "c.jpg": jpeg_bytes()}

    response = upload(client_for(tmp_path), make_zip(members))

    assert response.status_code == 400 and "b.jpg" in response.json()["detail"]
    assert not any((tmp_path / "up").rglob("*")) if (tmp_path / "up").exists() else True


def test_the_unpacked_size_limit_is_checked_before_any_photo_is_decoded(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "_decode", lambda name, data: pytest.fail("must not decode"))
    app = create_app(
        cache_root=tmp_path / "c",
        data_root=tmp_path / "d",
        lanes_factory=no_lanes,
        max_unpacked_bytes=10,
    )

    response = upload(TestClient(app), make_zip({"a.jpg": jpeg_bytes()}))

    assert response.status_code == 413
