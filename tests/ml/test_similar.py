"""``sightline/ml/similar.py``: the embedding client (request shape, batching, pacing, retries), the
index and its cache, cosine top-k. No network: the HTTP post is a fake."""

from __future__ import annotations

import io

import numpy as np
import pytest
from PIL import Image

from sightline.contract import Detection, Frame, LatLon, Pose, Source
from sightline.ml import similar
from tests.agent.fake_store import FakeMissionStore

KEY = "nvapi-test-not-a-secret"


class FakePost:
    """Answers each call from ``script`` in turn: an int status, an exception, or "ok"."""

    def __init__(self, script=("ok",), dim: int = 4) -> None:
        self.script, self.dim, self.calls = list(script), dim, []

    def __call__(self, url, json, headers, timeout):
        self.calls.append({"url": url, "json": json, "headers": headers, "timeout": timeout})
        step = self.script.pop(0) if len(self.script) > 1 else self.script[0]
        if isinstance(step, Exception):
            raise step
        if step != "ok":
            return step, {"detail": f"status {step}"}
        n = len(json["input"])
        data = [
            {"index": i, "embedding": [float(i + 1)] + [1.0] * (self.dim - 1)} for i in range(n)
        ]
        return 200, {"data": data[::-1], "usage": {"total_tokens": 266 * n}}


def _embedder(post, **kw) -> similar.NvidiaEmbedder:
    kw.setdefault("min_interval", 0.0)
    return similar.NvidiaEmbedder(KEY, post=post, sleep=lambda s: None, **kw)


def _jpeg(colour=(200, 30, 30), size=(64, 64)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, colour).save(buf, "JPEG")
    return buf.getvalue()


def test_image_request_has_the_vl_models_modality_and_passage_type() -> None:
    post = FakePost()
    out = _embedder(post).embed_images([_jpeg(), _jpeg()])
    body = post.calls[0]["json"]
    assert body["model"] == similar.DEFAULT_MODEL == "nvidia/llama-nemotron-embed-vl-1b-v2"
    assert body["modality"] == ["image", "image"] and body["input_type"] == "passage"
    assert all(s.startswith("data:image/jpeg;base64,") for s in body["input"])
    assert post.calls[0]["headers"]["Authorization"] == f"Bearer {KEY}"
    assert out.shape == (2, 4)
    assert np.allclose(np.linalg.norm(out, axis=1), 1.0)
    assert out[0][0] < out[1][0]  # rows follow "index", not the order the server sent them


def test_text_is_a_query_and_nvclip_takes_plain_inputs() -> None:
    post = FakePost()
    _embedder(post).embed_text("person in a red jacket")
    assert post.calls[0]["json"]["input_type"] == "query"
    assert "modality" not in post.calls[0]["json"]
    post = FakePost()
    _embedder(post, model="nvidia/nvclip").embed_images([_jpeg()])
    assert set(post.calls[0]["json"]) == {"model", "input", "encoding_format"}


def test_batches_of_16_and_stats() -> None:
    post = FakePost()
    e = _embedder(post)
    out = e.embed_images([_jpeg()] * 20)
    assert [len(c["json"]["input"]) for c in post.calls] == [16, 4]
    assert out.shape == (20, 4)
    assert e.stats.requests == 2 and e.stats.items == 20 and e.stats.tokens == 20 * 266


def test_a_hung_call_is_retried_and_a_wrong_request_is_not() -> None:
    post = FakePost([TimeoutError("read timed out"), 502, "ok"])
    e = _embedder(post)
    e.embed_text("x")
    assert len(post.calls) == 3 and e.stats.retries == 2 and e.stats.failed_attempts == 2
    assert all(c["timeout"] == similar.EMBED_TIMEOUT_S for c in post.calls)

    post = FakePost([404])
    with pytest.raises(similar.EmbedError, match="HTTP 404") as err:
        _embedder(post).embed_text("x")
    assert len(post.calls) == 1 and KEY not in str(err.value)

    post = FakePost([TimeoutError()])
    with pytest.raises(similar.EmbedError, match="TimeoutError"):
        _embedder(post, retries=3).embed_text("x")
    assert len(post.calls) == 3


def test_calls_are_paced_to_the_rate_limit() -> None:
    now = [0.0]
    slept: list[float] = []

    def sleep(s: float) -> None:
        slept.append(s)
        now[0] += s

    e = similar.NvidiaEmbedder(KEY, post=FakePost(), clock=lambda: now[0], sleep=sleep)
    for _ in range(3):
        e.embed_text("x")
    assert slept == [pytest.approx(similar.MIN_INTERVAL_S)] * 2


def test_no_key_no_embedder(monkeypatch: pytest.MonkeyPatch) -> None:
    assert similar.default_embedder() is None
    with pytest.raises(similar.EmbedError):
        similar.NvidiaEmbedder("")
    monkeypatch.setenv("NVIDIA_API_KEY", KEY)
    monkeypatch.setenv("SIGHTLINE_EMBED_MODEL", "nvidia/nvclip")
    assert similar.default_embedder().model == "nvidia/nvclip"


def test_top_k_threshold_exclude_and_fuse() -> None:
    ids = ["a", "b", "c", "d"]
    v = similar.unit(np.array([[1, 0], [0.9, 0.1], [0.6, 0.8], [0, 1]], dtype=np.float32))
    got = similar.top_k(v[0], ids, v, k=3, exclude={"a"})
    assert [m.id for m in got] == ["b", "c", "d"] and got[0].score > got[1].score
    assert [m.id for m in similar.top_k(v[0], ids, v, k=5, min_score=0.5, exclude={"a"})] == [
        "b",
        "c",
    ]
    assert similar.top_k(v[0], [], v[:0], k=3) == []
    f = similar.fuse(np.array([1.0, 0.0]), np.array([0.0, 2.0]))
    assert np.allclose(f, [2**-0.5, 2**-0.5])


def test_index_round_trips_through_bytes() -> None:
    idx = similar.Index.empty("m")
    idx.add(["x", "y"], np.array([[3.0, 4.0], [1.0, 0.0]]))
    back = similar.Index.from_bytes(idx.to_bytes())
    assert back.model == "m" and back.ids == ["x", "y"]
    assert np.allclose(back.vector("x"), [0.6, 0.8])


# --- a mission's index ----------------------------------------------------------------------


class TagEmbedder:
    """Embeds by exact bytes: crops are written as tag bytes, so tests pick the vectors."""

    model = "fake/embed"

    def __init__(self, vectors: dict[bytes, list[float]]) -> None:
        self.vectors, self.seen = vectors, []

    def embed_images(self, images):
        self.seen += list(images)
        return np.array([self.vectors.get(b, [0.0, 0.0, 1.0]) for b in images], np.float32)

    def embed_text(self, text):
        return np.array([1.0, 0.0, 0.0], np.float32)


def _frame(fid: str) -> Frame:
    return Frame(
        id=fid,
        file=f"frames/{fid}.jpg",
        width_px=1000,
        height_px=750,
        flight_index=int(fid[1:]) - 1,
        source=Source(image=f"{fid}.jpg", x0=0, y0=0),
        pose=Pose(lat=49.37, lon=-122.94, alt_agl_m=50, heading_deg=0, gsd_m=0.02),
        footprint=((0, 0), (0.001, 0), (0.001, -0.001), (0, -0.001)),
        score=0.5,
        rank=int(fid[1:]),
        n_candidates=1,
    )


def _det(did: str, conf: float, crop: str | None) -> Detection:
    return Detection(
        id=did, box_px=(480, 340, 510, 400), conf=conf, crop=crop, lat=49.37, lon=-122.94,
        radius_m=10,
    )  # fmt: skip


def test_build_index_embeds_each_crop_once_and_cuts_missing_crops() -> None:
    store = FakeMissionStore()
    mid = store.create("m", "a", LatLon(lat=49.37, lon=-122.94), "live").mission_id
    store.append_frame(mid, _frame("f0001"), _jpeg((10, 200, 10), (1000, 750)))
    store.append_detections(
        mid,
        "f0001",
        [_det("f0001-d01", 0.6, "crops/f0001-d01.jpg"), _det("f0001-d02", 0.2, None),
         _det("f0001-d03", 0.1, None)],
        {"crops/f0001-d01.jpg": b"red"},
    )  # fmt: skip
    emb = TagEmbedder({b"red": [1.0, 0.0, 0.0]})
    built = similar.build_index(store, mid, emb, min_conf=0.15)
    assert built.index.ids == ["f0001-d01", "f0001-d02"] and built.embedded_now == 2
    assert built.crops["f0001-d02"] == "similar/crops/f0001-d02.jpg"  # cut from the frame
    with Image.open(io.BytesIO(store.read_file(mid, "similar/crops/f0001-d02.jpg"))) as im:
        assert im.size == (256, 256)
    assert store.read_file(mid, similar.index_path("fake/embed"))  # cached next to the mission

    again = similar.build_index(store, mid, emb, min_conf=0.15)
    assert again.embedded_now == 0 and len(emb.seen) == 2
    assert again.crops["f0001-d02"] == "similar/crops/f0001-d02.jpg"

    store.append_frame(mid, _frame("f0002"), _jpeg((10, 10, 200), (1000, 750)))
    store.append_detections(mid, "f0002", [_det("f0002-d01", 0.4, "c2.jpg")], {"c2.jpg": b"b"})
    cached_only = similar.build_index(store, mid, emb, min_conf=0.15, allow_calls=False)
    assert cached_only.embedded_now == 0 and "f0002-d01" not in cached_only.index.ids
    assert similar.build_index(store, mid, emb, min_conf=0.15).embedded_now == 1


def test_crop_from_the_original_photo_at_review_crop_scale() -> None:
    store = FakeMissionStore()
    mid = store.create("m", "a", LatLon(lat=49.37, lon=-122.94), "live").mission_id
    store.append_frame(mid, _frame("f0001"), _jpeg((0, 0, 0), (1000, 750)))
    orig = Image.new("RGB", (4000, 3000), (0, 0, 0))
    orig.paste((255, 255, 255), (1980, 1480, 2020, 1520))  # the frame's centre, in the original
    buf = io.BytesIO()
    orig.save(buf, "JPEG")
    store.put_file(mid, "frames/orig/f0001.jpg", buf.getvalue())
    det = _det("f0001-d01", 0.2, None).model_copy(update={"box_px": (495, 370, 505, 380)})
    rel, data = similar.crop_for(store, mid, det, _frame("f0001"))
    with Image.open(io.BytesIO(data)) as im:
        centre = np.asarray(im.convert("L"))[128, 128]
        corner = np.asarray(im.convert("L"))[5, 5]
    assert rel == "similar/crops/f0001-d01.jpg" and centre > 200 and corner < 50
