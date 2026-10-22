"""The per-photo pipeline (LANE_D §5.3, D-P1): one uploaded drone photo → frame, detections,
crops, map update, events, agent hooks.

``POST /missions/{id}/photos`` (``sightline/api/missions.py``) checks each photo, keeps the
original at ``frames/orig/<frame_id>.jpg`` and enqueues a ``PhotoJob``; a worker
(``queue.LocalQueue``, or SQS on AWS) runs ``ingest_photo`` for each job, in order per mission.
A job that can't become a frame (no pose, an unreadable file) is recorded as ``photo.failed``
(event and trace) and the mission's later photos go on; frame ids stay contiguous, so a frame's id
can then be lower than its upload id (``frames/jobs.json`` maps one to the other).

Done by lane A for lane D (issue #51); lane D owns this file.
"""

from __future__ import annotations

import io
import json
import logging
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps

from sightline.contract import (
    Conditions,
    Detection,
    Frame,
    LatLon,
    MapBase,
    Pose,
    Source,
)
from sightline.mission.store import CANDIDATE_THRESHOLD, SAVE_THRESHOLD, MissionStore
from sightline.pipeline.rank import rank_frames
from sightline.search.pod import FrameInput

log = logging.getLogger(__name__)

FRAME_W_PX, FRAME_H_PX = 1000, 750  # display frame, as the upload API makes it
NEAR_MISS = 0.15  # 0.15 ≤ conf < 0.29: crops for A's verifier (contract §12.1)
JOBS_REL = "frames/jobs.json"  # upload id → frame id, or null for a job that failed
RECALL = 0.864  # detector recall on HERIDAL test (VOC), what a frame's look is worth
RECALL_SOURCE = "HERIDAL test, VOC recall at the frozen threshold 0.29 (OpenCV report §3.9)"


class PhotoRejected(ValueError):
    """A photo the pipeline can't use, with the reason shown to the person who uploaded it."""


@dataclass(frozen=True)
class PhotoJob:
    mission_id: str
    frame_id: str
    orig_rel: str  # "frames/orig/f0007.jpg"
    received_at: str
    name: str = ""  # the uploaded file's name, for messages


def processed_jobs(store: MissionStore, mission_id: str, frames: list[Frame]) -> dict:
    """Every photo job handled so far: upload id → frame id, or None when it failed. Missions from
    before the ledger have one job per frame, with the same id."""
    try:
        return json.loads(store.read_file(mission_id, JOBS_REL))
    except KeyError:
        return {f.id: f.id for f in frames}


def photo_failed(store: MissionStore, job: PhotoJob, error: Exception, jobs: dict) -> dict:
    """Record a photo job that can't become a frame: the original is kept under
    ``frames/failed/``, the job counts as handled (later photos go on), and the failure is a
    ``mission.note`` event and a ``pipeline`` trace note, both starting ``photo.failed``."""
    from sightline.agent.trace import trace_call

    mid = job.mission_id
    reason = str(error) if isinstance(error, PhotoRejected) else f"{type(error).__name__}: {error}"
    log.warning("%s %s (%s) failed: %s", mid, job.frame_id, job.name, reason)
    try:
        store.put_file(mid, f"frames/failed/{job.frame_id}.jpg", store.read_file(mid, job.orig_rel))
    except KeyError:
        pass
    store.put_file(mid, JOBS_REL, json.dumps({**jobs, job.frame_id: None}).encode())
    data = {"failure": "photo.failed", "job": job.frame_id, "name": job.name, "reason": reason}
    summary = f"photo.failed {job.frame_id} ({job.name or 'photo'}): {reason}"
    store.emit(mid, "mission.note", summary, ref=job.frame_id, data=data)
    trace_call(
        store, mid, actor="pipeline", kind="note", summary=summary, output=data, refs=[job.frame_id]
    )
    return {"frame": None, "job": job.frame_id, "failed": reason}


def start_map_base(
    lkp, *, size_m: float = 1000.0, cell_m: float = 5.0, subject: str | None = None
) -> MapBase:
    """A new mission's map: lane C's ``LiveMap.start(lkp).base`` (Koester's rings when the
    subject names a lost-person category, else the labelled placeholder prior)."""
    from sightline.search.live import LiveMap

    return LiveMap.start(lkp, cell_m=cell_m, size_m=size_m, subject=subject).base


def read_photo_pose(path: Path) -> Pose:
    """The photo's pose from EXIF GPS + DJI XMP (lane B's ``read_pose``), or PhotoRejected."""
    from sightline.geo.pose import read_pose

    info = read_pose(path)
    if info is None:
        raise PhotoRejected(
            "no GPS position, altitude, heading or focal length in the photo's EXIF/XMP"
        )
    if not info.nadir:
        raise PhotoRejected("the camera wasn't pointing straight down (gimbal pitch)")
    return info.pose


def display_frame(path: Path) -> tuple[bytes, float, float]:
    """The 1000×750 display frame as JPEG bytes, and the scale from original to frame pixels."""
    with Image.open(path) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        sx, sy = FRAME_W_PX / im.width, FRAME_H_PX / im.height
        frame = ImageOps.fit(im, (FRAME_W_PX, FRAME_H_PX))
    buf = io.BytesIO()
    frame.save(buf, "JPEG", quality=85)
    return buf.getvalue(), sx, sy


def _crop_bytes(orig: Path, box, out_dir: Path, name: str) -> bytes:
    from sightline.ml.crops import make_crop

    out = out_dir / name
    make_crop(orig, box, out)
    return out.read_bytes()


def rank_frames_live(store: MissionStore, mission_id: str) -> None:
    """The existing ranking rule (``pipeline.rank``), recomputed over every frame so far."""
    survey = store.survey(mission_id)
    dets = store.detections(mission_id).frames
    ranks = rank_frames(dets, {f.id: f.flight_index for f in survey.frames}, CANDIDATE_THRESHOLD)
    frames = [
        f.model_copy(update=dict(zip(("score", "rank", "n_candidates"), ranks[f.id], strict=True)))
        for f in survey.frames
    ]
    store.set_frames(mission_id, frames)


def ingest_photo(
    store: MissionStore,
    job: PhotoJob,
    *,
    detector: Any,
    live: Any | None = None,
    conditions: Conditions | None = None,
    hooks: Any | None = None,
) -> dict:
    """Process one photo (LANE_D §5.3 steps 1–7) and return the ``photo.processed`` timings.

    ``detector``: anything with ``detect_tiled(path, conf)`` (``make_detector()``: cv2 by
    default). ``live``: the mission's ``LiveMap`` (default ``store.live``); its ``frame_update``
    makes the map step, skipped while C-L1 hasn't landed. ``hooks``: lane A's
    ``sightline.agent.hooks`` (each call only enqueues).
    """
    from sightline.geo import footprint, georef_detection

    ms: dict[str, int] = {}
    t = time.perf_counter()

    def lap(step: str) -> None:
        nonlocal t
        now = time.perf_counter()
        ms[step] = round((now - t) * 1000)
        t = now

    mid = job.mission_id
    orig = store.root / mid / job.orig_rel

    frames = store.survey(mid).frames
    n_frames = len(frames)
    jobs = processed_jobs(store, mid, frames)
    if job.frame_id in jobs:  # SQS delivers at least once: already done (or already failed)
        return {"frame": jobs[job.frame_id], "job": job.frame_id, "skipped": "already processed"}
    if int(job.frame_id[1:]) != len(jobs) + 1:  # ids are given out at upload, in order
        raise ValueError(f"{job.frame_id} arrived as job {len(jobs) + 1}: jobs out of order")
    # The frame takes the next free id: the job's own unless an earlier job failed (frame ids
    # stay contiguous, contract: flight_index 0..N-1).
    fid = f"f{n_frames + 1:04d}"

    def prepare() -> tuple:
        # 1. pose and footprint (lane B), on the display frame's pixels
        source_pose = read_photo_pose(orig)
        frame_bytes, sx, sy = display_frame(orig)
        pose = source_pose.model_copy(update={"gsd_m": source_pose.gsd_m / sx})
        lap("pose")

        # 3. detect on the original, tiled (never detect_frame on a full photo)
        # A detector failure still adds the frame (no detections), so frame ids never leave a gap.
        detect_note = None
        try:
            found = detector.detect_tiled(orig, conf=SAVE_THRESHOLD)
        except Exception as e:
            log.exception("%s %s: detector failed", mid, fid)
            found, detect_note = [], f"detector failed: {type(e).__name__}"
        raw = sorted((d for d in found if d.conf >= SAVE_THRESHOLD), key=lambda d: -d.conf)
        lap("detect")

        # 2, 4. frame, detections, crops (candidates in detections.json; near misses as files only)
        frame = Frame(
            id=fid,
            file=f"frames/{fid}.jpg",
            width_px=FRAME_W_PX,
            height_px=FRAME_H_PX,
            flight_index=n_frames,
            source=Source(image=job.name or Path(job.orig_rel).name, x0=0, y0=0),
            pose=pose,
            footprint=tuple(footprint(pose, FRAME_W_PX, FRAME_H_PX)),
            score=max((d.conf for d in raw), default=0.0),
            rank=n_frames + 1,
            n_candidates=sum(d.conf >= CANDIDATE_THRESHOLD for d in raw),
        )
        dets, crops, near = [], {}, []
        with tempfile.TemporaryDirectory() as tmp:
            for k, d in enumerate(raw, start=1):
                det_id = f"{fid}-d{k:02d}"
                box = (
                    round(d.box.x1 * sx),
                    round(d.box.y1 * sy),
                    max(round(d.box.x1 * sx) + 1, round(d.box.x2 * sx)),
                    max(round(d.box.y1 * sy) + 1, round(d.box.y2 * sy)),
                )
                lat, lon, radius = georef_detection(pose, box, FRAME_W_PX, FRAME_H_PX)
                crop = None
                if d.conf >= CANDIDATE_THRESHOLD:
                    crop = f"crops/{det_id}.jpg"
                    crops[crop] = _crop_bytes(orig, d.box, Path(tmp), f"{det_id}.jpg")
                elif d.conf >= NEAR_MISS:
                    rel = f"crops/nearmiss/{det_id}.jpg"
                    store.put_file(mid, rel, _crop_bytes(orig, d.box, Path(tmp), f"{det_id}.jpg"))
                    near.append(det_id)
                dets.append(
                    Detection(
                        id=det_id,
                        box_px=box,
                        conf=round(d.conf, 3),
                        crop=crop,
                        lat=lat,
                        lon=lon,
                        radius_m=radius,
                    )
                )
        return frame, frame_bytes, dets, crops, near, detect_note, source_pose.gsd_m

    try:
        frame, frame_bytes, dets, crops, near, detect_note, orig_gsd_m = prepare()
        if fid != job.frame_id:  # the native zoom reads frames/orig/<frame id>.jpg
            store.put_file(mid, f"frames/orig/{fid}.jpg", orig.read_bytes())
    except Exception as e:  # noqa: BLE001 - one bad photo must not stop the mission's photos
        return photo_failed(store, job, e, jobs)
    store.append_frame(mid, frame, frame_bytes)
    store.append_detections(mid, fid, dets, crops)  # emits detection.new per candidate
    store.put_file(mid, JOBS_REL, json.dumps({**jobs, job.frame_id: fid}).encode())
    lap("store")

    # 5. ranking over every frame so far
    rank_frames_live(store, mid)
    lap("rank")

    # 6. the map: "looked here, nobody found" for this frame (C's math; the store applies it)
    map_note = "updated"
    try:
        live = live if live is not None else store.live(mid)
        candidates = [
            (LatLon(lat=d.lat, lon=d.lon), d.radius_m) for d in dets if d.crop is not None
        ]
        held = [
            (LatLon(lat=d.lat, lon=d.lon), d.radius_m)
            for frame_dets in store.detections(mid).frames.values()
            for d in frame_dets
            if d.crop is not None
        ]
        frame_input = FrameInput(
            frame_id=frame.id,
            pose=frame.pose,
            width_px=FRAME_W_PX,
            height_px=FRAME_H_PX,
            image=store.root / mid / frame.file,
            candidates=candidates,
            detector_gsd_m=orig_gsd_m,  # the detector saw the original: POD curve (POD.md)
        )
        update = live.frame_update(
            frame_input,
            recall=live.base.params.recall,
            held=held,
            visibility_factor=conditions.visibility_factor if conditions else 1.0,
        )
        store.append_map_update(mid, update)
        if not update.canopy:  # the footprint missed the grid: say so (a wrong LKP looks like this)
            map_note = "photo outside the search area (the grid around the last known position)"
    except ValueError as e:  # no map base yet
        map_note = f"skipped: {e}"
    lap("map")

    # 7. the agent: candidates and near misses (each call only enqueues)
    if hooks is not None:
        for det_id in [d.id for d in dets if d.crop is not None] + near:
            try:
                hooks.on_detection(store, mid, det_id)
            except Exception:  # a failing hook never stops the pipeline
                log.exception("hooks.on_detection(%s) failed", det_id)
    lap("hooks")

    summary = {
        "frame": fid,
        "job": job.frame_id,
        "candidates": frame.n_candidates,
        "near_misses": len(near),
        "map": map_note,
        "detector": detect_note or "ok",
        "ms": ms,
        "total_ms": sum(ms.values()),
    }
    store.emit(
        mid,
        "photo.processed",
        f"{fid}: {frame.n_candidates} candidate(s)",
        ref=fid,
        data=summary,
    )
    return summary
