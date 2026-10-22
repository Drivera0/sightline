"""The per-photo pipeline (LANE_D §5.3, D-P1): one uploaded drone photo → frame, detections,
crops, map update, events, agent hooks.

``POST /missions/{id}/photos`` (``sightline/api/missions.py``) checks each photo, keeps the
original at ``frames/orig/<frame_id>.jpg`` and enqueues a ``PhotoJob``; a worker
(``queue.LocalQueue``, or SQS on AWS) runs ``ingest_photo`` for each job, in order per mission.

Done by lane A for lane D (issue #51); lane D owns this file.
"""

from __future__ import annotations

import io
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
    Params,
    Pose,
    Source,
)
from sightline.mission.store import CANDIDATE_THRESHOLD, SAVE_THRESHOLD, MissionStore
from sightline.pipeline.rank import rank_frames

log = logging.getLogger(__name__)

FRAME_W_PX, FRAME_H_PX = 1000, 750  # display frame, as the upload API makes it
NEAR_MISS = 0.15  # 0.15 ≤ conf < 0.29: crops for A's verifier (contract §12.1)
RECALL = 0.864  # detector recall on HERIDAL test (VOC), what a frame's look is worth
RECALL_SOURCE = "HERIDAL test, VOC recall at the frozen threshold 0.29 (OpenCV report §7.1)"


class PhotoRejected(ValueError):
    """A photo the pipeline can't use, with the reason shown to the person who uploaded it."""


@dataclass(frozen=True)
class PhotoJob:
    mission_id: str
    frame_id: str
    orig_rel: str  # "frames/orig/f0007.jpg"
    received_at: str
    name: str = ""  # the uploaded file's name, for messages


def start_map_base(lkp, *, size_m: float = 1000.0, cell_m: float = 5.0) -> MapBase:
    """A new mission's map: C's ``LiveMap.start(lkp).base`` once C-L1 lands; until then the
    same grid and the labelled placeholder prior the demo uses (no invented ring numbers)."""
    try:
        from sightline.search.live import LiveMap  # type: ignore[import-not-found]
    except ImportError:
        from sightline.contract import CONTRACT_VERSION, Distribution
        from sightline.search.grid import make_grid
        from sightline.search.prior import placeholder_prior

        grid = make_grid(lkp, size_m=size_m, cell_m=cell_m)
        p, outside = placeholder_prior(grid)
        return MapBase(
            contract_version=CONTRACT_VERSION,
            grid=grid,
            lkp=lkp,
            params=Params(
                recall=RECALL,
                recall_source=RECALL_SOURCE,
                pod_cap=0.95,
                review_pod=0.9,
                prior_source="placeholder",
            ),
            prior=Distribution(p=[float(x) for x in p], outside=float(outside)),
            canopy=[None] * (grid.rows * grid.cols),
        )
    return LiveMap.start(lkp, cell_m=cell_m, size_m=size_m).base


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

    n_frames = len(store.survey(mid).frames)
    if int(job.frame_id[1:]) <= n_frames:  # SQS delivers at least once: already done
        return {"frame": job.frame_id, "skipped": "already processed"}
    if job.frame_id != f"f{n_frames + 1:04d}":  # ids are given out at upload, in order
        raise ValueError(f"{job.frame_id} arrived as frame {n_frames + 1}: jobs out of order")

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
        log.exception("%s %s: detector failed", mid, job.frame_id)
        found, detect_note = [], f"detector failed: {type(e).__name__}"
    raw = sorted((d for d in found if d.conf >= SAVE_THRESHOLD), key=lambda d: -d.conf)
    lap("detect")

    # 2, 4. frame, detections, crops (candidates in detections.json; near misses as files only)
    frame = Frame(
        id=job.frame_id,
        file=f"frames/{job.frame_id}.jpg",
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
            det_id = f"{job.frame_id}-d{k:02d}"
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
    store.append_frame(mid, frame, frame_bytes)
    store.append_detections(mid, job.frame_id, dets, crops)  # emits detection.new per candidate
    lap("store")

    # 5. ranking over every frame so far
    rank_frames_live(store, mid)
    lap("rank")

    # 6. the map: "looked here, nobody found" for this frame (C's math)
    map_note = "updated"
    try:
        live = live if live is not None else store.live(mid)
        held = [
            (LatLon(lat=d.lat, lon=d.lon), d.conf)
            for dets_ in store.detections(mid).frames.values()
            for d in dets_
            if d.conf >= CANDIDATE_THRESHOLD
        ]
        update = live.frame_update(
            frame,
            recall=RECALL,
            held=held,
            visibility_factor=conditions.visibility_factor if conditions else 1.0,
        )
        store.append_map_update(mid, update)
    except NotImplementedError:
        map_note = "skipped: waits for C-L1 (LiveMap.frame_update)"
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
        "frame": job.frame_id,
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
        f"{job.frame_id}: {frame.n_candidates} candidate(s)",
        ref=job.frame_id,
        data=summary,
    )
    return summary
