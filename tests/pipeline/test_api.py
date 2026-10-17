"""The stretch upload API: GET /health, static cache, POST /survey (zip of JPEGs), GET /survey/<id>."""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from sightline.api.app import create_app
from sightline.pipeline.export import validate_cache
from sightline.pipeline.lanes import Lanes
from sightline.pipeline.sample import write_sample

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


def jpeg_bytes(size=(1600, 1200), colour=(90, 120, 80)) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", size, colour).save(buffer, "JPEG")
    return buffer.getvalue()


def make_zip(members: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, data in members.items():
            archive.writestr(name, data)
    return buffer.getvalue()


def photos(n: int = 6) -> dict[str, bytes]:
    return {f"IMG_{i:04d}.jpg": jpeg_bytes(colour=(60 + i, 120, 80)) for i in range(n)}


@pytest.fixture
def api(tmp_path):
    app = create_app(
        cache_root=tmp_path / "cache",
        data_root=tmp_path / "data" / "uploads",
        lanes_factory=no_lanes,
    )
    return TestClient(app), tmp_path


def upload(client: TestClient, data: bytes, name: str = "photos.zip"):
    return client.post("/survey", files={"file": (name, data, "application/zip")})


# ---------------------------------------------------------------- health and static files


def test_health_says_ok(api):
    client, _ = api

    response = client.get("/health")

    assert response.status_code == 200 and response.json() == {"status": "ok"}


def test_the_cache_folder_is_served_as_static_files(api):
    client, tmp_path = api
    write_sample(tmp_path / "cache" / "sample", web_out=None)

    response = client.get("/cache/sample/survey.json")

    assert response.status_code == 200 and response.json()["survey_id"] == "sample"


def test_files_outside_the_cache_folder_are_not_served(api):
    client, tmp_path = api
    (tmp_path / "secret.txt").write_text("secret")

    assert client.get("/cache/../secret.txt").status_code == 404
    assert client.get("/cache/%2e%2e/secret.txt").status_code == 404


# ---------------------------------------------------------------- a good upload


def test_uploading_photos_builds_a_valid_cache_in_upload_folder(api):
    client, tmp_path = api

    response = upload(client, make_zip(photos(6)))

    assert response.status_code == 202
    survey_id = response.json()["id"]
    status = client.get(f"/survey/{survey_id}").json()
    assert status["status"] == "done"
    assert status["cache"] == f"upload-{survey_id}"
    cache = tmp_path / "cache" / f"upload-{survey_id}"
    assert validate_cache(cache) == []
    assert len(list((cache / "frames").glob("*.jpg"))) == 6


def test_the_new_cache_is_reachable_over_http(api):
    client, _ = api
    survey_id = upload(client, make_zip(photos(3))).json()["id"]

    response = client.get(f"/cache/upload-{survey_id}/manifest.json")

    assert response.status_code == 200
    assert response.json()["survey_id"] == f"upload-{survey_id}"
    assert response.json()["n_frames"] == 3


def test_frames_follow_the_photo_names_in_order_and_are_resized_to_1000_by_750(api):
    client, tmp_path = api
    members = {
        "b.jpg": jpeg_bytes(colour=(10, 10, 10)),
        "a.jpg": jpeg_bytes(size=(800, 800), colour=(200, 200, 200)),
    }
    survey_id = upload(client, make_zip(members)).json()["id"]

    first = Image.open(tmp_path / "cache" / f"upload-{survey_id}" / "frames" / "f0001.jpg")

    assert first.size == (1000, 750)
    assert (
        sum(first.getpixel((500, 375))) > 300
    )  # f0001 is a.jpg (light, 600), not b.jpg (dark, 30)


def test_the_manifest_says_ranking_was_not_measured_and_what_was_a_placeholder(api):
    client, _ = api
    survey_id = upload(client, make_zip(photos(3))).json()["id"]

    notes = client.get(f"/cache/upload-{survey_id}/manifest.json").json()["notes"]

    assert "ranking" in notes and "build_map" in notes


def test_each_upload_gets_its_own_id_and_folder(api):
    client, tmp_path = api

    a = upload(client, make_zip(photos(2))).json()["id"]
    b = upload(client, make_zip(photos(2))).json()["id"]

    assert a != b
    assert (tmp_path / "cache" / f"upload-{a}").is_dir() and (
        tmp_path / "cache" / f"upload-{b}"
    ).is_dir()


def test_detect_gets_the_configured_weights_and_the_uploaded_frames(tmp_path):
    calls = []

    def run_survey(frames_dir, weights, out_dir, candidate_threshold, model_name, save_threshold):
        calls.append((Path(frames_dir), weights, candidate_threshold))
        from sightline.pipeline.formats import write_json
        from sightline.pipeline.placeholders import placeholder_detections

        ids = sorted(p.stem for p in Path(frames_dir).glob("*.jpg"))
        raw, config = placeholder_detections(ids, candidate_threshold, save_threshold)
        (Path(out_dir) / "crops").mkdir(parents=True, exist_ok=True)
        write_json(Path(out_dir) / "detections_raw.json", raw)
        write_json(Path(out_dir) / "config.json", config)

    def lanes():
        overrides = {name: None for name in LANE_NAMES} | {"run_survey": run_survey}
        return Lanes(overrides=overrides)

    app = create_app(
        cache_root=tmp_path / "cache",
        data_root=tmp_path / "up",
        lanes_factory=lanes,
        weights=Path("best.pt"),
    )
    client = TestClient(app)

    survey_id = upload(client, make_zip(photos(2))).json()["id"]

    assert client.get(f"/survey/{survey_id}").json()["status"] == "done"
    assert calls[0][1] == Path("best.pt") and calls[0][0].name == "frames"
    assert len(list(calls[0][0].glob("*.jpg"))) == 2


# ---------------------------------------------------------------- bad uploads


def test_a_file_that_is_not_a_zip_is_rejected(api):
    client, _ = api

    response = upload(client, b"this is not a zip")

    assert response.status_code == 400 and "zip" in response.json()["detail"].lower()


def test_a_zip_without_jpegs_is_rejected(api):
    client, _ = api

    response = upload(client, make_zip({"notes.txt": b"hello", "pic.png": b"x"}))

    assert response.status_code == 400 and "jpeg" in response.json()["detail"].lower()


def test_a_corrupt_jpeg_is_rejected_by_name(api):
    client, _ = api

    response = upload(client, make_zip({"good.jpg": jpeg_bytes(), "bad.jpg": b"not an image"}))

    assert response.status_code == 400 and "bad.jpg" in response.json()["detail"]


def test_too_many_photos_are_rejected(tmp_path):
    app = create_app(
        cache_root=tmp_path / "c", data_root=tmp_path / "d", lanes_factory=no_lanes, max_images=3
    )

    response = upload(TestClient(app), make_zip(photos(4)))

    assert response.status_code == 413 and "3" in response.json()["detail"]


def test_an_upload_over_the_size_limit_is_rejected(tmp_path):
    app = create_app(
        cache_root=tmp_path / "c",
        data_root=tmp_path / "d",
        lanes_factory=no_lanes,
        max_upload_bytes=1000,
    )

    response = upload(TestClient(app), make_zip(photos(2)))

    assert response.status_code == 413


def test_a_zip_that_expands_far_beyond_its_size_is_rejected(tmp_path):
    app = create_app(
        cache_root=tmp_path / "c",
        data_root=tmp_path / "d",
        lanes_factory=no_lanes,
        max_unpacked_bytes=5000,
    )
    bomb = make_zip({"big.jpg": b"\0" * 1_000_000})

    response = upload(TestClient(app), bomb)

    assert response.status_code == 413


def test_member_names_with_path_tricks_cannot_write_outside_the_upload_folder(api):
    client, tmp_path = api
    members = {"../../evil.jpg": jpeg_bytes(), "/abs/evil2.jpg": jpeg_bytes()}

    response = upload(client, make_zip(members))

    assert response.status_code == 202
    assert not (tmp_path / "evil.jpg").exists() and not Path("/abs/evil2.jpg").exists()
    assert not list(tmp_path.glob("**/evil*.jpg"))


def test_a_failing_stage_is_reported_and_leaves_no_cache(tmp_path):
    def boom(n, seed):
        raise RuntimeError("boom")

    def lanes():
        return Lanes(overrides={name: None for name in LANE_NAMES} | {"simulate_flight": boom})

    client = TestClient(
        create_app(cache_root=tmp_path / "cache", data_root=tmp_path / "up", lanes_factory=lanes)
    )

    survey_id = upload(client, make_zip(photos(2))).json()["id"]

    status = client.get(f"/survey/{survey_id}").json()
    assert status["status"] == "failed" and "place" in status["error"] and "boom" in status["error"]
    assert not (tmp_path / "cache" / f"upload-{survey_id}").exists()


# ---------------------------------------------------------------- status lookups


def test_an_unknown_survey_id_is_404(api):
    client, _ = api

    assert client.get("/survey/deadbeef").status_code == 404


def test_a_survey_id_with_path_characters_is_404(api):
    client, _ = api

    assert client.get("/survey/..%2F..%2Fetc").status_code == 404
