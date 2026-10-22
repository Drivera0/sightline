"""Photo clients (LANE_B §5.4, B-R1/B-R2): they talk only HTTP (contract §13), so they run against
localhost, a laptop at the command post or AWS unchanged.

- ``replay``: a real recorded flight pushed through the live API at drone pace (the demo). HERIDAL
  photos at their recorded GPS, one every ``pace`` seconds, in capture order. Resumable: with a
  mission id, photos already in its survey are skipped. Validation photos only, never the test split.
- ``Watcher``: the command-post laptop. Polls a folder (an SD card, a sync folder); a JPEG is ready
  once its size is the same on two polls; uploads in batches of at most 10; keeps its ledger in
  ``~/.sightline/watch/<mission>.json`` (never in the camera's folder); queues while offline and
  backs off.

Built by lane A for lane B (issue #74); lane B owns this package.
"""

from __future__ import annotations

import json
import os
import time
from collections import Counter
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path

import httpx

MAX_BATCH = 10
REPLAY_NAME = "Replay: real flight (HERIDAL photos at their recorded GPS)"
VAL_PHOTOS = Path("data/heridal/yolo_full/val/images")
JPEG = {".jpg", ".jpeg"}
MAX_BACKOFF_S = 60.0

Out = Callable[[str], None]


def say(line: str) -> None:
    print(line, flush=True)  # seen at once when the output is piped or logged


class Offline(Exception):
    """The API could not be reached, or answered 5xx: keep the photos and try again."""


def _call(http: httpx.Client, method: str, path: str, **kw) -> httpx.Response:
    try:
        r = http.request(method, path, **kw)
    except httpx.TransportError as e:
        raise Offline(str(e) or type(e).__name__) from e
    if r.status_code >= 500:
        raise Offline(f"{r.status_code} from the API")
    r.raise_for_status()
    return r


def create_mission(
    http: httpx.Client,
    name: str,
    lkp: tuple[float, float],
    *,
    area_name: str,
    mode: str = "live",
    subject: str | None = None,
) -> str:
    body = {
        "name": name,
        "area_name": area_name,
        "lkp": {"lat": lkp[0], "lon": lkp[1]},
        "mode": mode,
        "subject": subject,
    }
    return _call(http, "POST", "/missions", json=body).json()["mission_id"]


def upload(http: httpx.Client, mission_id: str, paths: list[Path]) -> dict:
    """``{"accepted": [frame ids], "rejected": [{"name", "reason"}]}`` (contract §13)."""
    files = [("files", (p.name, p.read_bytes(), "image/jpeg")) for p in paths]
    return _call(http, "POST", f"/missions/{mission_id}/photos", files=files).json()


def uploaded_names(http: httpx.Client, mission_id: str) -> set[str]:
    frames = _call(http, "GET", f"/missions/{mission_id}/survey").json()["frames"]
    return {f["source"]["image"] for f in frames}


def _position(path: Path) -> tuple[float, float] | None:
    from sightline.geo.pose import read_pose

    try:
        info = read_pose(path)
    except OSError:  # not a readable JPEG (seen live: a broken file on the card); the API says why
        return None
    return None if info is None else (info.pose.lat, info.pose.lon)


def _captured_at(path: Path) -> str:
    from PIL import Image

    with Image.open(path) as im:
        exif = im.getexif().get_ifd(0x8769)  # Exif IFD: DateTimeOriginal
    return str(exif.get(36867, ""))


# --- replay (B-R1) ------------------------------------------------------------------------------


def real_gps_photos(folder: Path = VAL_PHOTOS) -> list[Path]:
    """The largest site of nadir photos with a full pose (lane B's ``real.py``), in capture order.
    Refuses the HERIDAL test split: it is only for the final evaluation."""
    from sightline.geo.real import cluster_real_photos, select_real_photos

    if "test" in Path(folder).resolve().parts:
        raise ValueError(f"{folder} is the HERIDAL test split: replay uses validation photos")
    selection = select_real_photos(p for p in Path(folder).iterdir() if p.suffix.lower() in JPEG)
    if not selection.accepted:
        raise ValueError(f"no photo in {folder} has GPS and a nadir pose")
    site = cluster_real_photos(selection.accepted)[0]
    return sorted((p.image for p in site), key=lambda p: (_captured_at(p), p.name))


def replay(
    http: httpx.Client,
    photos: list[Path],
    *,
    pace: float = 2.0,
    mission_id: str | None = None,
    name: str = REPLAY_NAME,
    limit: int | None = None,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
    out: Out = say,
) -> str:
    """Uploads ``photos`` one every ``pace`` seconds and returns the mission id. A new mission's
    last-known point is the first photo's position (a replay has no real subject)."""
    if mission_id is None:
        lkp = _position(photos[0])
        if lkp is None:
            raise ValueError(f"{photos[0].name} has no GPS")
        mission_id = create_mission(http, name, lkp, area_name="HERIDAL site", mode="replay")
        out(f"mission {mission_id}: {name}")
        done: set[str] = set()
    else:
        done = uploaded_names(http, mission_id)
    todo = [p for p in photos if p.name not in done][:limit]
    if done:
        out(f"resuming: {len(done)} already in the survey, {len(todo)} to go")
    for i, path in enumerate(todo):
        t0 = clock()
        r = upload(http, mission_id, [path])
        ms = round((clock() - t0) * 1000)
        if r["accepted"]:
            out(f"{r['accepted'][0]}  {path.name}  {ms} ms")
        else:
            out(f"rejected {path.name}: {r['rejected'][0]['reason']}")
        if i < len(todo) - 1:
            sleep(max(0.0, pace - (clock() - t0)))
    return mission_id


# --- watch (B-R2) -------------------------------------------------------------------------------


def ledger_dir() -> Path:
    return Path(os.environ.get("SIGHTLINE_HOME", Path.home() / ".sightline")) / "watch"


@dataclass
class Watcher:
    http: httpx.Client
    folder: Path
    mission_id: str | None = None
    name: str | None = None  # with no mission id: a new mission, created at the first photo
    batch: int = MAX_BATCH
    ledger_root: Path = field(default_factory=ledger_dir)
    out: Out = say
    uploaded: dict[str, str] = field(default_factory=dict)  # name -> frame id
    rejected: dict[str, str] = field(default_factory=dict)  # name -> reason
    offline: bool = False
    queue: list[Path] = field(default_factory=list)  # ready, not yet sent (offline)
    _sizes: dict[str, int] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if self.mission_id is None and self.name is None:
            raise ValueError("give a mission id or a name for a new mission")
        self.batch = max(1, min(self.batch, MAX_BATCH))
        if self.mission_id:
            self._load()

    @property
    def ledger(self) -> Path:
        return self.ledger_root / f"{self.mission_id}.json"

    def _load(self) -> None:
        if self.ledger.is_file():
            d = json.loads(self.ledger.read_text())
            self.uploaded, self.rejected = d["uploaded"], d["rejected"]

    def _save(self) -> None:
        self.ledger.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.ledger.with_suffix(".tmp")
        tmp.write_text(json.dumps({"uploaded": self.uploaded, "rejected": self.rejected}, indent=1))
        tmp.replace(self.ledger)

    def ready(self) -> list[Path]:
        """JPEGs not yet sent whose size is unchanged since the last poll (a copy has finished)."""
        sizes = {
            p.name: p.stat().st_size
            for p in self.folder.iterdir()
            if p.suffix.lower() in JPEG and p.is_file()
        }
        out = [
            self.folder / n
            for n, s in sorted(sizes.items())
            if s > 0
            and self._sizes.get(n) == s
            and n not in self.uploaded
            and n not in self.rejected
        ]
        self._sizes = sizes
        return out

    def poll(self) -> list[Path]:
        """One poll: uploads what is ready; returns what is still queued (offline)."""
        waiting = sorted(
            {p.name: p for p in [*self.queue, *self.ready()]}.values(), key=lambda p: p.name
        )
        try:
            if waiting and self.mission_id is None:
                self._create(waiting)
            while waiting:
                self._send(waiting[: self.batch])
                waiting = waiting[self.batch :]  # only once sent: a failed batch stays queued
            self.offline = False
        except Offline as e:
            if not self.offline:
                self.out(f"offline ({e}): photos stay queued")
            self.offline = True
            self.queue = waiting
            return waiting
        self.queue = []
        return []

    def _create(self, photos: list[Path]) -> None:
        lkp = next((pos for p in photos if (pos := _position(p))), None)
        if lkp is None:
            return  # no photo with GPS yet: the API would reject them all anyway
        self.mission_id = create_mission(
            self.http, self.name or "Watch", lkp, area_name="Photo folder"
        )
        self.out(f"mission {self.mission_id}: {self.name} (last-known point: the first photo)")
        self._load()

    def _send(self, chunk: list[Path]) -> None:
        if self.mission_id is None:
            for p in chunk:
                self.rejected[p.name] = "no GPS in EXIF"
            return
        r = upload(self.http, self.mission_id, chunk)
        bad = {x["name"]: x["reason"] for x in r["rejected"]}
        ok = [p.name for p in chunk if p.name not in bad]
        self.uploaded.update(zip(ok, r["accepted"], strict=True))
        self.rejected.update(bad)
        self._save()

    def summary(self, queued: int = 0) -> str:
        line = f"uploaded {len(self.uploaded)} · queued {queued} · rejected {len(self.rejected)}"
        if self.rejected:
            reason, _ = Counter(self.rejected.values()).most_common(1)[0]
            line += f" ({reason})"
        return line

    def run(
        self,
        interval: float = 2.0,
        polls: int | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        wait, last = interval, ""
        for _ in _count(polls):
            queued = len(self.poll())
            line = self.summary(queued)
            if line != last:
                self.out(line)
                last = line
            wait = min(wait * 2, MAX_BACKOFF_S) if self.offline else interval
            sleep(wait)


def _count(n: int | None) -> Iterable[int]:
    i = 0
    while n is None or i < n:
        yield i
        i += 1
