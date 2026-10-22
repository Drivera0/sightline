"""A photo job that fails in the worker (docs/report/AGENT_EVAL.md, finding 1): the failure is an event
and a trace entry with the reason, and the mission's later photos are still processed. Frame ids stay
contiguous (contract: ``flight_index`` 0..N-1), so a later photo takes the failed one's place."""

from __future__ import annotations

from pathlib import Path

import pytest

from sightline.contract import LatLon
from sightline.mission import MissionStore, validate_mission
from sightline.mission.pipeline import PhotoJob, ingest_photo, start_map_base
from sightline.ml.types import Box, RawDetection
from tests.fixtures.drone_photos import LKP, drone_photo


class _Det:
    def detect_tiled(self, path, conf: float = 0.05):
        return [RawDetection(Box(400, 300, 440, 360), 0.8)]


@pytest.fixture
def mission(tmp_path: Path) -> tuple[MissionStore, str]:
    store = MissionStore(tmp_path / "missions")
    m = store.create("Seymour", "Mount Seymour", LatLon(**LKP), "live", None, None)
    store.put_map_base(m.mission_id, start_map_base(LatLon(**LKP)))
    return store, m.mission_id


def _job(store: MissionStore, mid: str, data: bytes) -> PhotoJob:
    fid = store.next_id(mid, "f")
    rel = store.put_file(mid, f"frames/orig/{fid}.jpg", data)
    return PhotoJob(mid, fid, rel, "2026-10-22T10:00:00.000Z", f"{fid}.jpg")


def test_a_failed_photo_is_recorded_and_later_photos_still_go_through(mission) -> None:
    store, mid = mission
    bad = _job(store, mid, drone_photo(gps=False))  # passed no upload check: straight to the queue
    good = [_job(store, mid, drone_photo()) for _ in range(2)]

    failed = ingest_photo(store, bad, detector=_Det())
    assert failed["failed"].startswith("no GPS position")
    for job in good:
        assert "failed" not in ingest_photo(store, job, detector=_Det())

    frames = store.survey(mid).frames
    assert [f.id for f in frames] == ["f0001", "f0002"]  # contiguous: the failed job left no gap
    assert [f.source.image for f in frames] == ["f0002.jpg", "f0003.jpg"]
    # the native zoom reads frames/orig/<frame id>.jpg: it must hold that frame's photo
    assert store.read_file(mid, "frames/orig/f0001.jpg") == drone_photo()
    assert store.read_file(mid, "frames/failed/f0001.jpg") == drone_photo(gps=False)  # kept

    notes = [e for e in store.events(mid) if (e.data or {}).get("failure") == "photo.failed"]
    assert [e.ref for e in notes] == ["f0001"]
    assert "no GPS" in notes[0].summary
    trace = [e for e in store.trace_entries(mid) if e.summary.startswith("photo.failed")]
    assert len(trace) == 1 and trace[0].kind == "note" and trace[0].actor == "pipeline"
    assert trace[0].output["reason"].startswith("no GPS position")
    assert validate_mission(store.root, mid) == []


def test_each_job_is_processed_once_after_a_failure(mission) -> None:
    store, mid = mission
    bad = _job(store, mid, drone_photo(gps=False))
    good = _job(store, mid, drone_photo())
    ingest_photo(store, bad, detector=_Det())
    ingest_photo(store, good, detector=_Det())
    assert ingest_photo(store, bad, detector=_Det())["skipped"] == "already processed"
    assert ingest_photo(store, good, detector=_Det())["skipped"] == "already processed"
    assert len(store.survey(mid).frames) == 1


def test_a_photo_that_cannot_be_decoded_fails_cleanly_too(mission) -> None:
    store, mid = mission
    broken = _job(store, mid, drone_photo()[:400])  # truncated: pose may read, pixels don't
    good = _job(store, mid, drone_photo())
    assert "failed" in ingest_photo(store, broken, detector=_Det())
    assert "failed" not in ingest_photo(store, good, detector=_Det())
    assert [f.id for f in store.survey(mid).frames] == ["f0001"]
