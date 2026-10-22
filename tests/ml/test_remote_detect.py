"""The detector over HTTP: the endpoint app (sightline/serve/detect_app.py) and the worker's switch
``SIGHTLINE_DETECT_URL`` (sightline/ml/remote.py), against a mocked HTTP server. No model files."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import ClassVar

import cv2
import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from sightline.ml import backend
from sightline.ml.remote import RemoteDetector
from sightline.ml.types import Box, RawDetection
from sightline.serve.detect_app import create_app


class _Fake:
    """Records what it was given; two boxes, one over the 0.29 candidate threshold."""

    def __init__(self) -> None:
        self.shapes: list[tuple[int, ...]] = []

    def detect_tiled(self, image: np.ndarray, conf: float = 0.05) -> list[RawDetection]:
        self.shapes.append(image.shape)
        dets = [RawDetection(Box(1, 2, 5, 9), 0.1), RawDetection(Box(10, 10, 30, 50), 0.73456)]
        return [d for d in dets if d.conf >= conf]


@pytest.fixture
def photo(tmp_path: Path) -> Path:
    p = tmp_path / "f0001.jpg"
    cv2.imwrite(str(p), np.full((60, 80, 3), 128, np.uint8))
    return p


def test_detect_returns_boxes_and_timing(photo: Path) -> None:
    fake = _Fake()
    with TestClient(create_app(fake)) as c:
        assert c.get("/healthz").json()["status"] == "ok"
        r = c.post("/detect", files={"photo": ("f.jpg", photo.read_bytes(), "image/jpeg")})
    body = r.json()
    assert r.status_code == 200 and fake.shapes == [(60, 80, 3)]
    assert (body["width"], body["height"]) == (80, 60)
    assert body["boxes"][0] == {
        "box": [10, 10, 30, 50],
        "conf": 0.73456,
    }  # highest first, not rounded
    assert body["n_candidates"] == 1 and body["candidate_threshold"] == 0.29
    assert set(body["timing_ms"]) == {"decode", "detect", "total"}


def test_conf_query_and_bad_photo() -> None:
    with TestClient(create_app(_Fake())) as c:
        bad = c.post("/detect", files={"photo": ("x.jpg", b"not a photo", "image/jpeg")})
        assert bad.status_code == 400
        _, png = cv2.imencode(".png", np.zeros((8, 8, 3), np.uint8))
        r = c.post("/detect?conf=0.5", files={"photo": ("p.png", png.tobytes(), "image/png")})
    assert [b["conf"] for b in r.json()["boxes"]] == [0.73456]


def test_optional_token_in_the_container(photo: Path, monkeypatch) -> None:
    monkeypatch.setenv("SIGHTLINE_DETECT_TOKEN", "s3cret")
    files = {"photo": ("f.jpg", photo.read_bytes(), "image/jpeg")}
    with TestClient(create_app(_Fake())) as c:
        assert c.get("/healthz").status_code == 200  # health stays open
        assert c.post("/detect", files=files).status_code == 401
        ok = c.post("/detect", files=files, headers={"Authorization": "Bearer s3cret"})
    assert ok.status_code == 200


class _Mock(BaseHTTPRequestHandler):
    seen: ClassVar[list[dict]] = []

    def do_POST(self) -> None:
        body = self.rfile.read(int(self.headers["Content-Length"]))
        _Mock.seen.append(
            {"path": self.path, "auth": self.headers.get("Authorization"), "body": body}
        )
        out = {"boxes": [{"box": [1, 1, 4, 4], "conf": 0.2}, {"box": [3, 4, 20, 30], "conf": 0.8}]}
        data = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_: object) -> None:
        pass


@pytest.fixture
def mock_url():
    _Mock.seen = []
    server = HTTPServer(("127.0.0.1", 0), _Mock)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{server.server_port}"
    server.shutdown()


def test_env_switch_sends_the_photo_bytes_to_the_endpoint(photo: Path, mock_url, monkeypatch):
    monkeypatch.setenv("SIGHTLINE_DETECT_URL", mock_url + "/")
    monkeypatch.setenv("SIGHTLINE_DETECT_TOKEN", "tok")
    monkeypatch.delenv("SIGHTLINE_BACKEND", raising=False)
    det = backend.make_detector()
    assert isinstance(det, RemoteDetector)
    dets = det.detect_tiled(photo, conf=0.05)
    assert [(d.box, d.conf) for d in dets] == [(Box(3, 4, 20, 30), 0.8), (Box(1, 1, 4, 4), 0.2)]
    (req,) = _Mock.seen
    assert req["path"] == "/detect?conf=0.05" and req["auth"] == "Bearer tok"
    assert photo.read_bytes() in req["body"]  # the original JPEG, not re-encoded


def test_local_detector_stays_the_default(monkeypatch, tmp_path) -> None:
    monkeypatch.delenv("SIGHTLINE_DETECT_URL", raising=False)
    monkeypatch.setenv("SIGHTLINE_BACKEND", "fake")
    assert type(backend.make_detector()).__name__ == "FakeDetector"
    monkeypatch.setenv("SIGHTLINE_DETECT_URL", "http://127.0.0.1:9")
    assert type(backend.make_detector()).__name__ == "FakeDetector"  # fake/torch ignore the URL


def test_round_trip_through_the_app_matches_the_detector(photo: Path) -> None:
    """RemoteDetector → detect_app → detector: the same boxes as calling the detector directly."""
    fake = _Fake()
    with TestClient(create_app(fake)) as c:
        remote = RemoteDetector("http://testserver", client=c)
        assert remote.health()["status"] == "ok"
        via_http = remote.detect_tiled(photo)
        pixels = remote.detect_array(np.zeros((16, 24, 3), np.uint8))  # PNG, lossless
    direct = fake.detect_tiled(cv2.imread(str(photo)))
    assert via_http == sorted(direct, key=lambda d: -d.conf)
    assert len(pixels) == 2 and fake.shapes[1] == (16, 24, 3)


def test_unreachable_endpoint_raises() -> None:
    """The pipeline turns this into a frame with no detections and a note (ingest_photo)."""
    det = RemoteDetector("http://127.0.0.1:9", timeout_s=2)  # nothing listens on the discard port
    with pytest.raises(httpx.HTTPError):
        det.detect_array(np.zeros((4, 4, 3), np.uint8))
