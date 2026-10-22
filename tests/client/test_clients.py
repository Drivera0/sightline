"""Photo clients against ``fake_api.py`` (LANE_B §6 test 7): replay paces with a fake clock and
resumes; watch ignores partial files, never re-uploads, queues while offline."""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from sightline.client import Watcher, real_gps_photos, replay
from tests.client.fake_api import FakeApi
from tests.fixtures.drone_photos import drone_photo


class Clock:
    """Each upload takes 0.3 s; sleeping moves the clock."""

    def __init__(self) -> None:
        self.t = 0.0
        self.slept: list[float] = []

    def __call__(self) -> float:
        self.t += 0.15  # read twice per upload
        return self.t

    def sleep(self, s: float) -> None:
        self.slept.append(round(s, 2))
        self.t += s


@pytest.fixture
def api():
    fake = FakeApi()
    with TestClient(fake.app, raise_server_exceptions=True) as http:
        yield fake, http


def _photos(folder: Path, n: int, gps: bool = True) -> list[Path]:
    folder.mkdir(parents=True, exist_ok=True)
    out = []
    for i in range(n):
        p = folder / f"DJI_{i + 1:04d}.JPG"
        p.write_bytes(drone_photo(lat=49.375 + i * 1e-4) if gps else b"\xff\xd8\xff\xe0 no exif")
        out.append(p)
    return out


def test_replay_paces_and_resumes(api, tmp_path: Path) -> None:
    fake, http = api
    photos = _photos(tmp_path / "flight", 4)
    clock, lines = Clock(), []
    mid = replay(http, photos, pace=2.0, limit=2, sleep=clock.sleep, clock=clock, out=lines.append)
    assert fake.missions[mid]["mode"] == "replay" and fake.missions[mid]["lkp"]["lat"] == 49.375
    assert fake.photos[mid] == ["DJI_0001.JPG", "DJI_0002.JPG"]
    assert clock.slept == [1.7]  # 2 s pace minus the 0.3 s the upload took; none after the last
    assert lines[1].startswith("f0001  DJI_0001.JPG  150 ms")
    lines.clear()
    assert (
        replay(http, photos, mission_id=mid, sleep=clock.sleep, clock=clock, out=lines.append)
        == mid
    )
    assert fake.photos[mid] == [p.name for p in photos]  # the first two were not sent again
    assert lines[0] == "resuming: 2 already in the survey, 2 to go"


def test_replay_refuses_the_test_split(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="test split"):
        real_gps_photos(tmp_path / "heridal" / "test" / "images")


def test_watch_waits_for_a_finished_copy_and_never_re_uploads(api, tmp_path: Path) -> None:
    fake, http = api
    card = tmp_path / "sd"
    lines: list[str] = []
    w = Watcher(http, card, name="Lynn Valley", ledger_root=tmp_path / "ledger", out=lines.append)
    _photos(card, 12)
    (card / "A_broken.JPG").write_bytes(b"x")  # first in name order: the mission still starts
    (card / "notes.txt").write_text("not a photo")
    w.poll()  # first sight of each file: none is known to be finished
    assert w.mission_id is None and not fake.calls
    with (card / "DJI_0012.JPG").open("ab") as f:  # still being copied
        f.write(b"\0" * 10)
    w.poll()
    mid = w.mission_id
    assert len(fake.photos[mid]) == 11 and "DJI_0012.JPG" not in fake.photos[mid]
    assert [c for c in fake.calls if c.endswith("/photos")] == [
        f"POST /missions/{mid}/photos"
    ] * 2  # 10 + 1
    w.poll()
    assert fake.photos[mid][-1] == "DJI_0012.JPG" and len(fake.photos[mid]) == 12
    w.poll()
    assert len(fake.photos[mid]) == 12  # nothing sent twice
    again = Watcher(http, card, mission_id=mid, ledger_root=tmp_path / "ledger", out=lines.append)
    again.poll(), again.poll()
    assert len(fake.photos[mid]) == 12  # nor after a restart: the ledger remembers
    assert (tmp_path / "ledger" / f"{mid}.json").is_file() and not list(card.glob("*.json"))


def test_watch_queues_offline_and_reports_rejections(api, tmp_path: Path) -> None:
    fake, http = api
    card = tmp_path / "sd"
    lines: list[str] = []
    mid = "m0000001"
    fake.missions[mid], fake.photos[mid] = {}, []
    w = Watcher(http, card, mission_id=mid, ledger_root=tmp_path / "ledger", out=lines.append)
    _photos(card, 3)
    (card / "IMG_9.JPG").write_bytes(b"\xff\xd8\xff\xe0 no exif")
    fake.offline = True
    slept: list[float] = []
    w.run(interval=2.0, polls=3, sleep=slept.append)
    assert (
        not fake.photos[mid]
        and lines[1].startswith("offline (network is unreachable)")
        and lines[-1].startswith("uploaded 0 · queued 4")
    )
    assert slept == [2.0, 4.0, 8.0]  # a first look, then backs off while offline
    fake.offline = False
    w.run(interval=2.0, polls=2, sleep=slept.append)
    assert len(fake.photos[mid]) == 3
    assert lines[-1] == "uploaded 3 · queued 0 · rejected 1 (no GPS in EXIF)"
    assert slept[-1] == 2.0
