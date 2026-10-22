"""The API: live missions (contract §13, ``sightline/api/missions.py``) and the sprint-1 upload
of a zip of drone photos that returns a cache (LANE_D section 6.6).

    GET  /health            -> {"status": "ok", "contract_version": "1.2", "backend": "cv2" | "torch"}
    /missions/...           -> the mission API, when ``create_app`` gets ``missions`` or ``mission_root``
    /missions/{id}/radio/...-> the radio desk on those missions, with ``radio="text"|"real"``
    GET  /cache/...         -> the cache folder as static files
    POST /survey            -> zip of JPEGs; runs place -> ... -> export in the background
    GET  /survey/<id>       -> {"status": "running" | "done" | "failed", ...}

There is no login. With ``SIGHTLINE_API_TOKEN`` set, writes (POST/PUT/PATCH/DELETE) need
``Authorization: Bearer <token>`` (``sightline/api/auth.py``); reads, ``/health`` and the event streams
stay open. Unset, run it on a trusted network (it listens on 127.0.0.1 by default). Uploads are
limited in size, count and unpacked size, member names are never used as file paths, and every
image is decoded and re-saved by Pillow.
"""

from __future__ import annotations

import io
import os
import posixpath
import re
import shutil
import tempfile
import threading
import uuid
import zipfile
from collections.abc import Callable, Iterator
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, HTTPException, UploadFile
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps, UnidentifiedImageError

from sightline.api.auth import WriteToken, token_from_env
from sightline.api.limits import BodyLimit, RateLimit, rate_from_env
from sightline.api.missions import MissionContext, missions_router
from sightline.contract import CONTRACT_VERSION
from sightline.pipeline.formats import SurveyFrameEntry, SurveyFrameFile, write_json
from sightline.pipeline.geometry import FRAME_H_PX, FRAME_W_PX
from sightline.pipeline.lanes import Lanes
from sightline.pipeline.runner import run_pipeline
from sightline.pipeline.stages import Context

SURVEY_ID = re.compile(r"^[0-9a-f]{8}$")
MAX_PIXELS = 100_000_000
CHUNK = 1024 * 1024


def create_app(
    cache_root: Path = Path("cache"),
    data_root: Path = Path("data/uploads"),
    lanes_factory: Callable[[], Lanes] = Lanes,
    weights: Path | None = None,
    candidate_threshold: float = 0.25,
    model_name: str = "yolo11s-heridal-tiled",
    max_upload_bytes: int = 1_000_000_000,
    max_unpacked_bytes: int = 2_000_000_000,
    max_images: int = 1000,
    missions: MissionContext | None = None,
    mission_root: Path | None = None,
    radio: str | None = None,
    queue: str = "local",
    api_token: str | None = None,
    rate_limit: tuple[int, float] | None | str = "env",
) -> FastAPI:
    """``api_token``: the write token (default: ``SIGHTLINE_API_TOKEN``); none leaves it open.
    ``rate_limit``: (writes, seconds) per client IP, None for none, default ``SIGHTLINE_RATE_LIMIT``
    (``sightline/api/limits.py``: 300 per 60 s unless set; the tests set it off)."""
    cache_root.mkdir(parents=True, exist_ok=True)
    app = FastAPI(title="Sightline upload API")
    jobs: dict[str, dict] = {}
    pipeline_lock = threading.Lock()  # one detector run at a time: the GPU is shared

    if missions is None and mission_root is not None:
        missions = mission_context(mission_root, queue)
        missions.start()
    if missions is not None:
        app.state.missions = missions
        app.include_router(missions_router)
        if radio:  # the radio desk on the same missions (D-R4): "text" or "real" voices
            from sightline.radio.api import radio_router
            from sightline.radio.mount import radio_context

            app.state.radio = radio_context(missions.store, hooks=missions.hooks, voices=radio)
            app.include_router(radio_router)

    # Outermost last: CORS → rate limit → write token → body size → the routes. CORS wraps the
    # others, so a 401, 413 or 429 still carries the CORS headers the browser needs to read it.
    app.add_middleware(BodyLimit)
    token = api_token or token_from_env()
    if token:
        app.add_middleware(WriteToken, token=token)
    rate = rate_from_env() if rate_limit == "env" else rate_limit
    if rate:
        trust = os.environ.get("SIGHTLINE_TRUST_PROXY", "") == "1"
        app.add_middleware(RateLimit, requests=rate[0], seconds=rate[1], trust_proxy=trust)

    # The web app calls the API from another origin: Vite on localhost in development, the Vercel
    # site in production (SIGHTLINE_CORS_ORIGINS, comma-separated). No cookies, no credentials.
    from fastapi.middleware.cors import CORSMiddleware

    app.add_middleware(
        CORSMiddleware,
        allow_origins=[o for o in os.environ.get("SIGHTLINE_CORS_ORIGINS", "").split(",") if o],
        allow_origin_regex=r"http://(localhost|127\.0\.0\.1):\d+",
        allow_methods=["GET", "POST", "PATCH", "PUT"],
        allow_headers=["*"],
    )

    @app.get("/health")
    def health() -> dict[str, str | bool | None]:
        """``backend``: the configured detector. ``detector``: the one this process actually loaded
        (``cv2``/``torch``/``fake``; a missing ONNX falls back to torch), or null when none is loaded
        here yet (or the worker runs it, as on AWS)."""
        backend = (os.environ.get("SIGHTLINE_BACKEND") or "cv2").lower()
        ctx = getattr(app.state, "missions", None)
        loaded = getattr(ctx, "_detector", None) if ctx is not None else None
        return {
            "status": "ok",
            "contract_version": CONTRACT_VERSION,
            "backend": backend,
            "detector": None if loaded is None else detector_name(loaded),
            "radio": bool(
                getattr(app.state, "radio", None)
            ),  # the radio desk is mounted (serve --radio)
        }

    @app.post("/survey", status_code=202)
    def post_survey(background_tasks: BackgroundTasks, file: UploadFile) -> dict[str, str]:
        survey_id = uuid.uuid4().hex[:8]
        while survey_id in jobs:
            survey_id = uuid.uuid4().hex[:8]
        data = data_root / survey_id
        try:
            n_frames = _store_photos(
                file, data / "survey", max_upload_bytes, max_unpacked_bytes, max_images
            )
        except HTTPException:
            shutil.rmtree(data, ignore_errors=True)  # a refused upload leaves nothing behind
            raise
        jobs[survey_id] = {"id": survey_id, "status": "running", "stage": None}
        background_tasks.add_task(_run, survey_id, data, n_frames)
        return {"id": survey_id, "status": "running"}

    @app.get("/survey/{survey_id}")
    def get_survey(survey_id: str) -> dict:
        job = jobs.get(survey_id) if SURVEY_ID.match(survey_id) else None
        if job is None:
            raise HTTPException(status_code=404, detail="no such survey")
        return job

    def _run(survey_id: str, data: Path, n_frames: int) -> None:
        job = jobs[survey_id]
        name = f"upload-{survey_id}"
        context = Context(
            data=data,
            lanes=lanes_factory(),
            n_frames=n_frames,
            weights=weights,
            candidate_threshold=candidate_threshold,
            model_name=model_name,
            require_truth=False,  # uploaded photos have no ground truth
        )
        try:
            with pipeline_lock:
                run_pipeline(
                    context,
                    skip=["frames"],  # the upload already made the frames
                    out=cache_root / name,
                    survey_id=name,
                    echo=lambda line: job.update(stage=line),
                )
        except Exception as error:  # noqa: BLE001 - a background job reports every failure via GET /survey/<id>
            job.update(status="failed", error=str(error))
        else:
            job.update(status="done", cache=name)

    app.mount("/cache", StaticFiles(directory=cache_root), name="cache")
    return app


def detector_name(det: object) -> str:
    """ "cv2", "torch" or "fake" for a detector object (by class, so a fallback shows)."""
    name = type(det).__name__
    return {"CvDetector": "cv2", "Detector": "torch", "FakeDetector": "fake"}.get(name, name)


def mission_context(mission_root: Path, queue: str = "local") -> MissionContext:
    """The mission API's context. ``queue="sqs"`` (AWS): photos go to SQS (``SIGHTLINE_SQS_URL``,
    originals to ``SIGHTLINE_S3_BUCKET``) for the worker container; this process doesn't consume
    them. ``SIGHTLINE_METRICS=cloudwatch`` sends metrics; ``SIGHTLINE_SECRET_ID`` loads API keys."""
    from sightline.mission import MissionStore
    from sightline.mission.aws import SqsQueue, load_secrets, metrics_from_env
    from sightline.mission.queue import LocalQueue

    if queue not in ("local", "sqs"):
        raise ValueError("queue must be local or sqs")
    load_secrets()
    metrics = metrics_from_env()
    store = MissionStore(mission_root, on_trace=metrics.trace if metrics else None)
    if queue == "sqs":
        return MissionContext(
            store, queue=SqsQueue.from_env(mission_root), metrics=metrics, run_worker=False
        )
    return MissionContext(store, queue=LocalQueue(), metrics=metrics)


def _store_photos(
    upload: UploadFile,
    survey_dir: Path,
    max_upload_bytes: int,
    max_unpacked_bytes: int,
    max_images: int,
) -> int:
    """Check the zip, then decode each JPEG, resize it to the 1000 x 750 frame size and save it,
    one photo at a time (so memory use does not grow with the number of photos). Returns the count."""
    with tempfile.SpooledTemporaryFile(max_size=64 * 1024 * 1024) as spool:
        size = 0
        while chunk := upload.file.read(CHUNK):
            size += len(chunk)
            if size > max_upload_bytes:
                raise HTTPException(413, f"the upload is larger than {max_upload_bytes} bytes")
            spool.write(chunk)
        spool.seek(0)
        if not zipfile.is_zipfile(spool):
            raise HTTPException(400, "the upload is not a zip file")
        spool.seek(0)
        with zipfile.ZipFile(spool) as archive:
            members = _select_members(archive, max_images, max_unpacked_bytes)
            frames_dir = survey_dir / "frames"
            frames_dir.mkdir(parents=True)
            entries = []
            for index, (name, image) in enumerate(_iter_frames(archive, members)):
                frame_id = f"f{index + 1:04d}"
                path = frames_dir / f"{frame_id}.jpg"
                image.save(path, quality=85)
                entries.append(
                    SurveyFrameEntry(
                        id=frame_id,
                        flight_index=index,
                        source_image=name,
                        x0=0,
                        y0=0,
                        path=str(path),
                    )
                )
            write_json(survey_dir / "frames.json", SurveyFrameFile(entries))
            return len(entries)


def _select_members(
    archive: zipfile.ZipFile, max_images: int, max_unpacked_bytes: int
) -> list[tuple[str, zipfile.ZipInfo]]:
    """The JPEG members in name order, after the cheap checks (count and unpacked size)."""
    members = sorted(
        (
            (posixpath.basename(info.filename), info)
            for info in archive.infolist()
            if not info.is_dir()
            and info.filename.lower().endswith((".jpg", ".jpeg"))
            and not posixpath.basename(info.filename).startswith(".")
            and not info.filename.startswith("__MACOSX/")
        ),
        key=lambda item: (item[0].lower(), item[1].filename),
    )
    if not members:
        raise HTTPException(400, "the zip has no JPEG photos")
    if len(members) > max_images:
        raise HTTPException(413, f"too many photos: the limit is {max_images}")
    if sum(info.file_size for _, info in members) > max_unpacked_bytes:
        raise HTTPException(413, "the photos are too large once unpacked")
    return members


def _iter_frames(
    archive: zipfile.ZipFile, members: list[tuple[str, zipfile.ZipInfo]]
) -> Iterator[tuple[str, Image.Image]]:
    """Decode the photos lazily: one image exists at a time."""
    for name, info in members:
        yield name, _decode(name, archive.read(info))


def _decode(name: str, data: bytes) -> Image.Image:
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.width * image.height > MAX_PIXELS:
                raise HTTPException(400, f"{name} has too many pixels")
            image = ImageOps.exif_transpose(image)
            return ImageOps.fit(image.convert("RGB"), (FRAME_W_PX, FRAME_H_PX))
    except Image.DecompressionBombError as error:  # Pillow's own limit, hit when the header is read
        raise HTTPException(400, f"{name} has too many pixels") from error
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as error:
        raise HTTPException(400, f"{name} is not a valid JPEG image") from error
