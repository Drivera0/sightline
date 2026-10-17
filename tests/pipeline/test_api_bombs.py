"""Upload API: oversized images are refused with 400 and leave nothing behind."""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

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


# ---------------------------------------------------------------- oversized images


def test_an_image_with_more_pixels_than_the_app_allows_is_refused_with_400(tmp_path, monkeypatch):
    monkeypatch.setattr(api, "MAX_PIXELS", 1000)

    response = upload(client_for(tmp_path), make_zip({"big.jpg": jpeg_bytes((100, 100))}))

    assert response.status_code == 400
    assert "big.jpg" in response.json()["detail"] and "too many pixels" in response.json()["detail"]


def test_an_image_that_pillow_calls_a_decompression_bomb_is_refused_with_400(tmp_path, monkeypatch):
    monkeypatch.setattr(
        Image, "MAX_IMAGE_PIXELS", 1000
    )  # 1600x1200 is far past twice this: Pillow raises

    response = upload(client_for(tmp_path), make_zip({"bomb.jpg": jpeg_bytes((1600, 1200))}))

    assert response.status_code == 400
    assert (
        "bomb.jpg" in response.json()["detail"] and "too many pixels" in response.json()["detail"]
    )


def test_a_refused_bomb_leaves_no_files_behind(tmp_path, monkeypatch):
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 1000)

    upload(
        client_for(tmp_path),
        make_zip({"ok.jpg": jpeg_bytes((20, 20)), "bomb.jpg": jpeg_bytes((1600, 1200))}),
    )

    leftovers = [p for p in (tmp_path / "up").rglob("*")] if (tmp_path / "up").exists() else []
    assert leftovers == []
