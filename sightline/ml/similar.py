"""Photos like this crop: hosted NVIDIA embeddings over a flight's detection crops (docs/report/SIMILAR.md).

Every detection crop of a mission is embedded once with a hosted NVIDIA embedding model and kept on
disk next to the mission (``similar/<model>.npz``); a query is a crop already in the index, or a
text ("person in a red jacket"), and the answer is the cosine top-k above a threshold.

Which model (checked live on 2026-10-22, ``GET https://integrate.api.nvidia.com/v1/models`` and one
call each, the key in ``NVIDIA_API_KEY``):

- ``nvidia/nvclip`` (NV-CLIP): listed, but ``POST /v1/embeddings`` answers 404 "Function ...: Not
  found for account".
- ``nv-dinov2`` (``ai.api.nvidia.com/v1/cv/nvidia/nv-dinov2``): 404, the same message.
- ``nvidia/llama-3.2-nemoretriever-1b-vlm-embed-v1``: listed, 404 the same way.
- ``nvidia/llama-nemotron-embed-vl-1b-v2``: **live**, 2048-d, text and images. An image is a
  ``data:image/...;base64,`` URL with ``"modality": ["image", ...]`` (one per input) and
  ``"input_type": "passage"``; a text query is ``"input_type": "query"``. Without ``modality`` an
  image request hangs until the gateway's 120 s timeout, and calls that should work sometimes
  hang the same way (about half of them on 2026-10-22), so each attempt has a short timeout
  and is retried (``EMBED_TIMEOUT_S``, ``RETRIES``).

The hosted endpoints are the free trial (about 40 requests a minute per model), so requests are
batched (``BATCH``) and paced (``MIN_INTERVAL_S``). Nothing here runs without a key, and the tests
use a fake client (no network).
"""

from __future__ import annotations

import base64
import io
import logging
import os
import threading
import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from typing import Any, Protocol

import numpy as np

log = logging.getLogger(__name__)

BASE_URL = "https://integrate.api.nvidia.com/v1"
DEFAULT_MODEL = "nvidia/llama-nemotron-embed-vl-1b-v2"
# Tried in this order on 2026-10-22; only the last answered (module docstring).
CHECKED_MODELS = (
    ("nvidia/nvclip", "404 Not found for account"),
    ("nvidia/nv-dinov2", "404 Not found for account"),
    ("nvidia/llama-3.2-nemoretriever-1b-vlm-embed-v1", "404 Not found for account"),
    ("nvidia/llama-nemotron-embed-vl-1b-v2", "200, 2048-d, text and images"),
)
BATCH = 16  # images per request: 14 crops took 2.6 s in one call
MIN_INTERVAL_S = 1.6  # 40 requests a minute at most, with a little room
# Per attempt. On 2026-10-22 about half of all requests hung (6 of 12 in a row, any batch size,
# until the gateway gave up at 120 s), and every healthy one answered within 3 s; so a short
# timeout and several attempts.
EMBED_TIMEOUT_S = 10.0
RETRIES = 6  # attempts per request (at a 50 % hang rate, 1 in 64 requests fails)
TOKENS_PER_IMAGE = 266  # what the endpoint reports for one crop (any size: it resizes)
# Crop-to-crop similarity at or above which a crop counts as "like" the query. Chosen on val
# (scripts/eval_similar.py, docs/report/SIMILAR.md); never tuned on test. Crop pairs of this model
# sit high (median 0.81 person-person, 0.78 person-other): at 0.92, the top 3 near-misses from other
# photos of the flight were people 0.375 of the time, against 0.215 for any near-miss. A text query
# lives on another scale (text-crop 0.1-0.45), so it gets no default threshold.
DEFAULT_THRESHOLD = 0.92
DEFAULT_K = 5


class EmbedError(RuntimeError):
    """The embedding endpoint failed (after its retries) or is not configured."""


class Embedder(Protocol):
    model: str

    def embed_images(self, images: Sequence[bytes]) -> np.ndarray: ...

    def embed_text(self, text: str) -> np.ndarray: ...


@dataclass
class CallStats:
    """What the endpoint cost, for the trace and the report: requests, items, tokens, ms each."""

    requests: int = 0
    items: int = 0
    tokens: int = 0
    retries: int = 0
    failed_attempts: int = 0  # timeouts and errors, retried or not
    ms: list[int] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "requests": self.requests,
            "items": self.items,
            "tokens": self.tokens,
            "retries": self.retries,
            "failed_attempts": self.failed_attempts,
            "ms_total": sum(self.ms),
        }


def unit(m: np.ndarray) -> np.ndarray:
    """Rows scaled to length 1 (a zero row stays zero), as float32."""
    m = np.asarray(m, dtype=np.float32)
    n = np.linalg.norm(m, axis=-1, keepdims=True)
    return m / np.where(n == 0, 1.0, n)


def _data_url(img: bytes) -> str:
    kind = "png" if img[:8] == b"\x89PNG\r\n\x1a\n" else "jpeg"
    return f"data:image/{kind};base64,{base64.b64encode(img).decode()}"


class NvidiaEmbedder:
    """``POST {base_url}/embeddings`` on build.nvidia.com, batched, paced and retried.

    ``post`` is injectable for tests: ``post(url, json, headers, timeout) -> (status, body dict)``.
    The key is only ever sent in the Authorization header; it is never logged or traced.
    """

    def __init__(
        self,
        api_key: str,
        model: str = DEFAULT_MODEL,
        base_url: str = BASE_URL,
        *,
        batch: int = BATCH,
        min_interval: float = MIN_INTERVAL_S,
        timeout: float = EMBED_TIMEOUT_S,
        retries: int = RETRIES,
        post: Callable[..., tuple[int, Any]] | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if not api_key:
            raise EmbedError("no NVIDIA_API_KEY: the similar-photo search needs it")
        self._key = api_key
        self.model, self.base_url = model, base_url.rstrip("/")
        self.batch, self.min_interval, self.timeout, self.retries = (
            batch,
            min_interval,
            timeout,
            retries,
        )
        self._post = post or self._httpx_post
        self._clock, self._sleep = clock, sleep
        self._lock = threading.Lock()
        self._next = 0.0
        self.stats = CallStats()

    @staticmethod
    def _httpx_post(url: str, json: dict, headers: dict, timeout: float) -> tuple[int, Any]:
        import httpx

        r = httpx.post(url, json=json, headers=headers, timeout=timeout)
        try:
            body = r.json()
        except ValueError:
            body = {"detail": r.text[:300]}
        return r.status_code, body

    def _body(self, inputs: list[str], kind: str) -> dict:
        body: dict[str, Any] = {"model": self.model, "input": inputs, "encoding_format": "float"}
        if "nvclip" in self.model:  # NV-CLIP takes text and data URLs side by side, no more
            return body
        body["input_type"] = "query" if kind == "text" else "passage"
        if kind == "image":
            body["modality"] = ["image"] * len(inputs)
        return body

    def _pace(self) -> None:
        with self._lock:
            wait = self._next - self._clock()
            if wait > 0:
                self._sleep(wait)
            self._next = max(self._next, self._clock()) + self.min_interval

    def _request(self, inputs: list[str], kind: str) -> np.ndarray:
        url = f"{self.base_url}/embeddings"
        headers = {"Authorization": f"Bearer {self._key}", "Accept": "application/json"}
        last = ""
        for attempt in range(self.retries):
            self._pace()
            t0 = time.perf_counter()
            try:
                status, body = self._post(url, self._body(inputs, kind), headers, self.timeout)
            except Exception as e:  # noqa: BLE001 - a timeout or a dropped connection: try again
                status, body = 0, {"detail": type(e).__name__}
            ms = round((time.perf_counter() - t0) * 1000)
            if status == 200:
                data = sorted(body["data"], key=lambda d: d.get("index", 0))
                self.stats.requests += 1
                self.stats.items += len(inputs)
                self.stats.tokens += int((body.get("usage") or {}).get("total_tokens") or 0)
                self.stats.ms.append(ms)
                self.stats.retries += attempt
                return unit(np.array([d["embedding"] for d in data], dtype=np.float32))
            self.stats.failed_attempts += 1
            last = f"HTTP {status}: {str(body.get('detail') or body.get('error') or body)[:200]}"
            if status in (400, 401, 403, 404, 422):  # the request itself is wrong: no retry
                break
            log.warning("embedding %s attempt %d failed: %s", kind, attempt + 1, last)
        raise EmbedError(f"{self.model}: {last}")

    def embed_images(self, images: Sequence[bytes]) -> np.ndarray:
        out = [
            self._request([_data_url(b) for b in images[i : i + self.batch]], "image")
            for i in range(0, len(images), self.batch)
        ]
        return np.concatenate(out) if out else np.zeros((0, 0), np.float32)

    def embed_text(self, text: str) -> np.ndarray:
        return self._request([text], "text")[0]


def default_embedder() -> NvidiaEmbedder | None:
    """The hosted embedder from ``NVIDIA_API_KEY`` (model: ``SIGHTLINE_EMBED_MODEL``), or None
    when there is no key: the similar-photo search is then off and says so."""
    key = os.environ.get("NVIDIA_API_KEY", "").strip()
    if not key:
        return None
    return NvidiaEmbedder(key, os.environ.get("SIGHTLINE_EMBED_MODEL", DEFAULT_MODEL))


# --- the index ------------------------------------------------------------------------------


@dataclass
class Index:
    """Unit embeddings of detection crops, one row per id, for one model."""

    model: str
    ids: list[str]
    vectors: np.ndarray  # (n, d) float32, unit rows

    def to_bytes(self) -> bytes:
        buf = io.BytesIO()
        np.savez_compressed(
            buf, model=np.array(self.model), ids=np.array(self.ids), vectors=self.vectors
        )
        return buf.getvalue()

    @classmethod
    def from_bytes(cls, data: bytes) -> Index:
        with np.load(io.BytesIO(data), allow_pickle=False) as z:
            return cls(str(z["model"]), [str(i) for i in z["ids"]], z["vectors"].astype(np.float32))

    @classmethod
    def empty(cls, model: str) -> Index:
        return cls(model, [], np.zeros((0, 0), np.float32))

    def add(self, ids: list[str], vectors: np.ndarray) -> None:
        if not ids:
            return
        vectors = unit(vectors)
        self.vectors = vectors if not self.ids else np.concatenate([self.vectors, vectors])
        self.ids = [*self.ids, *ids]

    def vector(self, id_: str) -> np.ndarray:
        return self.vectors[self.ids.index(id_)]


@dataclass(frozen=True)
class Match:
    id: str
    score: float


def top_k(
    query: np.ndarray,
    ids: Sequence[str],
    vectors: np.ndarray,
    k: int = DEFAULT_K,
    min_score: float | None = None,
    exclude: Iterable[str] = (),
) -> list[Match]:
    """The ``k`` ids most like ``query`` by cosine, best first, at or above ``min_score``,
    without ``exclude`` (the query's own id). Ties keep index order."""
    if len(ids) == 0 or k <= 0:
        return []
    scores = vectors @ unit(query)
    skip = set(exclude)
    out: list[Match] = []
    for i in np.argsort(-scores, kind="stable"):
        if ids[i] in skip:
            continue
        s = float(scores[i])
        if min_score is not None and s < min_score:
            break
        out.append(Match(ids[i], round(s, 4)))
        if len(out) == k:
            break
    return out


def fuse(image_vec: np.ndarray, text_vec: np.ndarray, text_weight: float = 0.5) -> np.ndarray:
    """One query from a crop and a text: the weighted mean of the two unit vectors, renormalised."""
    return unit((1 - text_weight) * unit(image_vec) + text_weight * unit(text_vec))


# --- crops of a mission ---------------------------------------------------------------------


def cut_crop(image: bytes, box: Sequence[float], window_px: int = 128, out_px: int = 256) -> bytes:
    """The review crop's shape (``sightline.ml.crops.make_crop``) cut from image bytes: a
    ``window_px`` square on the box centre, black past the edges, ``out_px`` square, JPEG 90."""
    from PIL import Image

    from sightline.ml.crops import crop_window

    with Image.open(io.BytesIO(image)) as im:
        out = crop_window(im.convert("RGB"), box, window_px, out_px)
    buf = io.BytesIO()
    out.save(buf, "JPEG", quality=90)
    return buf.getvalue()


def _try_read(store: Any, mission_id: str, rel: str | None) -> bytes | None:
    if not rel:
        return None
    try:
        return store.read_file(mission_id, rel)
    except (KeyError, FileNotFoundError, ValueError):
        return None


def crop_for(store: Any, mission_id: str, det: Any, frame: Any) -> tuple[str, bytes | None]:
    """A crop of ``det`` at the review crop's scale: the review crop (conf >= 0.29), D's near-miss
    crop or the second look's, else one cut here from the original photo (``frames/orig``, box
    scaled from the frame), else from the frame. Returns ``(path, bytes)``; a crop cut here is
    saved under ``similar/crops/`` so the web app can show it."""
    for rel in (det.crop, f"crops/nearmiss/{det.id}.jpg", f"relook/{det.id}-crop.jpg"):
        data = _try_read(store, mission_id, rel)
        if data is not None:
            return rel, data
    rel = f"similar/crops/{det.id}.jpg"
    data = _try_read(store, mission_id, rel)
    if data is not None:
        return rel, data
    x1, y1, x2, y2 = det.box_px
    orig = _try_read(store, mission_id, f"frames/orig/{frame.id}.jpg")
    if orig is not None:
        from PIL import Image

        with Image.open(io.BytesIO(orig)) as im:
            w, h = im.size
        sx, sy = w / frame.width_px, h / frame.height_px
        box, src = (x1 * sx, y1 * sy, x2 * sx, y2 * sy), orig
    else:
        src = _try_read(store, mission_id, frame.file)
        box = (x1, y1, x2, y2)
    if src is None:
        return rel, None
    data = cut_crop(src, box)
    store.put_file(mission_id, rel, data)
    return rel, data


_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _mission_lock(mission_id: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(mission_id, threading.Lock())


def index_path(model: str) -> str:
    return f"similar/{model.replace('/', '__')}.npz"


def load_index(store: Any, mission_id: str, model: str) -> Index:
    data = _try_read(store, mission_id, index_path(model))
    return Index.from_bytes(data) if data is not None else Index.empty(model)


def detections_by_id(store: Any, mission_id: str) -> dict[str, tuple[Any, str]]:
    """Every detection of the mission: id → (detection, frame id)."""
    frames = store.detections(mission_id).frames
    return {d.id: (d, fid) for fid, dets in frames.items() for d in dets}


@dataclass
class Built:
    index: Index
    crops: dict[str, str]  # detection id → crop path
    embedded_now: int
    stats: dict | None
    ms: int


def build_index(
    store: Any,
    mission_id: str,
    embedder: Embedder | None,
    *,
    min_conf: float = 0.0,
    allow_calls: bool = True,
) -> Built:
    """The mission's index, embedding only crops not in the cache yet (``allow_calls=False``:
    none, the cached rows only). One build at a time per mission, so two callers never pay for
    the same crop twice."""
    t0 = time.perf_counter()
    model = embedder.model if embedder is not None else DEFAULT_MODEL
    with _mission_lock(mission_id):
        index = load_index(store, mission_id, model)
        frames = {f.id: f for f in store.survey(mission_id).frames}
        dets = detections_by_id(store, mission_id)
        crops: dict[str, str] = {}
        todo: list[tuple[str, bytes]] = []
        known = set(index.ids)
        for did, (det, fid) in dets.items():
            if det.conf < min_conf:
                continue
            if did in known:
                crops[did] = det.crop or _cached_crop_path(store, mission_id, det)
                continue
            if not allow_calls or embedder is None:
                continue
            rel, data = crop_for(store, mission_id, det, frames[fid])
            if data is not None:
                crops[did] = rel
                todo.append((did, data))
        stats = None
        if todo:
            before = _stats(embedder)
            vectors = embedder.embed_images([b for _, b in todo])  # type: ignore[union-attr]
            index.add([i for i, _ in todo], vectors)
            store.put_file(mission_id, index_path(model), index.to_bytes())
            stats = _stats_delta(before, _stats(embedder))
    return Built(index, crops, len(todo), stats, round((time.perf_counter() - t0) * 1000))


def _cached_crop_path(store: Any, mission_id: str, det: Any) -> str:
    for rel in (f"crops/nearmiss/{det.id}.jpg", f"relook/{det.id}-crop.jpg"):
        if _try_read(store, mission_id, rel) is not None:
            return rel
    return f"similar/crops/{det.id}.jpg"


def _stats(embedder: Any) -> dict | None:
    s = getattr(embedder, "stats", None)
    return s.as_dict() if isinstance(s, CallStats) else None


def _stats_delta(before: dict | None, after: dict | None) -> dict | None:
    if before is None or after is None:
        return None
    return {k: after[k] - before[k] for k in after}
