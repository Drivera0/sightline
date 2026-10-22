"""The simulated fleet (LANE_C §5.6, C-F1): **a centralised brain, distributed eyes.**

    uv run python -m sightline.search.fleet run --api URL --mission ID [--scenario creek]
    uv run python -m sightline.search.fleet run --api URL --mission ID --single   # one loop (tests)

The brain stays central: the agent and the planner (``sightline/agent``, ``planner.py``) propose
legs, a human approves them, and ``MissionStore`` is the only place a leg becomes approved. The eyes
are distributed: ``run`` starts **one OS process per drone**. Each drone process holds its own state,
battery and HTTP client, follows the mission's event stream itself for the legs approved for it,
flies them, and posts its own photos through the real ``POST /photos``. This process is the ground
station: the drones' telemetry comes to it over a local queue (the simulated radio link) and it sends
the whole fleet in one ``PUT /fleet`` per tick (the store replaces the drone list on every PUT, so
one sender keeps drones from overwriting each other). A drone joins when the ground station first
hears it. ``--single`` keeps everything in one loop, as before, for tests and rehearsal scripts.

Each drone moves along its leg at ``speed_ms × time_scale`` and takes a photo every
``photo_every_m`` along the leg: a crop of a HERIDAL **validation** photo with EXIF GPS, the 35 mm
focal length and DJI XMP altitude/yaw written for its simulated pose. Telemetry carries positions,
battery, and only ``flying``/``done`` for its legs. The sim never creates, approves or reassigns legs.

**Truth stays in the scenario.** The hidden person's position decides only which crop a photo gets:
the crop around a labelled person when the photo's footprint covers the hidden point, else a crop
clear of every labelled person. Nothing else about it reaches the API.

Every crop is as wide on the ground as the planner's line spacing at the source photo's own GSD, so
people keep their real size in pixels. Everything it makes is labelled simulated.

Built by lane A for lane C (issue #64); lane C owns this file.
"""

from __future__ import annotations

import io
import json
import math
import multiprocessing as mp
import queue
import threading
import time
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
from PIL import ExifTags, Image

from sightline.client import Offline, _call, say
from sightline.contract import Drone, LatLon, Leg, Pose
from sightline.geo.camera import FULL_FRAME_DIAGONAL_MM

SCENARIOS = Path(__file__).parent / "scenarios"
VAL = Path("data/heridal/yolo_full/val")
M_PER_DEG_LAT = 111_320.0
DEFAULT_GSD_M = 0.0075  # HERIDAL at about 50 m when a source photo has no pose
DRAIN_PCT_PER_MIN = 100 / 30  # 30 min endurance


def _utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


@dataclass(frozen=True)
class Scenario:
    name: str
    lkp: LatLon
    drones: list[Drone]
    hidden: LatLon  # truth: only ever used to pick an image
    positive: dict  # {"image": name, "box": index}
    clue: dict | None  # a scripted clue for rehearsals: {"after_s": sim seconds, ...ClueDraft}
    line_spacing_m: float = 20.0
    # the crops a photo gets when it does not cover the person: [{"image": name, "box": [x0, y0, x1, y1]}];
    # empty: derived from the labelled val photos (FramePool)
    negatives: tuple[dict, ...] = ()

    @classmethod
    def load(cls, name_or_path: str) -> Scenario:
        p = Path(name_or_path)
        if not p.is_file():
            p = SCENARIOS / f"{name_or_path}.json"
        d = json.loads(p.read_text())
        return cls(
            name=d["name"],
            lkp=LatLon(**d["lkp"]),
            drones=[Drone.model_validate(x) for x in d["drones"]],
            hidden=LatLon(**d["hidden"]),
            positive=d["positive"],
            clue=d.get("clue"),
            line_spacing_m=d.get("line_spacing_m", 20.0),
            negatives=tuple(d.get("negatives", ())),
        )


# --- local metres around the LKP ----------------------------------------------------------------


def _to_m(origin: LatLon, lon: float, lat: float) -> tuple[float, float]:
    east = (lon - origin.lon) * M_PER_DEG_LAT * math.cos(math.radians(origin.lat))
    north = (lat - origin.lat) * M_PER_DEG_LAT
    return east, north


def _to_ll(origin: LatLon, east: float, north: float) -> tuple[float, float]:
    lon = origin.lon + east / (M_PER_DEG_LAT * math.cos(math.radians(origin.lat)))
    return lon, origin.lat + north / M_PER_DEG_LAT


# --- frames -------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Crop:
    image: Path
    box: tuple[int, int, int, int]  # x0, y0, x1, y1 in the source photo
    gsd_m: float


class FramePool:
    """Crops of labelled HERIDAL validation photos: one around the scenario's person, the rest clear
    of every labelled person (the val split's empty label files are unreliable, so whole unlabelled
    photos are never used as negatives)."""

    def __init__(self, scn: Scenario, val: Path = VAL, negatives: int = 12) -> None:
        from sightline.geo.pose import read_pose
        from sightline.ml.data import load_split

        if "test" in val.resolve().parts:
            raise ValueError("the fleet sim uses validation photos, never the test split")
        imgs = [i for i in load_split("val", root=val.parent) if i.boxes]
        self._gsd: dict[Path, float] = {}

        def gsd(path: Path) -> float:
            if path not in self._gsd:
                info = read_pose(path)
                self._gsd[path] = info.pose.gsd_m if info else DEFAULT_GSD_M
            return self._gsd[path]

        def window(img: Any, cx: float, cy: float) -> tuple[int, int, int, int]:
            w = min(img.width, round(scn.line_spacing_m / gsd(img.path)))
            h = min(img.height, round(w * 3 / 4))
            x0 = int(min(max(0, cx - w / 2), img.width - w))
            y0 = int(min(max(0, cy - h / 2), img.height - h))
            return x0, y0, x0 + w, y0 + h

        src = next(i for i in imgs if i.path.name == scn.positive["image"])
        b = src.boxes[scn.positive["box"]]
        self.positive = Crop(
            src.path, window(src, (b.x1 + b.x2) / 2, (b.y1 + b.y2) / 2), gsd(src.path)
        )
        self.negatives: list[Crop] = []
        if scn.negatives:  # listed in the scenario file: exactly those
            by_name = {i.path.name: i for i in imgs}
            self.negatives = [
                Crop(by_name[n["image"]].path, tuple(n["box"]), gsd(by_name[n["image"]].path))
                for n in scn.negatives
            ]
        for img in [] if scn.negatives else imgs:
            if img.path == src.path:
                continue
            for fx, fy in ((0.25, 0.25), (0.75, 0.75), (0.75, 0.25), (0.25, 0.75), (0.5, 0.5)):
                x0, y0, x1, y1 = window(img, img.width * fx, img.height * fy)
                if all(bx.x2 < x0 or bx.x1 > x1 or bx.y2 < y0 or bx.y1 > y1 for bx in img.boxes):
                    self.negatives.append(Crop(img.path, (x0, y0, x1, y1), gsd(img.path)))
                    break
            if len(self.negatives) >= negatives:
                break
        if not self.negatives:
            raise ValueError("no crops free of labelled people in the validation photos")


def stamp(crop: Crop, lat: float, lon: float, alt_m: float, yaw_deg: float) -> bytes:
    """The crop as a JPEG with the EXIF/XMP pose lane B's ``read_pose`` reads, for this position."""
    with Image.open(crop.image) as im:
        part = im.crop(crop.box).convert("RGB")
    # lane B's camera model (geo/camera.py) inverted, so read_pose gives back the source's GSD
    eq_width_mm = FULL_FRAME_DIAGONAL_MM * part.width / math.hypot(part.width, part.height)
    f35 = eq_width_mm * alt_m / (crop.gsd_m * part.width)
    exif = Image.Exif()
    g = exif.get_ifd(ExifTags.IFD.GPSInfo)
    g.update({1: "N" if lat >= 0 else "S", 2: (abs(lat), 0.0, 0.0), 3: "E" if lon >= 0 else "W", 4: (abs(lon), 0.0, 0.0)})  # fmt: skip
    exif.get_ifd(ExifTags.IFD.Exif)[41989] = round(f35)
    exif[0x010E] = "Sightline simulated fleet"  # ImageDescription: says so in every photo
    yaw = ((yaw_deg + 180) % 360) - 180
    xmp = (
        f'<x:xmpmeta drone-dji:RelativeAltitude="+{alt_m:.1f}" drone-dji:GimbalYawDegree="{yaw:+.1f}"'
        ' drone-dji:GimbalPitchDegree="-90.0"/>'
    ).encode()
    buf = io.BytesIO()
    part.save(buf, "JPEG", exif=exif, comment=xmp, quality=88)
    return buf.getvalue()


def covers(pose: Pose, width_px: int, height_px: int, point: LatLon) -> bool:
    from shapely.geometry import Point, Polygon

    from sightline.geo.project import footprint

    return Polygon(footprint(pose, width_px, height_px)).contains(Point(point.lon, point.lat))


# --- following the mission's events -------------------------------------------------------------


def active_legs(fleet: dict) -> dict[str, Leg]:
    """The legs a drone may fly now: approved or flying."""
    return {
        leg.id: leg
        for leg in (Leg.model_validate(x) for x in (fleet or {}).get("legs", []))
        if leg.status in ("approved", "flying")
    }


def sse_events(lines: Iterable[str]) -> Iterator[tuple[str | None, str | None, dict]]:
    """(type, id, event) from server-sent-event lines (``sightline/api/sse.py``); comments skipped."""
    typ = eid = None
    data: list[str] = []
    for line in lines:
        if line == "":
            if data:
                yield typ, eid, json.loads("\n".join(data))
            typ, eid, data = None, None, []
        elif line.startswith(":"):
            continue
        elif line.startswith("event:"):
            typ = line[6:].strip()
        elif line.startswith("id:"):
            eid = line[3:].strip()
        elif line.startswith("data:"):
            data.append(line[5:].strip())


class FleetFeed:
    """Follows ``GET /missions/{id}/events`` in a thread and keeps the latest approved and flying legs
    from each ``fleet.updated`` (the store sends the whole fleet). Reconnects with ``Last-Event-ID``."""

    def __init__(self, http: Any, mission_id: str, retry_s: float = 2.0) -> None:
        self.http, self.mid, self.retry_s = http, mission_id, retry_s
        self.legs: dict[str, Leg] | None = None
        self.last_id: str | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, daemon=True, name="fleet-feed")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def follow(self, lines: Iterable[str]) -> None:
        """Read one connection's lines until it ends or ``stop``."""
        for typ, eid, ev in sse_events(lines):
            self.last_id = eid or self.last_id
            if typ == "fleet.updated":
                self.legs = active_legs(ev.get("data") or {})
            if self._stop.is_set():
                return

    def _run(self) -> None:
        while not self._stop.is_set():
            headers = {"Last-Event-ID": self.last_id} if self.last_id else {}
            try:
                with self.http.stream("GET", f"/missions/{self.mid}/events", headers=headers) as r:
                    self.follow(r.iter_lines())
            except httpx.HTTPError:
                pass  # offline: the sim polls meanwhile; try again
            self._stop.wait(self.retry_s)


# --- one drone: its own state, battery and HTTP client ------------------------------------------


class DroneSim:
    """One simulated drone: its state, battery, leg, photo counter and the HTTP client it posts its
    own photos with. ``step`` flies it ``sim_dt`` seconds along the approved legs it is given;
    ``report`` is its telemetry for the ground station."""

    def __init__(
        self,
        drone: Drone,
        http: Any,
        mission_id: str,
        scenario: Scenario,
        pool: FramePool,
        *,
        photo_every_m: float = 15.0,
        now: Callable[[], str] | None = None,
        out: Callable[[str], None] = say,
    ) -> None:
        self.drone = drone
        self.http, self.mid, self.scn, self.pool = http, mission_id, scenario, pool
        self.photo_every_m = photo_every_m
        self.now = now or _utc_now
        self.out = out
        self.leg: Leg | None = None
        self.route: list[tuple[float, float]] = []  # metres, from here to the end
        self.in_survey = False  # past the leg's first waypoint: photos are taken
        self.to_next_photo_m = 0.0
        self.heading_deg = 0.0
        self.leg_status: dict[str, str] = {}
        self.photos = 0

    @property
    def id(self) -> str:
        return self.drone.id

    def report(self) -> dict:
        """What the ground station hears: the drone and the status of the legs it has flown."""
        return {"drone": self.drone.model_dump(mode="json"), "leg_status": dict(self.leg_status)}

    def step(self, sim_dt: float, legs: dict[str, Leg]) -> None:
        """``sim_dt`` simulated seconds: take the next approved leg, fly, photograph, drain."""
        if self.leg is not None and self.leg.id not in legs:  # re-tasked: the store cancelled it
            self.out(f"{self.drone.name}: {self.leg.id} cancelled")
            self.leg = None
            self._set(status="idle")
        if self.leg is None:
            nxt = next(
                (
                    leg
                    for leg in legs.values()
                    if leg.drone_id == self.drone.id and leg.id not in self.leg_status
                ),
                None,
            )
            if nxt is not None:
                self._start(nxt)
        flying = self.leg is not None
        self._fly(self.drone.speed_ms * sim_dt)
        pct = max(0.0, self.drone.battery_pct - DRAIN_PCT_PER_MIN * sim_dt / 60 * flying)
        self._set(battery_pct=round(pct, 1))

    def _set(self, **update: Any) -> None:
        self.drone = self.drone.model_copy(update=update)

    def _pos_m(self) -> tuple[float, float]:
        p = self.drone.position or self.scn.lkp
        return _to_m(self.scn.lkp, p.lon, p.lat)

    def _start(self, leg: Leg) -> None:
        self.leg = leg
        self.route = [_to_m(self.scn.lkp, lon, lat) for lon, lat in leg.waypoints]
        self.in_survey, self.to_next_photo_m = False, 0.0
        self.leg_status[leg.id] = "flying"
        self._set(status="flying", altitude_m=leg.altitude_m)
        self.out(f"{self.drone.name}: flying {leg.id} ({leg.sector_id or 'leg'})")

    def _fly(self, dist_m: float) -> None:
        while self.leg is not None and dist_m > 1e-9:
            x, y = self._pos_m()
            tx, ty = self.route[0]
            gap = math.hypot(tx - x, ty - y)
            if gap > 1e-9:
                self.heading_deg = math.degrees(math.atan2(tx - x, ty - y)) % 360
            step = min(dist_m, gap)
            if self.in_survey:  # photos only along the leg, not on the way to its start
                step = min(step, self.to_next_photo_m)
            nx, ny = (
                (x + (tx - x) * step / gap, y + (ty - y) * step / gap) if gap > 1e-9 else (tx, ty)
            )
            lon, lat = _to_ll(self.scn.lkp, nx, ny)
            self._set(position=LatLon(lat=lat, lon=lon))
            dist_m -= step
            if self.in_survey:
                self.to_next_photo_m -= step
                if self.to_next_photo_m <= 1e-9:
                    self._photo()
                    self.to_next_photo_m = self.photo_every_m
            if math.hypot(tx - nx, ty - ny) <= 1e-6:
                self.route.pop(0)
                if not self.in_survey:  # reached the first waypoint: the survey starts with a photo
                    self.in_survey = True
                    self._photo()
                    self.to_next_photo_m = self.photo_every_m
                if not self.route:
                    self.leg_status[self.leg.id] = "done"
                    self.out(f"{self.drone.name}: {self.leg.id} done")
                    self.leg = None
                    self._set(status="idle")

    def _photo(self) -> None:
        p = self.drone.position
        assert p is not None
        pos = self.pool.positive
        w, h = pos.box[2] - pos.box[0], pos.box[3] - pos.box[1]
        pose = Pose(
            lat=p.lat,
            lon=p.lon,
            alt_agl_m=self.drone.altitude_m,
            heading_deg=self.heading_deg,
            gsd_m=pos.gsd_m,
        )
        crop = (
            pos
            if covers(pose, w, h, self.scn.hidden)
            else self.pool.negatives[self.photos % len(self.pool.negatives)]
        )
        self.photos += 1
        name = f"SIM_{self.drone.id}_{self.photos:04d}.jpg"
        data = stamp(crop, p.lat, p.lon, self.drone.altitude_m, self.heading_deg)
        self._upload([(name, data)])

    def _upload(self, photos: list[tuple[str, bytes]]) -> None:
        for k in range(0, len(photos), 50):  # POST /photos takes 1..50
            files = [("files", (n, d, "image/jpeg")) for n, d in photos[k : k + 50]]
            r = _call(self.http, "POST", f"/missions/{self.mid}/photos", files=files).json()
            for x in r["rejected"]:
                self.out(f"{x['name']} rejected: {x['reason']}")


# --- the ground station: hears the drones, sends the fleet ----------------------------------------


class GroundStation:
    """The central side of the link: it hears each drone's telemetry and sends the whole fleet in one
    ``PUT /fleet`` (the store replaces the drone list on every PUT). Drones join in the order they are
    first heard."""

    def __init__(
        self,
        http: Any,
        mission_id: str,
        *,
        now: Callable[[], str] | None = None,
        out: Callable[[str], None] = say,
    ) -> None:
        self.http, self.mid = http, mission_id
        self.now = now or _utc_now
        self.out = out
        self.heard: dict[str, Drone] = {}
        self.leg_status: dict[str, str] = {}

    def hear(self, report: dict) -> bool:
        """One telemetry report from a drone; True when it is the drone's first (it joins)."""
        d = Drone.model_validate(report["drone"])
        new = d.id not in self.heard
        self.heard[d.id] = d
        self.leg_status.update(report.get("leg_status") or {})
        return new

    def put(self) -> dict:
        body = {
            "drones": [d.model_dump(mode="json") for d in self.heard.values()],
            "leg_status": dict(self.leg_status),
            "at": self.now(),
        }
        return _call(self.http, "PUT", f"/missions/{self.mid}/fleet", json=body).json()


# --- one loop (--single, tests, creek_run) ----------------------------------------------------------


class FleetSim:
    """Every drone in one loop with a shared HTTP client: the ``--single`` mode, tests and rehearsal
    scripts. The same ``DroneSim`` and ``GroundStation`` as the per-process fleet."""

    def __init__(
        self,
        http: httpx.Client,
        mission_id: str,
        scenario: Scenario,
        *,
        time_scale: float = 30.0,
        photo_every_m: float = 15.0,
        pool: FramePool | None = None,
        scripted_clue: bool = False,
        now: Callable[[], str] | None = None,
        out: Callable[[str], None] = say,
    ) -> None:
        self.http, self.mid, self.scn = http, mission_id, scenario
        self.time_scale, self.photo_every_m = time_scale, photo_every_m
        self.pool = pool or FramePool(scenario)
        self.scripted_clue = scripted_clue
        self.now = now or _utc_now
        self.out = out
        self.sim_s = 0.0
        self.drones = [
            DroneSim(
                d,
                http,
                mission_id,
                scenario,
                self.pool,
                photo_every_m=photo_every_m,
                now=self.now,
                out=out,
            )
            for d in scenario.drones
        ]
        self.gcs = GroundStation(http, mission_id, now=self.now, out=out)
        self.clue_sent = False
        self.feed: FleetFeed | None = None

    @property
    def photos(self) -> int:
        return sum(d.photos for d in self.drones)

    def register(self) -> None:
        """The scenario's drones join the mission (the first ``PUT /fleet`` creates its fleet)."""
        for d in self.drones:
            self.gcs.hear(d.report())
        self.gcs.put()
        self.out(f"fleet: {', '.join(d.drone.name for d in self.drones)} (simulated)")

    def _approved(self) -> dict[str, Leg]:
        """The legs to fly: from the event stream when it is following the mission (``run``), else
        one ``GET /state`` (tests, or the stream reconnecting)."""
        return approved_legs(self.http, self.mid, self.feed)

    def tick(self, dt_s: float) -> None:
        """``dt_s`` wall seconds: drones take their next approved leg, fly, photograph; telemetry."""
        sim_dt = dt_s * self.time_scale
        self.sim_s += sim_dt
        legs = self._approved()
        for d in self.drones:
            d.step(sim_dt, legs)
        self.clue_sent = post_scripted_clue(self, self.sim_s)
        for d in self.drones:
            self.gcs.hear(d.report())
        self.gcs.put()

    def run(
        self,
        dt_s: float = 1.0,
        ticks: int | None = None,
        sleep: Callable[[float], None] = time.sleep,
        follow: bool = True,
    ) -> None:
        """Ticks until stopped. With ``follow``, approved legs come from the mission's event stream
        (``fleet.updated``) instead of a ``GET /state`` every tick."""
        self.register()
        if follow and self.feed is None:
            self.feed = FleetFeed(httpx.Client(base_url=self.http.base_url, timeout=None), self.mid)
            self.feed.start()
        try:
            n = 0
            while ticks is None or n < ticks:
                try:
                    self.tick(dt_s)
                except Offline as e:
                    self.out(f"offline ({e}); retrying")
                n += 1
                sleep(dt_s)
        finally:
            if self.feed is not None:
                self.feed.stop()


def approved_legs(http: Any, mission_id: str, feed: FleetFeed | None) -> dict[str, Leg]:
    if feed is not None and feed.legs is not None:
        return dict(feed.legs)
    fleet = _call(http, "GET", f"/missions/{mission_id}/state").json()["fleet"] or {}
    return active_legs(fleet)


def post_scripted_clue(sim: Any, sim_s: float) -> bool:
    """The scenario's rehearsal clue once its time comes (``--scripted-clue``); True once sent."""
    clue = sim.scn.clue
    if not sim.scripted_clue or not clue or sim.clue_sent or sim_s < clue["after_s"]:
        return sim.clue_sent
    draft = {k: v for k, v in clue.items() if k != "after_s"}
    _call(sim.http, "POST", f"/missions/{sim.mid}/clues", json=draft)
    sim.out(f"scripted clue (rehearsal): {draft['text']}")
    return True


# --- one process per drone (run) ------------------------------------------------------------------


@dataclass(frozen=True)
class DroneConfig:
    """What one drone process needs to start (picklable: it crosses into the new process)."""

    drone_id: str
    api: str
    mission_id: str
    scenario: str
    time_scale: float = 30.0
    photo_every_m: float = 15.0
    dt_s: float = 1.0


def _drain(q: Any) -> list:
    out = []
    while True:
        try:
            out.append(q.get_nowait())
        except queue.Empty:
            return out


def drone_loop(
    cfg: DroneConfig,
    http: Any,
    scn: Scenario,
    pool: FramePool,
    reports: Any,
    control: Any,
    stop: Any,
    *,
    feed: FleetFeed | None = None,
    out: Callable[[str], None] = say,
) -> DroneSim:
    """The body of one drone's process (the tests run it in a thread): say hello to the ground
    station, then fly the legs approved for this drone and post its own photos until ``stop``."""
    drone = next(d for d in scn.drones if d.id == cfg.drone_id)
    sim = DroneSim(drone, http, cfg.mission_id, scn, pool, photo_every_m=cfg.photo_every_m,
                   out=lambda s: out(f"[{drone.id} pid {_pid()}] {s}"))  # fmt: skip
    reports.put(sim.report())  # hello: the ground station adds it to the fleet
    while not stop.is_set():
        _drain(control)
        try:
            sim.step(cfg.dt_s * cfg.time_scale, approved_legs(http, cfg.mission_id, feed))
        except Offline as e:
            sim.out(f"offline ({e}); retrying")
        reports.put(sim.report())
        stop.wait(cfg.dt_s)
    return sim


def _pid() -> int:
    import os

    return os.getpid()


def _drone_process(cfg: DroneConfig, reports: Any, control: Any, stop: Any) -> None:
    """A drone's own process: its own HTTP client, event stream and frame pool."""
    scn = Scenario.load(cfg.scenario)
    with httpx.Client(base_url=cfg.api, timeout=httpx.Timeout(60.0, connect=10.0)) as http:
        feed = FleetFeed(httpx.Client(base_url=cfg.api, timeout=None), cfg.mission_id)
        feed.start()
        try:
            drone_loop(cfg, http, scn, FramePool(scn), reports, control, stop, feed=feed)
        except KeyboardInterrupt:
            pass
        finally:
            feed.stop()


class FleetProcesses:
    """``run``: one process per drone (``_drone_process``) and this process as the ground station,
    which hears their reports and sends ``PUT /fleet`` once per tick."""

    def __init__(
        self,
        http: Any,
        api: str,
        mission_id: str,
        scenario: str,
        *,
        time_scale: float = 30.0,
        photo_every_m: float = 15.0,
        dt_s: float = 1.0,
        scripted_clue: bool = False,
        out: Callable[[str], None] = say,
        ctx: Any = None,
        target: Callable[..., None] = _drone_process,
    ) -> None:
        self.http, self.mid = http, mission_id
        self.scn = Scenario.load(scenario)
        self.time_scale, self.dt_s = time_scale, dt_s
        self.scripted_clue, self.clue_sent = scripted_clue, False
        self.out = out
        self.ctx = ctx or mp.get_context("spawn")
        self.target = target
        self.sim_s = 0.0
        self.gcs = GroundStation(http, mission_id, out=out)
        self.reports = self.ctx.Queue()
        self.stop = self.ctx.Event()
        self.controls = {d.id: self.ctx.Queue() for d in self.scn.drones}
        self.configs = [
            DroneConfig(d.id, api, mission_id, scenario, time_scale, photo_every_m, dt_s)
            for d in self.scn.drones
        ]
        self.procs: list[Any] = []

    def start(self) -> None:
        for cfg in self.configs:
            p = self.ctx.Process(
                target=self.target,
                args=(cfg, self.reports, self.controls[cfg.drone_id], self.stop),
                name=f"sightline-drone-{cfg.drone_id}",
                daemon=True,
            )
            p.start()
            self.procs.append(p)
        pids = ", ".join(f"{c.drone_id} pid {getattr(p, 'pid', '-')}" for c, p in zip(self.configs, self.procs, strict=True))  # fmt: skip
        self.out(f"fleet: {len(self.procs)} drone processes (simulated): {pids}")

    def tick(self) -> None:
        self.sim_s += self.dt_s * self.time_scale
        latest: dict[str, dict] = {}
        for r in _drain(self.reports):
            latest[r["drone"]["id"]] = r
        for r in latest.values():
            if self.gcs.hear(r):
                self.out(f"{r['drone']['name']} joined the mission (simulated)")
        if self.gcs.heard:
            self.gcs.put()
        self.clue_sent = post_scripted_clue(self, self.sim_s)

    def run(self, ticks: int | None = None, sleep: Callable[[float], None] = time.sleep) -> None:
        self.start()
        try:
            n = 0
            while ticks is None or n < ticks:
                try:
                    self.tick()
                except Offline as e:
                    self.out(f"offline ({e}); retrying")
                n += 1
                sleep(self.dt_s)
        finally:
            self.shutdown()

    def shutdown(self) -> None:
        self.stop.set()
        for p in self.procs:
            p.join(10)
            if getattr(p, "is_alive", lambda: False)() and hasattr(p, "terminate"):
                p.terminate()


def main() -> None:
    import typer

    app = typer.Typer(add_completion=False, help="The simulated drone fleet (an HTTP client).")

    @app.command("run")
    def run_cmd(
        api: str = typer.Option(..., help="API base URL"),
        mission: str = typer.Option(...),
        scenario: str = typer.Option("creek"),
        time_scale: float = typer.Option(30.0),
        photo_every_m: float = typer.Option(15.0),
        dt_s: float = typer.Option(1.0, help="wall seconds per tick"),
        single: bool = typer.Option(False, help="every drone in one loop (tests, rehearsals)"),
        scripted_clue: bool = typer.Option(False, help="post the scenario's clue (rehearsals)"),
    ) -> None:
        with httpx.Client(base_url=api, timeout=httpx.Timeout(60.0, connect=10.0)) as http:
            if single:
                sim = FleetSim(http, mission, Scenario.load(scenario), time_scale=time_scale,
                               photo_every_m=photo_every_m, scripted_clue=scripted_clue)  # fmt: skip
                try:
                    sim.run(dt_s=dt_s)
                except KeyboardInterrupt:
                    say(f"stopped after {sim.photos} photos")
                return
            fleet = FleetProcesses(http, api, mission, scenario, time_scale=time_scale,
                                   photo_every_m=photo_every_m, dt_s=dt_s, scripted_clue=scripted_clue)  # fmt: skip
            try:
                fleet.run()
            except KeyboardInterrupt:
                say("stopped")

    @app.command("check")
    def check_cmd(scenario: str = typer.Option("creek")) -> None:
        """Loads the scenario and its frame pool (no API)."""
        scn = Scenario.load(scenario)
        pool = FramePool(scn)
        say(
            f"{scn.name}: {len(scn.drones)} drones, {len(pool.negatives)} clear crops, positive {pool.positive.image.name}"
        )

    app()


if __name__ == "__main__":
    main()
