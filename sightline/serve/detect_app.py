"""The frozen detector as an HTTP service, for a Nebius Serverless Endpoint (deploy/nebius/ENDPOINT.md).

    uvicorn sightline.serve.detect_app:app --host 0.0.0.0 --port 8080

    GET  /healthz  -> {"status": "ok", "model": ..., "onnx": ..., "threads": N, "rect_letterbox": bool}
    POST /detect   multipart ``photo`` (a JPEG or PNG), optional query ``conf`` (default 0.05)
                   -> {"model", "width", "height", "conf", "candidate_threshold": 0.29,
                       "n_candidates", "boxes": [{"box": [x1, y1, x2, y2], "conf"}],
                       "timing_ms": {"decode", "detect", "total"}}

The same path as the pipeline and the batch job: ``CvDetector.detect_tiled`` (OpenCV 5 ``cv2.dnn``
on the ONNX export, SAHI-style 1024 px slices, per-slice and merge NMS), boxes in photo pixels,
highest confidence first. The ONNX comes from ``SIGHTLINE_ONNX`` (the image downloads it).

Auth: the endpoint's own token (``nebius ai endpoint create --auth token``) is checked by Nebius in
front of the container. ``SIGHTLINE_DETECT_TOKEN``, if set, is also checked here (``Authorization:
Bearer``), for running the container somewhere without that proxy. ``/healthz`` is always open.
"""

from __future__ import annotations

import hmac
import os
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Any

import cv2
import numpy as np
from fastapi import FastAPI, File, Header, HTTPException, Query, UploadFile

MODEL_NAME = "yolo11s-heridal-tiled-run2"
SAVE_THRESHOLD = 0.05
CANDIDATE_THRESHOLD = 0.29
MAX_PHOTO_BYTES = 40 * 1024 * 1024


def _load_detector() -> Any:
    from sightline.ml.detect_cv import CvDetector

    onnx = os.environ.get("SIGHTLINE_ONNX")
    if not onnx:
        raise RuntimeError("set SIGHTLINE_ONNX to the detector's ONNX export")
    # Default: the CPUs this process may run on. os.cpu_count() counts the host's, so a container
    # pinned to fewer (docker --cpuset-cpus) would oversubscribe them.
    threads = os.environ.get("SIGHTLINE_DETECT_THREADS")
    return CvDetector(Path(onnx), threads=int(threads) if threads else len(os.sched_getaffinity(0)))


def create_app(detector: Any | None = None) -> FastAPI:
    """The app. ``detector``: anything with ``detect_tiled(bgr_array, conf)`` (tests pass a fake);
    default: ``CvDetector`` on ``SIGHTLINE_ONNX``, loaded at start-up so the first request is warm."""
    state: dict[str, Any] = {"detector": detector}
    lock = threading.Lock()  # cv2.dnn uses every core per forward pass: one photo at a time

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if state["detector"] is None:
            t0 = time.perf_counter()
            state["detector"] = _load_detector()
            state["load_ms"] = round((time.perf_counter() - t0) * 1000)
        yield

    app = FastAPI(title="Sightline detector", version="1.0", lifespan=lifespan)

    def check_token(authorization: str | None) -> None:
        token = os.environ.get("SIGHTLINE_DETECT_TOKEN")
        if not token:
            return
        given = (authorization or "").removeprefix("Bearer ").strip()
        if not hmac.compare_digest(given, token):
            raise HTTPException(401, "missing or wrong bearer token")

    @app.get("/healthz")
    def healthz() -> dict[str, Any]:
        det = state["detector"]
        return {
            "status": "ok" if det is not None else "loading",
            "model": MODEL_NAME,
            "onnx": getattr(getattr(det, "onnx_path", None), "name", None),
            "threads": getattr(det, "threads", None),
            "rect_letterbox": getattr(det, "rect", None),
            "load_ms": state.get("load_ms"),
            "cpus": os.cpu_count(),
        }

    @app.post("/detect")
    def detect(
        photo: Annotated[UploadFile, File()],
        conf: Annotated[float, Query(ge=0.0, le=1.0)] = SAVE_THRESHOLD,
        authorization: Annotated[str | None, Header()] = None,
    ) -> dict[str, Any]:
        check_token(authorization)
        t0 = time.perf_counter()
        data = photo.file.read(MAX_PHOTO_BYTES + 1)
        if len(data) > MAX_PHOTO_BYTES:
            raise HTTPException(413, f"photo over {MAX_PHOTO_BYTES // 2**20} MB")
        bgr = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        if bgr is None:
            raise HTTPException(400, "not a JPEG or PNG photo")
        t1 = time.perf_counter()
        with lock:
            dets = state["detector"].detect_tiled(bgr, conf=conf)
        t2 = time.perf_counter()
        boxes = [
            {"box": [d.box.x1, d.box.y1, d.box.x2, d.box.y2], "conf": float(d.conf)}
            for d in sorted(dets, key=lambda d: d.conf, reverse=True)
            if d.conf >= conf
        ]
        return {
            "model": MODEL_NAME,
            "width": int(bgr.shape[1]),
            "height": int(bgr.shape[0]),
            "conf": conf,
            "candidate_threshold": CANDIDATE_THRESHOLD,
            "n_candidates": sum(b["conf"] >= CANDIDATE_THRESHOLD for b in boxes),
            "boxes": boxes,
            "timing_ms": {
                "decode": round((t1 - t0) * 1000, 1),
                "detect": round((t2 - t1) * 1000, 1),
                "total": round((time.perf_counter() - t0) * 1000, 1),
            },
        }

    return app


def __getattr__(name: str) -> Any:  # ``uvicorn sightline.serve.detect_app:app``, built on first use
    if name == "app":
        globals()["app"] = create_app()
        return globals()["app"]
    raise AttributeError(name)
