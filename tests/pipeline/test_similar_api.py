"""``GET /missions/{id}/similar`` (sightline/api/similar.py) on the real store: ranked look-alikes
with scores and crop paths, text queries, discoverable in OpenAPI, and paid embedding calls only for
callers holding the write token when one is set. No network: the embedder is a fake."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient

from sightline.api import similar as similar_api
from sightline.api.app import create_app
from sightline.api.missions import MissionContext
from sightline.contract import LatLon
from sightline.mission import MissionStore
from sightline.mission.queue import LocalQueue
from sightline.ml import similar
from tests.ml.test_similar import TagEmbedder, _det, _frame, _jpeg

TOKEN = "test-token-not-a-secret"
TAGS = {b"red": [1.0, 0.0, 0.0], b"near-red": [0.9, 0.3, 0.0], b"rock": [0.0, 1.0, 0.0]}


class CountingEmbedder(TagEmbedder):
    def __init__(self) -> None:
        super().__init__(TAGS)
        self.texts: list[str] = []

    def embed_text(self, text):
        self.texts.append(text)
        return np.array([0.0, 1.0, 0.0], np.float32)  # every text looks like a rock here


@pytest.fixture
def make(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("SIGHTLINE_API_TOKEN", raising=False)
    similar_api._texts.clear()
    made: list[tuple[TestClient, MissionContext]] = []

    def build(token: str | None = None, embedder=None):
        store = MissionStore(tmp_path / f"m{len(made)}")
        ctx = MissionContext(store, queue=LocalQueue(), hooks=None)
        app = create_app(cache_root=tmp_path / "cache", data_root=tmp_path / "up", missions=ctx,
                         api_token=token)  # fmt: skip
        app.state.similar_embedder = embedder
        mid = store.create("m", "a", LatLon(lat=49.37, lon=-122.94), "live").mission_id
        store.append_frame(mid, _frame("f0001"), _jpeg((0, 90, 0), (1000, 750)))
        store.append_detections(
            mid,
            "f0001",
            [_det("f0001-d01", 0.7, "crops/f0001-d01.jpg"), _det("f0001-d02", 0.4, "crops/f0001-d02.jpg"),
             _det("f0001-d03", 0.2, None), _det("f0001-d04", 0.1, None)],
            {"crops/f0001-d01.jpg": b"red", "crops/f0001-d02.jpg": b"near-red",
             "crops/nearmiss/f0001-d03.jpg": b"rock", "crops/nearmiss/f0001-d04.jpg": b"red"},
        )  # fmt: skip
        client = TestClient(app)
        made.append((client, ctx))
        return client, mid

    yield build
    for _, ctx in made:
        ctx.queue.stop()


def test_ranked_lookalikes_with_scores_and_crops(make) -> None:
    emb = CountingEmbedder()
    client, mid = make(embedder=emb)
    r = client.get(f"/missions/{mid}/similar", params={"detection": "f0001-d01", "min_score": 0})
    assert r.status_code == 200, r.text
    body = r.json()
    assert [x["detection"] for x in body["results"]] == ["f0001-d02", "f0001-d03"]  # not itself
    top = body["results"][0]
    assert top["score"] == pytest.approx(0.9 / np.hypot(0.9, 0.3), abs=1e-3)
    assert top == {**top, "frame": "f0001", "conf": 0.4, "crop": "crops/f0001-d02.jpg"}
    assert body["results"][1]["crop"] == "crops/nearmiss/f0001-d03.jpg"
    assert body["indexed"] == 3 and body["embedded_now"] == 3  # f0001-d04 is under 0.15
    assert client.get(f"/missions/{mid}/files/{top['crop']}").status_code == 200

    default = client.get(f"/missions/{mid}/similar", params={"detection": "f0001-d01"}).json()
    assert default["min_score"] == similar.DEFAULT_THRESHOLD == 0.92 and [
        x["detection"] for x in default["results"]
    ] == ["f0001-d02"]  # the rock is under the threshold chosen on val
    assert default["embedded_now"] == 0  # cached next to the mission


def test_text_and_crop_plus_text(make) -> None:
    emb = CountingEmbedder()
    client, mid = make(embedder=emb)
    r = client.get(f"/missions/{mid}/similar", params={"text": "grey rock", "k": 1})
    assert [x["detection"] for x in r.json()["results"]] == ["f0001-d03"]
    assert r.json()["min_score"] is None  # text scores sit on another scale: plain top-k
    both = client.get(
        f"/missions/{mid}/similar",
        params={"detection": "f0001-d02", "text": "grey rock", "min_score": 0},
    ).json()
    assert both["query"] == {"detection": "f0001-d02", "text": "grey rock",
                             "crop": "crops/f0001-d02.jpg"}  # fmt: skip
    assert emb.texts == ["grey rock"]  # the second text query came from the cache


def test_bad_queries(make) -> None:
    client, mid = make(embedder=CountingEmbedder())
    assert client.get(f"/missions/{mid}/similar").status_code == 422
    assert (
        client.get(f"/missions/{mid}/similar", params={"detection": "f0009-d01"}).status_code == 404
    )
    assert (
        client.get("/missions/nope/similar", params={"detection": "f0001-d01"}).status_code == 404
    )
    r = client.get(f"/missions/{mid}/similar", params={"detection": "f0001-d04"})
    assert r.status_code == 409 and "under 0.15" in r.json()["detail"]
    assert (
        client.get(
            f"/missions/{mid}/similar", params={"detection": "f0001-d01", "k": 0}
        ).status_code
        == 422
    )


def test_with_the_write_token_only_its_holder_may_cause_embedding_calls(make) -> None:
    emb = CountingEmbedder()
    client, mid = make(token=TOKEN, embedder=emb)
    q = {"detection": "f0001-d01"}
    r = client.get(f"/missions/{mid}/similar", params=q)
    assert r.status_code == 409 and "send the API token" in r.json()["detail"] and emb.seen == []
    r = client.get(f"/missions/{mid}/similar", params={"text": "red jacket"})
    assert r.status_code == 401 and emb.texts == []

    auth = {"Authorization": f"Bearer {TOKEN}"}
    assert (
        client.get(f"/missions/{mid}/similar", params=q, headers=auth).json()["embedded_now"] == 3
    )
    assert (
        client.get(
            f"/missions/{mid}/similar", params={"text": "red jacket"}, headers=auth
        ).status_code
        == 200
    )

    open_read = client.get(f"/missions/{mid}/similar", params={**q, "text": "red jacket"})
    assert open_read.status_code == 200 and open_read.json()["embedded_now"] == 0  # all cached
    wrong = client.get(f"/missions/{mid}/similar", params={"text": "blue"},
                       headers={"Authorization": "Bearer nope"})  # fmt: skip
    assert wrong.status_code == 401


def test_without_a_key_the_search_says_it_is_off(make) -> None:
    client, mid = make(embedder=None)
    r = client.get(f"/missions/{mid}/similar", params={"detection": "f0001-d01"})
    assert r.status_code == 409
    r = client.get(f"/missions/{mid}/similar", params={"text": "red jacket"})
    assert r.status_code == 503 and "NVIDIA_API_KEY" in r.json()["detail"]


def test_discoverable_in_openapi(make) -> None:
    client, _ = make(embedder=None)
    op = client.get("/openapi.json").json()["paths"]["/missions/{mission_id}/similar"]["get"]
    assert {p["name"] for p in op["parameters"]} >= {
        "mission_id",
        "detection",
        "text",
        "k",
        "min_score",
    }
    assert "missions" in op["tags"] and "NVIDIA" in op["description"]
