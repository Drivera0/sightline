"""Stretch goal: upload a zip of drone photos, get a cache back (LANE_D section 6.6).

    GET  /health            -> {"status": "ok"}
    GET  /cache/...         -> the cache folder as static files
    POST /survey            -> zip of JPEGs; runs place -> ... -> export in the background
    GET  /survey/<id>       -> {"status": "running" | "done" | "failed", ...}

There is no login: run it on a trusted network (it listens on 127.0.0.1 by default). Uploads are
limited in size, count and unpacked size, member names are never used as file paths, and every
image is decoded and re-saved by Pillow.
"""

from __future__ import annotations

import io
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
) -> FastAPI:
    cache_root.mkdir(parents=True, exist_ok=True)
    app = FastAPI(title="Sightline upload API")
    jobs: dict[str, dict] = {}
    pipeline_lock = threading.Lock()  # one detector run at a time: the GPU is shared

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

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
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as error:
        raise HTTPException(400, f"{name} is not a valid JPEG image") from error
