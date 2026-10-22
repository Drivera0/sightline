"""``GET /missions/{id}/similar``: the flight's photos most like a crop or a text (docs/report/SIMILAR.md).

A read: it changes nothing in the mission (the embedding cache and crops cut for it are files next to
the mission, like the second look's images). It can cost hosted embedding calls, though: crops not
embedded yet, and a text query. With the write token set (``SIGHTLINE_API_TOKEN``), only a request
that carries the token may cause those calls; anyone else is answered from the cache, or gets 401
for a text that was never embedded. Without the token the API is open, as for every other route.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from typing import Any

import numpy as np
from fastapi import APIRouter, HTTPException, Query, Request

from sightline.agent.similar_tool import MIN_CONF
from sightline.api.auth import bearer_problem
from sightline.ml import similar

similar_router = APIRouter(tags=["missions"])

TEXT_CACHE = 256  # text queries kept per process
TEXT_WEIGHT = 0.5  # crop + text: the mean of the two unit vectors (val: SIMILAR.md)
_texts: OrderedDict[tuple[str, str], np.ndarray] = OrderedDict()


def _embedder(request: Request) -> Any:
    """``app.state.similar_embedder`` (tests put a fake there), else the hosted one from
    ``NVIDIA_API_KEY``, made once; None without a key."""
    if not hasattr(request.app.state, "similar_embedder"):
        request.app.state.similar_embedder = similar.default_embedder()
    return request.app.state.similar_embedder


def _may_call(request: Request) -> bool:
    token = getattr(request.app.state, "api_token", None)
    return not token or bearer_problem(request.headers.get("authorization"), token) is None


def _text_vector(embedder: Any, text: str, may_call: bool) -> np.ndarray:
    key = (embedder.model if embedder is not None else similar.DEFAULT_MODEL, text)
    if key in _texts:
        _texts.move_to_end(key)
        return _texts[key]
    if embedder is None:
        raise HTTPException(503, "text search is off: no NVIDIA_API_KEY on the server")
    if not may_call:
        raise HTTPException(401, "a new text query costs an embedding call: send the API token")
    try:
        vec = embedder.embed_text(text)
    except similar.EmbedError as e:
        raise HTTPException(502, f"embedding endpoint failed: {e}") from None
    _texts[key] = vec
    while len(_texts) > TEXT_CACHE:
        _texts.popitem(last=False)
    return vec


@similar_router.get("/missions/{mission_id}/similar")
def get_similar(
    mission_id: str,
    request: Request,
    detection: str | None = Query(None, description="a detection id, e.g. f0336-d01"),
    text: str | None = Query(None, max_length=200, description='e.g. "person in a red jacket"'),
    k: int = Query(similar.DEFAULT_K, ge=1, le=50),
    min_score: float | None = Query(
        None,
        ge=-1,
        le=1,
        description=f"default {similar.DEFAULT_THRESHOLD} for a crop query (chosen on val); "
        "none for a text query, whose scores sit on another scale",
    ),
) -> dict:
    """The mission's detections most like a crop (``detection``), a text, or both (the mean of the
    two), best first: ``{detection, frame, score, conf, crop}`` per result, ``crop`` being a path
    under ``GET /missions/{id}/files/``. Cosine similarity of hosted NVIDIA embeddings
    (``sightline/ml/similar.py``); crops under confidence 0.15 are not indexed. Read-only for the
    mission; see the module docstring for when it may call the embedding endpoint."""
    from sightline.api.missions import _store

    t0 = time.perf_counter()
    if not detection and not (text and text.strip()):
        raise HTTPException(422, "give a detection id, a text, or both")
    store = _store(request, mission_id)
    dets = similar.detections_by_id(store, mission_id)
    if detection is not None and detection not in dets:
        raise HTTPException(404, f"no detection {detection} in this mission")
    embedder = _embedder(request)
    may_call = _may_call(request)
    try:
        built = similar.build_index(
            store, mission_id, embedder, min_conf=MIN_CONF, allow_calls=may_call
        )
    except similar.EmbedError as e:
        raise HTTPException(502, f"embedding endpoint failed: {e}") from None
    index = built.index
    query: np.ndarray | None = None
    if detection is not None:
        if detection not in index.ids:
            why = (
                f"its confidence is under {MIN_CONF}"
                if dets[detection][0].conf < MIN_CONF
                else "it is not embedded yet (send the API token)"
                if not may_call
                else "it has no crop"
            )
            raise HTTPException(409, f"{detection} is not in the similarity index: {why}")
        query = index.vector(detection)
    if text and text.strip():
        tvec = _text_vector(embedder, text.strip(), may_call)
        query = tvec if query is None else similar.fuse(query, tvec, TEXT_WEIGHT)
    # The val threshold is for crop-to-crop similarity; a text (or crop + text) query sits on
    # another scale, so it is plain top-k unless the caller sets min_score.
    has_text = bool(text and text.strip())
    default = None if has_text else similar.DEFAULT_THRESHOLD
    threshold = default if min_score is None else min_score
    matches = similar.top_k(
        query, index.ids, index.vectors, k=k, min_score=threshold, exclude={detection} - {None}
    )
    return {
        "mission_id": mission_id,
        "model": index.model,
        "query": {"detection": detection, "text": text, "crop": built.crops.get(detection or "")},
        "k": k,
        "min_score": threshold,
        "indexed": len(index.ids),
        "embedded_now": built.embedded_now,
        "results": [
            {
                "detection": m.id,
                "frame": dets[m.id][1],
                "score": m.score,
                "conf": dets[m.id][0].conf,
                "crop": built.crops.get(m.id),
            }
            for m in matches
        ],
        "ms": round((time.perf_counter() - t0) * 1000),
    }
