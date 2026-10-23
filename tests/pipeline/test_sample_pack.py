"""The sample photo pack (``scripts/make_sample_pack.py``): 20 demo photos with poses that a live
mission's ``POST /photos`` accepts, landing on the demo area along one leg. Needs the demo cache
(``bash web/scripts/fetch-caches.sh``); skipped without it."""

from __future__ import annotations

import hashlib
import importlib.util
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sightline.api.app import create_app
from sightline.api.missions import MissionContext
from sightline.geo.pose import read_pose
from sightline.mission import MissionStore
from sightline.mission.queue import LocalQueue

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location(
    "make_sample_pack", ROOT / "scripts/make_sample_pack.py"
)
pack = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pack)  # type: ignore[union-attr]

needs_cache = pytest.mark.skipif(
    not (pack.CACHE / "survey.json").is_file(), reason="no demo cache (web/scripts/fetch-caches.sh)"
)


class _Det:
    def detect_tiled(self, path, conf: float = 0.05):
        return []


@needs_cache
def test_the_pack_is_twenty_posed_photos_with_credits_and_the_same_every_time(
    tmp_path: Path,
) -> None:
    a = pack.build(tmp_path / "a.zip")
    b = pack.build(tmp_path / "b.zip")
    assert hashlib.sha256(a.read_bytes()).digest() == hashlib.sha256(b.read_bytes()).digest()
    assert a.stat().st_size <= pack.MAX_BYTES
    with zipfile.ZipFile(a) as z:
        names = z.namelist()
        credits = z.read("sightline-sample-photos/CREDITS.txt").decode()
        readme = z.read("sightline-sample-photos/README.txt").decode()
    assert sum(n.endswith(".jpg") for n in names) == 20
    assert "HERIDAL (Božić-Štulić, Marušić & Gotovac, 2019), CC BY 3.0" in credits
    assert "SIMULATED position" in readme and "sightline.client watch" in readme
    (name, data), *_ = pack.photos(a)
    p = tmp_path / name
    p.write_bytes(data)
    info = read_pose(p)
    assert info is not None and info.nadir and abs(info.pose.lat - 49.369928) < 1e-6


@needs_cache
def test_a_live_mission_accepts_every_photo_and_places_them_on_the_leg(tmp_path: Path) -> None:
    z = pack.build(tmp_path / "pack.zip")
    store = MissionStore(tmp_path / "missions")
    ctx = MissionContext(store, queue=LocalQueue(), detector_factory=_Det, hooks=None)
    ctx.start()
    app = create_app(
        cache_root=tmp_path / "c", data_root=tmp_path / "u", missions=ctx, rate_limit=None
    )
    with TestClient(app) as http:
        mid = http.post("/missions", json={"name": "Pack", "area_name": "Mount Seymour",
                                           "lkp": pack.LKP}).json()["mission_id"]  # fmt: skip
        files = [("files", (n, d, "image/jpeg")) for n, d in pack.photos(z)]
        r = http.post(f"/missions/{mid}/photos", files=files)
        assert (
            r.status_code == 202 and len(r.json()["accepted"]) == 20 and r.json()["rejected"] == []
        )
        ctx.queue.join()
        frames = store.survey(mid).frames
        lons = [f.pose.lon for f in frames]
        assert len(frames) == 20 and lons == sorted(lons)  # east-bound, in order
        assert all(u.canopy for u in store.map_updates(mid))  # every photo is on the mission's grid
        taken = [e.data["taken_at"] for e in store.events(mid) if e.type == "photo.processed"]
        assert taken[0] == "2026-10-24T20:42:00Z" and taken == sorted(taken)
    ctx.queue.stop()
