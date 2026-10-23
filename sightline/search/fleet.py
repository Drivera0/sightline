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

Each drone is a simulated DJI Mavic 3 Enterprise (``Airframe``: 45 min flight, 38 min hover, 12 m/s
wind limit, from DJI's spec page). It flies at its airspeed ``speed_ms`` (× ``time_scale``); its ground
speed is the airspeed plus or minus the mission's wind (``conditions``), the battery drains with
airspeed, and it leaves a leg for home when the battery left would not bring it back with the
planner's 20 % reserve. It takes a photo every
``photo_every_m`` along the leg: a crop of a HERIDAL **validation** photo with EXIF GPS, the 35 mm
focal length and DJI XMP altitude/yaw written for its simulated pose. Telemetry carries positions,
battery, and only ``flying``/``done`` for its legs. The sim never creates, approves or reassigns legs.
An approved recall (a home leg, ``planner.home_leg``: the agent's answer to gusts over the limit) is
flown straight to the launch point in any wind, with no photos.

**Degraded comms (a simulated link model, not a radio measurement).** Each drone's link to the
ground station is connected, degraded or lost (``GroundStation``). It changes on the scenario's
schedule (``links``), with ``--degrade D2 60s``, or from the console (``POST /fleet/link``). A lost
drone hears no re-task and takes no new leg: it flies the leg it has on its own, keeps its photos on
board, flies home when that leg is done, and when the link is back syncs the photos through the
normal ``POST /photos`` (their names and EXIF carry the capture times). The mission keeps the
drone's last-heard state meanwhile; each change is a ``mission.note`` event and ``GET /fleet/links``
gives each drone's state and last-heard time (no contract model changes).

**Truth stays in the scenario.** The hidden person's position decides only which crop a photo gets:
the crop around a labelled person when the photo's footprint covers the hidden point, else a crop
clear of every labelled person. Nothing else about it reaches the API.

Every crop is as wide on the ground as the planner's line spacing at the source photo's own GSD, so
people keep their real size in pixels. **Below 50 m** (``NATIVE_ALT_M``, the altitude the planner's
line spacing is one photo's width at) the crop follows the leg's altitude (``at_altitude``): a
window narrower by altitude / 50 around the same centre, resized back to the same pixel size, so a
pass at 25 m shows the person twice as large (about 4× the pixels). Those pixels are resampled from
the 50 m photo: the sim reproduces the size, not the extra detail a real low pass would capture.
Everything it makes is labelled simulated.

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
from sightline.search.planner import is_home_leg

SCENARIOS = Path(__file__).parent / "scenarios"
VAL = Path("data/heridal/yolo_full/val")
M_PER_DEG_LAT = 111_320.0
DEFAULT_GSD_M = 0.0075  # HERIDAL at about 50 m when a source photo has no pose
# The altitude a crop is cut for: the planner's line spacing (20 m) is one photo's width at 50 m
# (``PlannerConfig.altitude_m``). Lower legs get a narrower, resized window (``at_altitude``).
NATIVE_ALT_M = 50.0


# --- the airframe and the wind ------------------------------------------------------------------


@dataclass(frozen=True)
class Airframe:
    """A simulated DJI Mavic 3 Enterprise. Numbers from DJI's spec page
    (https://enterprise.dji.com/mavic-3-enterprise/specs, read 2026-10-22): max flight time 45 min
    "flying at a constant speed of 32.4 kph in a windless environment" (9 m/s), max hovering time
    38 min (no wind), max wind speed resistance 12 m/s (takeoff and landing), max horizontal speed
    15 m/s (Normal mode); both with the 5000 mAh Intelligent Flight Battery.

    Drain depends on airspeed: 100 %/38 min hovering, 100 %/45 min at the 9 m/s cruise (a multirotor
    is most efficient at moderate forward speed), rising linearly back to the hover rate at 15 m/s
    (drag). A drain strictly proportional to airspeed would make hovering free, which no battery
    does; the two DJI points pin the curve, the slope above cruise is our assumption."""

    name: str = "DJI Mavic 3 Enterprise"
    flight_min: float = 45.0
    hover_min: float = 38.0
    cruise_ms: float = 9.0
    max_speed_ms: float = 15.0
    max_wind_ms: float = 12.0

    def drain_pct_per_min(self, airspeed_ms: float) -> float:
        hover, cruise = 100 / self.hover_min, 100 / self.flight_min
        v = min(max(airspeed_ms, 0.0), self.max_speed_ms)
        if v <= self.cruise_ms:
            return hover + (cruise - hover) * v / self.cruise_ms
        return cruise + (hover - cruise) * (v - self.cruise_ms) / (
            self.max_speed_ms - self.cruise_ms
        )


MAVIC_3E = Airframe()
# The battery kept back for landing, as the planner's leg check (planner.py ``_limits``) keeps it.
RESERVE_FRAC = 0.2


@dataclass(frozen=True)
class Wind:
    """The mission's wind (``conditions.wind_kmh``, ``wind_dir_deg``: where it blows from)."""

    speed_ms: float = 0.0
    from_deg: float | None = None

    @classmethod
    def from_conditions(cls, c: Any) -> Wind:
        if c is None:
            return cls()
        get = c.get if isinstance(c, dict) else lambda k: getattr(c, k, None)
        kmh = get("wind_kmh")
        return cls(speed_ms=(kmh or 0.0) / 3.6, from_deg=get("wind_dir_deg"))


def ground_speed(airspeed_ms: float, track_deg: float, wind: Wind) -> float:
    """Speed over the ground along ``track_deg`` at ``airspeed_ms``: the drone crabs into the
    crosswind and the along-track component adds or subtracts. With no wind direction (the forecast
    gave none) the wind is taken as a pure crosswind: slower both ways, never faster. 0 when the
    crosswind is stronger than the airspeed."""
    w = wind.speed_ms
    if w <= 0:
        return airspeed_ms
    if wind.from_deg is None:
        along, cross = 0.0, w
    else:
        rel = math.radians((wind.from_deg + 180.0) - track_deg)  # where the wind blows towards
        along, cross = w * math.cos(rel), w * math.sin(rel)
    if abs(cross) >= airspeed_ms:
        return 0.0
    return max(0.0, math.sqrt(airspeed_ms**2 - cross**2) + along)


# The API's rate limit (sightline/api/limits.py) answers 429 with Retry-After; the fleet waits and
# tries again, at most RETRY_TIMES times, never longer than RETRY_MAX_S at once.
RETRY_TIMES = 5
RETRY_MAX_S = 30.0


def retry_after_s(r: httpx.Response) -> float:
    """Seconds a 429 asks to wait (``Retry-After`` in seconds; 1 when missing or unreadable)."""
    try:
        return min(RETRY_MAX_S, max(0.0, float(r.headers.get("retry-after", "1"))))
    except ValueError:
        return 1.0


def _send(http: Any, method: str, path: str, *, sleep: Callable[[float], None] | None = None, **kw: Any) -> httpx.Response:  # fmt: skip
    """``sightline.client._call`` (it adds ``auth_headers()``: the write token), retried after a 429
    as ``Retry-After`` says. Photo bodies are bytes, so a retry sends them again unchanged."""
    for attempt in range(RETRY_TIMES + 1):
        try:
            return _call(http, method, path, **kw)
        except Exception as e:  # httpx.HTTPStatusError (FastAPI's TestClient raises its own copy)
            resp = getattr(e, "response", None)
            if getattr(resp, "status_code", None) != 429 or attempt == RETRY_TIMES:
                raise
            (sleep or time.sleep)(retry_after_s(resp))  # type: ignore[arg-type]
    raise AssertionError("unreachable")


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
    # scheduled link changes (simulated link model): [{after_s, target, link, for_s?}]
    links: tuple[dict, ...] = ()
    # ground teams the drones can relay for: [{id, callsign, members, position: {lat, lon},
    # no_signal?}]; the position is the simulator's truth for the team, sent only when relayed
    teams: tuple[dict, ...] = ()
    relay_radius_m: float = 300.0
    # 1.3: the mission's base camp; drones with no ``home`` of their own launch from and return to it
    base_camp: LatLon | None = None

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
            links=tuple(d.get("links", ())),
            teams=tuple(d.get("teams", ())),
            relay_radius_m=d.get("relay_radius_m", 300.0),
            base_camp=LatLon(lat=d["base_camp"]["lat"], lon=d["base_camp"]["lon"])
            if d.get("base_camp")
            else None,
        )


# --- local metres around the LKP ----------------------------------------------------------------


def _to_m(origin: LatLon, lon: float, lat: float) -> tuple[float, float]:
    east = (lon - origin.lon) * M_PER_DEG_LAT * math.cos(math.radians(origin.lat))
    north = (lat - origin.lat) * M_PER_DEG_LAT
    return east, north


def _bearing(x: float, y: float, tx: float, ty: float) -> float:
    """Compass bearing (degrees) from (x, y) to (tx, ty), local east/north metres."""
    return math.degrees(math.atan2(tx - x, ty - y)) % 360


def _to_ll(origin: LatLon, east: float, north: float) -> tuple[float, float]:
    lon = origin.lon + east / (M_PER_DEG_LAT * math.cos(math.radians(origin.lat)))
    return lon, origin.lat + north / M_PER_DEG_LAT


# --- frames -------------------------------------------------------------------------------------


@dataclass(frozen=True)
class Crop:
    image: Path
    box: tuple[int, int, int, int]  # x0, y0, x1, y1 in the source photo
    gsd_m: float
    zoom: float = 1.0  # the box is resized by this when stamped (``at_altitude``)


def at_altitude(crop: Crop, alt_m: float, native_alt_m: float = NATIVE_ALT_M) -> Crop:
    """``crop`` as a photo taken at ``alt_m``: below ``native_alt_m`` a window ``alt_m /
    native_alt_m`` as wide around the same centre, stamped back at the crop's pixel size (``zoom``)
    with the GSD divided by the zoom, so a person is ``native_alt_m / alt_m`` times larger. At or
    above ``native_alt_m`` the crop is unchanged (no sim leg flies higher)."""
    zoom = native_alt_m / alt_m if 0 < alt_m < native_alt_m else 1.0
    if zoom == 1.0:
        return crop
    x0, y0, x1, y1 = crop.box
    w, h = max(1, round((x1 - x0) / zoom)), max(1, round((y1 - y0) / zoom))
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    nx0, ny0 = round(cx - w / 2), round(cy - h / 2)
    return Crop(crop.image, (nx0, ny0, nx0 + w, ny0 + h), crop.gsd_m / zoom, zoom * crop.zoom)


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


def stamp(
    crop: Crop,
    lat: float,
    lon: float,
    alt_m: float,
    yaw_deg: float,
    taken_at: str | None = None,
    description: str = "Sightline simulated fleet",
) -> bytes:
    """The crop as a JPEG with the EXIF/XMP pose lane B's ``read_pose`` reads, for this position;
    ``taken_at`` (ISO, UTC) goes in DateTimeOriginal: a photo synced late keeps its capture time."""
    with Image.open(crop.image) as im:
        part = im.crop(crop.box).convert("RGB")
    if crop.zoom != 1.0:  # a lower pass: the narrower window at the crop's full pixel size
        size = (round(part.width * crop.zoom), round(part.height * crop.zoom))
        part = part.resize(size, Image.Resampling.BICUBIC)
    # lane B's camera model (geo/camera.py) inverted, so read_pose gives back the source's GSD
    eq_width_mm = FULL_FRAME_DIAGONAL_MM * part.width / math.hypot(part.width, part.height)
    f35 = eq_width_mm * alt_m / (crop.gsd_m * part.width)
    exif = Image.Exif()
    g = exif.get_ifd(ExifTags.IFD.GPSInfo)
    g.update({1: "N" if lat >= 0 else "S", 2: (abs(lat), 0.0, 0.0), 3: "E" if lon >= 0 else "W", 4: (abs(lon), 0.0, 0.0)})  # fmt: skip
    exif.get_ifd(ExifTags.IFD.Exif)[41989] = round(f35)
    if taken_at:  # DateTimeOriginal, 'YYYY:MM:DD HH:MM:SS'
        exif.get_ifd(ExifTags.IFD.Exif)[0x9003] = taken_at[:19].replace("-", ":").replace("T", " ")
    exif[0x010E] = description  # ImageDescription: says what the photo is, in every photo
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
        self.conditions: dict | None = None
        self._requests: list[dict] = []  # link changes asked for at the console (POST /fleet/link)
        self._lock = threading.Lock()
        self.last_id: str | None = None
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, daemon=True, name="fleet-feed")
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()

    def take_requests(self) -> list[dict]:
        """The link changes asked for since the last call."""
        with self._lock:
            out, self._requests = self._requests, []
        return out

    def follow(self, lines: Iterable[str]) -> None:
        """Read one connection's lines until it ends or ``stop``."""
        for typ, eid, ev in sse_events(lines):
            self.last_id = eid or self.last_id
            if typ == "fleet.updated":
                self.legs = active_legs(ev.get("data") or {})
            elif typ == "conditions.updated":
                self.conditions = ev.get("data")
            elif typ == "mission.note" and "fleet_link_request" in (ev.get("data") or {}):
                with self._lock:
                    self._requests.append({**ev["data"]["fleet_link_request"], "at": ev.get("at")})
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
        airframe: Airframe = MAVIC_3E,
        now: Callable[[], str] | None = None,
        out: Callable[[str], None] = say,
    ) -> None:
        self.drone = drone
        self.survey_alt_m = drone.altitude_m  # back to this once a lower leg (a re-look) is over
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
        self.airframe = airframe
        # the launch point it flies back to: its ``home`` (the base camp), else where it starts
        home = drone.home or scenario.base_camp
        self.home = _to_m(scenario.lkp, home.lon, home.lat) if home else self._pos_m()
        self.returning = False
        self._wind_held = False
        self.link = "connected"  # set by the ground station's link model
        self.outbox: list[tuple[str, bytes]] = []  # photos taken this tick: one POST at its end
        self.buffer: list[tuple[str, bytes]] = []  # photos kept on board while the link is down
        self._steps = 0

    @property
    def id(self) -> str:
        return self.drone.id

    def report(self) -> dict:
        """What the ground station hears: the drone and the status of the legs it has flown."""
        d = self.drone.model_dump(mode="json")
        d["battery_pct"] = round(d["battery_pct"], 1)
        return {"drone": d, "leg_status": dict(self.leg_status)}

    def step(self, sim_dt: float, legs: dict[str, Leg], wind: Wind | None = None) -> None:
        """``sim_dt`` simulated seconds: take the next approved leg, fly it at the drone's airspeed
        (its ground speed set by the wind), photograph, drain the battery, and turn home when the
        battery left would not bring it back with the reserve."""
        wind = wind or Wind()
        self._steps += 1
        if self.link == "lost":  # it hears nothing: no re-task, no new leg; the one it has goes on
            legs = {self.leg.id: self.leg} if self.leg is not None else {}
        elif self.link == "degraded" and self.buffer and self._steps % 2 == 0:
            self._upload(self._take_buffer())
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
            # a recall (home leg) flies in any wind: holding would keep it out in the gusts
            if (
                nxt is not None
                and wind.speed_ms > self.airframe.max_wind_ms
                and not is_home_leg(nxt)
            ):
                if not self._wind_held:
                    self.out(f"{self.drone.name}: holds {nxt.id}: wind {wind.speed_ms:.0f} m/s is "
                             f"above the {self.airframe.name}'s {self.airframe.max_wind_ms:.0f} m/s")  # fmt: skip
                self._wind_held = True
            elif nxt is not None:
                self._wind_held = False
                self.returning = False
                self._start(nxt)
        airspeed = self.drone.speed_ms
        if self.leg is not None or self.returning:
            self._fly(sim_dt, wind)
            drain = self.airframe.drain_pct_per_min(airspeed)
        elif self._airborne():
            drain = self.airframe.drain_pct_per_min(0.0)  # waiting for a leg: hovering
        else:
            drain = 0.0  # landed
        pct = max(0.0, self.drone.battery_pct - drain * sim_dt / 60)
        self._set(battery_pct=pct)
        if self.leg is None and self.drone.altitude_m != self.survey_alt_m:
            self._set(altitude_m=self.survey_alt_m)  # the planner plans the next leg from it
        if self.link == "lost" and self.leg is None and not self.returning and self._airborne():
            self.out(f"{self.drone.name}: leg flown with no link; flies home (lost-link return)")
            self._go_home()
        if (
            self.leg is not None
            and not is_home_leg(self.leg)
            and not self._enough_to_get_home(wind)
        ):
            self.out(f"{self.drone.name}: leaves {self.leg.id} and flies home: "
                     f"{self.drone.battery_pct:.0f} % left, {RESERVE_FRAC:.0%} kept in reserve")  # fmt: skip
            self.leg = None
            self._go_home()
        if self.outbox:  # the tick's photos in one request (the API's rate limit counts requests)
            photos, self.outbox = self.outbox, []
            self._upload(photos)

    def set_link(self, link: str) -> int:
        """The link model changed this drone's link. Back to connected: the photos kept on board
        go up now through ``POST /photos`` (names and EXIF carry their capture times). Returns how
        many were synced."""
        self.link = link
        if link != "connected" or not self.buffer:
            return 0
        photos = self._take_buffer()
        self._upload(photos)
        self.out(f"{self.drone.name}: link back, {len(photos)} photos taken out of contact synced")
        return len(photos)

    def _take_buffer(self) -> list[tuple[str, bytes]]:
        out, self.buffer = self.buffer, []
        return out

    def minutes_home(self, wind: Wind) -> float:
        """Flight time back to the launch point against this wind (inf when it can't get there)."""
        x, y = self._pos_m()
        d = math.hypot(self.home[0] - x, self.home[1] - y)
        if d < 1.0:
            return 0.0
        gs = ground_speed(self.drone.speed_ms, _bearing(x, y, *self.home), wind)
        return math.inf if gs <= 0 else d / gs / 60

    def _enough_to_get_home(self, wind: Wind) -> bool:
        need = self.minutes_home(wind) * self.airframe.drain_pct_per_min(self.drone.speed_ms)
        return self.drone.battery_pct - need >= RESERVE_FRAC * 100

    def _airborne(self) -> bool:
        x, y = self._pos_m()
        return math.hypot(self.home[0] - x, self.home[1] - y) > 5.0

    def _go_home(self) -> None:
        self.returning = True
        self.route = [self.home]
        self.in_survey = False
        self._set(status="returning")

    def _set(self, **update: Any) -> None:
        self.drone = self.drone.model_copy(update=update)

    def _pos_m(self) -> tuple[float, float]:
        p = self.drone.position or self.scn.lkp
        return _to_m(self.scn.lkp, p.lon, p.lat)

    def _start(self, leg: Leg) -> None:
        self.leg = leg
        self.in_survey, self.to_next_photo_m = False, 0.0
        self.leg_status[leg.id] = "flying"
        if is_home_leg(leg):  # a recall: straight to its own launch point, no photos
            self.route = [self.home]
            self._set(status="returning")
            self.out(f"{self.drone.name}: recalled ({leg.id}), turns home at "
                     f"{self.drone.battery_pct:.0f} % battery")  # fmt: skip
            return
        self.route = [_to_m(self.scn.lkp, lon, lat) for lon, lat in leg.waypoints]
        self._set(status="flying", altitude_m=leg.altitude_m)
        self.out(f"{self.drone.name}: flying {leg.id} ({leg.sector_id or 'leg'})")

    def _fly(self, seconds: float, wind: Wind) -> None:
        """Fly the route for ``seconds`` at the drone's airspeed; the wind sets the ground speed on
        each stretch (a crosswind stronger than the airspeed stops it: it holds and drains)."""
        while (self.leg is not None or self.returning) and seconds > 1e-9:
            x, y = self._pos_m()
            tx, ty = self.route[0]
            gap = math.hypot(tx - x, ty - y)
            if gap > 1e-9:
                self.heading_deg = _bearing(x, y, tx, ty)
            gs = ground_speed(self.drone.speed_ms, self.heading_deg, wind) if gap > 1e-9 else 1.0
            if gs <= 1e-9:
                return
            step = min(seconds * gs, gap)
            if self.in_survey:  # photos only along the leg, not on the way to its start
                step = min(step, self.to_next_photo_m)
            nx, ny = (
                (x + (tx - x) * step / gap, y + (ty - y) * step / gap) if gap > 1e-9 else (tx, ty)
            )
            lon, lat = _to_ll(self.scn.lkp, nx, ny)
            self._set(position=LatLon(lat=lat, lon=lon))
            seconds -= step / gs
            if self.in_survey:
                self.to_next_photo_m -= step
                if self.to_next_photo_m <= 1e-9:
                    self._photo()
                    self.to_next_photo_m = self.photo_every_m
            if math.hypot(tx - nx, ty - ny) <= 1e-6:
                self.route.pop(0)
                if self.returning:
                    if not self.route:
                        self.returning = False
                        self._set(status="idle")
                        self.out(f"{self.drone.name}: home, {self.drone.battery_pct:.0f} % left")
                    continue
                assert self.leg is not None
                if is_home_leg(self.leg):
                    if not self.route:
                        self.leg_status[self.leg.id] = "done"
                        self.out(f"{self.drone.name}: home ({self.leg.id} done), "
                                 f"{self.drone.battery_pct:.0f} % left")  # fmt: skip
                        self.leg = None
                        self._set(status="idle")
                    continue
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
        alt = self.drone.altitude_m
        pos = at_altitude(self.pool.positive, alt)
        w, h = (
            round((pos.box[2] - pos.box[0]) * pos.zoom),
            round((pos.box[3] - pos.box[1]) * pos.zoom),
        )
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
            else at_altitude(self.pool.negatives[self.photos % len(self.pool.negatives)], alt)
        )
        self.photos += 1
        taken = self.now()
        name = (
            f"SIM_{self.drone.id}_{self.photos:04d}_{taken.replace('-', '').replace(':', '')}.jpg"
        )
        data = stamp(crop, p.lat, p.lon, self.drone.altitude_m, self.heading_deg, taken)
        if self.link == "connected":
            self.outbox.append((name, data))
        else:  # degraded: up every other tick; lost: kept until the link is back
            self.buffer.append((name, data))

    def _upload(self, photos: list[tuple[str, bytes]]) -> None:
        for k in range(0, len(photos), 50):  # POST /photos takes 1..50
            files = [("files", (n, d, "image/jpeg")) for n, d in photos[k : k + 50]]
            r = _send(self.http, "POST", f"/missions/{self.mid}/photos", files=files).json()
            for x in r["rejected"]:
                self.out(f"{x['name']} rejected: {x['reason']}")


# --- the link model (simulated) -------------------------------------------------------------------

DRONE_LINKS = ("connected", "degraded", "lost")
TEAM_LINKS = ("connected", "no_signal")


@dataclass(frozen=True)
class LinkChange:
    target: str  # a drone id (D2) or a team id (T2)
    link: str
    for_s: float | None = None  # simulated seconds until it reverts; None: until changed again
    by: str = "fleet sim"


def _age(seconds: float) -> str:
    s = max(0, round(seconds))
    return f"{s} s" if s < 90 else f"{round(s / 60)} min"


def _seconds_between(a: str, b: str) -> float:
    from datetime import datetime

    return (datetime.fromisoformat(b) - datetime.fromisoformat(a)).total_seconds()


def link_summary(d: dict) -> str:
    """The event-feed line for a link change (``POST /fleet/link``). Every line says the link is a
    simulated model, never a radio measurement."""
    t, link = d["target"], d["link"]
    timed = f" for {_age(d['for_s'])}" if d.get("for_s") else ""
    if not d.get("report"):
        return f"{d.get('by') or 'command'} asked for {t}: link {link.replace('_', ' ')}{timed} (simulated link model)"  # fmt: skip
    if link == "lost":
        return f"{t} link lost{timed} (simulated link model): it flies its approved leg on its own and keeps its photos on board"  # fmt: skip
    if link == "degraded":
        return f"{t} link degraded{timed} (simulated link model): telemetry and photos arrive late"
    if link == "no_signal":
        return f"{t} has no signal{timed} (simulated link model): drones nearby relay its position"
    if t.startswith("T"):
        return f"{t} has signal again (simulated link model)"
    synced = d.get("synced")
    out = f"{t} link back (simulated link model)"
    if synced:
        out += f": {synced} photos taken out of contact synced with their capture times"
    elif synced is None:
        out += ": photos taken out of contact sync with their capture times"
    if d.get("last_heard_at") and d.get("at"):
        out += f", last heard {_age(_seconds_between(d['last_heard_at'], d['at']))} before"
    return out


def fleet_links(events: Iterable[Any]) -> dict:
    """Each drone's and team's latest link state from the mission's events (``mission.note`` with
    ``data.fleet_link`` from the fleet sim): what ``GET /fleet/links`` returns. Targets never
    reported are connected."""
    drones: dict[str, dict] = {}
    teams: dict[str, dict] = {}
    for ev in events:
        get = ev.get if isinstance(ev, dict) else lambda k, e=ev: getattr(e, k, None)
        data = get("data") or {}
        if get("type") != "mission.note":
            continue
        if "fleet_link" in data:
            d = data["fleet_link"]
            entry = {"link": d["link"], "since": get("at"), "for_s": d.get("for_s"),
                     "last_heard_at": d.get("last_heard_at"), "by": d.get("by")}  # fmt: skip
            if d["link"] in TEAM_LINKS and d["target"].startswith("T"):
                teams[d["target"]] = {**teams.get(d["target"], {}), **entry}
            else:
                drones[d["target"]] = entry
        elif "relay" in data:
            r = data["relay"]
            teams[r["team_id"]] = {**teams.get(r["team_id"], {"link": "no_signal"}), "relay": r}
    return {"simulated": True, "drones": drones, "teams": teams}


# --- drones relay for cut-off ground teams (simulated) ---------------------------------------------

# A drone can carry a message for a drone that has lost its own link when they are this close.
MESH_RADIUS_M = 600.0
# A team with no signal sends its position this often (a radio or beacon check-in), simulated seconds.
TEAM_BEACON_S = 60.0


def relay_route(
    team_m: tuple[float, float],
    drones_m: dict[str, tuple[float, float]],
    links: dict[str, str],
    relay_radius_m: float,
    mesh_radius_m: float = MESH_RADIUS_M,
) -> tuple[list[str], bool] | None:
    """Who carries a cut-off team's message (Pulse's relay pattern): the drones within
    ``relay_radius_m`` hear it; the route is the shortest chain from a drone that heard it to one
    with a working link to the ground station, hopping between drones within ``mesh_radius_m``.
    Returns (drones in order, delivered now) or None when no drone heard it; (``[hearer]``, False)
    when only drones with no link heard it and none can pass it on: the message rides with that
    drone until its link is back."""
    near = lambda a, b, r: math.dist(a, b) <= r
    hearers = sorted(
        (d for d, p in drones_m.items() if near(p, team_m, relay_radius_m)),
        key=lambda d: (math.dist(drones_m[d], team_m), d),
    )
    if not hearers:
        return None
    up = {d for d in drones_m if links.get(d, "connected") != "lost"}
    best: list[str] | None = None
    for h in hearers:  # breadth-first over the drones, from the hearer to any drone with a link
        prev: dict[str, str | None] = {h: None}
        frontier = [h]
        found = None
        while frontier and found is None:
            nxt = []
            for a in frontier:
                if a in up:
                    found = a
                    break
                for b in sorted(drones_m):
                    if b not in prev and near(drones_m[a], drones_m[b], mesh_radius_m):
                        prev[b] = a
                        nxt.append(b)
            frontier = nxt
        if found is not None:
            path = [found]
            while prev[path[-1]] is not None:
                path.append(prev[path[-1]])  # type: ignore[arg-type]
            path.reverse()
            if best is None or len(path) < len(best):
                best = path
    if best is not None:
        return best, True
    return [hearers[0]], False


def relay_summary(r: dict) -> str:
    """The feed line for a relayed team position: who it came through and how old it is."""
    who = r.get("callsign") or r["team_id"]
    via = " then ".join(r["via"])
    age = "just now" if r["age_s"] < 5 else f"{_age(r['age_s'])} old"
    return f"{who} heard via {via}, {age} (simulated relay)"


# --- the ground station: hears the drones, sends the fleet ----------------------------------------


class GroundStation:
    """The central side of the link: it hears each drone's telemetry and sends the whole fleet in one
    ``PUT /fleet`` (the store replaces the drone list on every PUT). Drones join in the order they are
    first heard.

    It also runs the **simulated link model**: each drone's link is connected, degraded (every other
    report heard; photos go up every other tick) or lost (nothing heard; the drone keeps flying its
    approved leg and keeps its photos on board). Changes come from the scenario (``links``), the
    ``--degrade`` switch, or the console (``POST /fleet/link``, read from the event stream); each one
    is reported back with ``POST /fleet/link`` so the mission's feed and map show it. While a drone is
    lost the fleet keeps its last-heard state.

    **Relay for cut-off teams** (simulated, Pulse's pattern): a team marked ``no_signal`` sends its
    position every ``TEAM_BEACON_S``; a drone within ``relay_radius_m`` of the team hears it and
    passes it on (``relay_route``): at once when it has a link, through a neighbouring drone when it
    has none, else when its link is back. ``POST /fleet/relay`` moves the team on the map and the feed
    says "Team Two heard via D3, 40 s old (simulated relay)". The simulator knows where the drones
    really are (``truth``) even when the mission doesn't hear them; only relayed positions reach the
    mission."""

    def __init__(
        self,
        http: Any,
        mission_id: str,
        *,
        now: Callable[[], str] | None = None,
        out: Callable[[str], None] = say,
        schedule: Iterable[dict] = (),
        teams: Iterable[dict] = (),
        lkp: LatLon | None = None,
        relay_radius_m: float = 300.0,
    ) -> None:
        self.http, self.mid = http, mission_id
        self.now = now or _utc_now
        self.out = out
        self.heard: dict[str, Drone] = {}
        self.heard_at: dict[str, str] = {}
        self.leg_status: dict[str, str] = {}
        self.links: dict[str, str] = {}
        self.until: dict[str, float] = {}
        self.schedule = sorted(schedule, key=lambda x: x["after_s"])
        self.started_at = self.now()
        self._n: dict[str, int] = {}
        self._changes: list[LinkChange] = []
        self.truth: dict[str, LatLon] = {}  # where each drone really is (the simulator's view)
        self.teams = {t["id"]: t for t in teams}
        self.lkp = lkp
        self.relay_radius_m = relay_radius_m
        self._beacon: dict[str, float] = {}  # the last check-in each team sent
        self._delivered: dict[str, float] = {}  # the last check-in that reached the mission
        self._carried: dict[
            str, tuple[str, float]
        ] = {}  # team -> (drone, heard at), not yet delivered
        self.relays: list[dict] = []
        for t in self.teams.values():
            if t.get("no_signal"):
                self.set_link(LinkChange(t["id"], "no_signal", by="scenario"), 0.0)

    def link(self, target: str) -> str:
        return self.links.get(target, "connected")

    def hear(self, report: dict) -> bool:
        """One telemetry report from a drone, through the link model; True when it is the drone's
        first (it joins). A lost link hears nothing; a degraded one every other report."""
        d = Drone.model_validate(report["drone"])
        if d.position is not None:
            self.truth[d.id] = d.position
        n = self._n[d.id] = self._n.get(d.id, 0) + 1
        link = self.link(d.id)
        if d.id in self.heard and (link == "lost" or (link == "degraded" and n % 2)):
            return False
        new = d.id not in self.heard
        self.heard[d.id] = d
        self.heard_at[d.id] = self.now()
        self.leg_status.update(report.get("leg_status") or {})
        return new

    def put(self) -> dict:
        body = {
            "drones": [d.model_dump(mode="json") for d in self.heard.values()],
            "leg_status": dict(self.leg_status),
            "at": self.now(),
        }
        return _send(self.http, "PUT", f"/missions/{self.mid}/fleet", json=body).json()

    def set_link(self, change: LinkChange, sim_s: float) -> bool:
        """Queue a link change (``advance`` returns it); False when it changes nothing."""
        allowed = TEAM_LINKS if change.target.startswith("T") else DRONE_LINKS
        if change.link not in allowed:
            self.out(f"link {change.link!r} is not one of {', '.join(allowed)} for {change.target}")
            return False
        if self.link(change.target) == change.link and not change.for_s:
            return False
        self.links[change.target] = change.link
        if change.for_s:
            self.until[change.target] = sim_s + change.for_s
        else:
            self.until.pop(change.target, None)
        self._changes.append(change)
        return True

    def advance(self, sim_s: float, requests: Iterable[dict] = ()) -> list[LinkChange]:
        """Timed changes that ran out, the scenario's scheduled ones and the console's requests:
        the link changes to apply to the drones now (then ``announce`` each)."""
        for target, until in list(self.until.items()):
            if sim_s >= until:
                del self.until[target]
                back = "connected"
                self.set_link(LinkChange(target, back, by="link model (timer)"), sim_s)
        while self.schedule and sim_s >= self.schedule[0]["after_s"]:
            x = self.schedule.pop(0)
            self.set_link(LinkChange(x["target"], x["link"], x.get("for_s"), "scenario"), sim_s)
        for r in requests:
            if (r.get("at") or "")[:19] < self.started_at[:19]:  # replayed from before this run
                continue
            self.set_link(LinkChange(r["target"], r["link"], r.get("for_s"), r.get("by") or "command"), sim_s)  # fmt: skip
        out, self._changes = self._changes, []
        return out

    def join_teams(self) -> None:
        """The scenario's teams that the mission doesn't have yet join its roster (labelled
        simulated); teams it already has keep their own record."""
        if not self.teams:
            return
        have = {
            t["id"] for t in _send(self.http, "GET", f"/missions/{self.mid}/state").json()["teams"]
        }
        for t in self.teams.values():
            if t["id"] in have:
                continue
            body = {"id": t["id"], "callsign": t["callsign"], "members": t.get("members", 3),
                    "status": "searching", "position": t.get("position"), "position_at": self.now(),
                    "note": "simulated team (fleet scenario)"}  # fmt: skip
            _send(self.http, "POST", f"/missions/{self.mid}/teams", json=body)

    def relay(self, sim_s: float) -> list[dict]:
        """Each cut-off team's latest check-in, carried by the drones near it (``relay_route``);
        returns what reached the mission this tick."""
        sent: list[dict] = []
        if self.lkp is None:
            return sent
        drones_m = {d: _to_m(self.lkp, p.lon, p.lat) for d, p in self.truth.items()}
        for tid, team in self.teams.items():
            if self.link(tid) != "no_signal" or not team.get("position"):
                self._carried.pop(tid, None)
                continue
            pos = LatLon(**team["position"])
            beacon = math.floor(sim_s / TEAM_BEACON_S) * TEAM_BEACON_S
            if beacon > self._beacon.get(tid, -1.0):
                self._beacon[tid] = beacon
                route = relay_route(_to_m(self.lkp, pos.lon, pos.lat), drones_m, self.links,
                                    self.relay_radius_m)  # fmt: skip
                if route is not None and route[1]:
                    self._carried.pop(tid, None)
                    sent += self._deliver(tid, team, pos, route[0], beacon, sim_s)
                elif route is not None:
                    self._carried[tid] = (route[0][0], beacon)
            if tid in self._carried:
                drone, heard = self._carried[tid]
                if self.link(drone) != "lost":
                    del self._carried[tid]
                    sent += self._deliver(tid, team, pos, [drone], heard, sim_s)
        return sent

    def _deliver(self, tid: str, team: dict, pos: LatLon, via: list[str], heard_s: float, sim_s: float) -> list[dict]:  # fmt: skip
        if heard_s <= self._delivered.get(tid, -1.0):
            return []
        self._delivered[tid] = heard_s
        from datetime import datetime, timedelta

        age = max(0.0, sim_s - heard_s)
        heard_at = (datetime.fromisoformat(self.now()) - timedelta(seconds=age)).strftime("%Y-%m-%dT%H:%M:%SZ")  # fmt: skip
        body = {"team_id": tid, "callsign": team.get("callsign"), "via": via, "hops": len(via),
                "heard_at": heard_at, "age_s": round(age), "lat": pos.lat, "lon": pos.lon}  # fmt: skip
        self.out(relay_summary(body))
        _send(self.http, "POST", f"/missions/{self.mid}/fleet/relay", json=body)
        self.relays.append(body)
        return [body]

    def announce(self, change: LinkChange, synced: int | None = None) -> None:
        """Tell the mission (``POST /fleet/link``): the feed line and the map's link ring."""
        body = {"target": change.target, "link": change.link, "for_s": change.for_s,
                "by": change.by, "report": True, "last_heard_at": self.heard_at.get(change.target),
                "synced": synced}  # fmt: skip
        self.out(link_summary({**body, "at": self.now()}))
        _send(self.http, "POST", f"/missions/{self.mid}/fleet/link", json=body)


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
        links: Iterable[dict] | None = None,
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
        self.gcs = GroundStation(http, mission_id, now=self.now, out=out,
                                 schedule=scenario.links if links is None else links,
                                 teams=scenario.teams, lkp=scenario.lkp,
                                 relay_radius_m=scenario.relay_radius_m)  # fmt: skip
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
        self.gcs.join_teams()
        self.out(f"fleet: {', '.join(d.drone.name for d in self.drones)} (simulated)")

    def _approved(self) -> dict[str, Leg]:
        return mission_view(self.http, self.mid, self.feed)[0]

    def set_link(self, target: str, link: str, for_s: float | None = None, by: str = "fleet sim") -> None:  # fmt: skip
        """Change a link now (tests, ``--degrade``); applied at the next tick."""
        self.gcs.set_link(LinkChange(target, link, for_s, by), self.sim_s)

    def tick(self, dt_s: float) -> None:
        """``dt_s`` wall seconds: links change, drones take their next approved leg, fly,
        photograph; the ground station hears what the links let through and sends the fleet."""
        sim_dt = dt_s * self.time_scale
        self.sim_s += sim_dt
        requests = self.feed.take_requests() if self.feed is not None else []
        by_id = {d.id: d for d in self.drones}
        for change in self.gcs.advance(self.sim_s, requests):
            d = by_id.get(change.target)
            synced = d.set_link(change.link) if d is not None else None
            self.gcs.announce(change, synced)
        legs, wind = mission_view(self.http, self.mid, self.feed)
        for d in self.drones:
            d.step(sim_dt, legs, wind)
        self.clue_sent = post_scripted_clue(self, self.sim_s)
        for d in self.drones:
            self.gcs.hear(d.report())
        self.gcs.put()
        self.gcs.relay(self.sim_s)

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


def mission_view(http: Any, mission_id: str, feed: FleetFeed | None) -> tuple[dict[str, Leg], Wind]:
    """The legs to fly and the wind: from the event stream when it is following the mission
    (``run``), else one ``GET /state`` (tests, or the stream reconnecting)."""
    if feed is not None and feed.legs is not None:
        return dict(feed.legs), Wind.from_conditions(feed.conditions)
    st = _send(http, "GET", f"/missions/{mission_id}/state").json()
    return active_legs(st["fleet"] or {}), Wind.from_conditions(st.get("conditions"))


def post_scripted_clue(sim: Any, sim_s: float) -> bool:
    """The scenario's rehearsal clue once its time comes (``--scripted-clue``); True once sent."""
    clue = sim.scn.clue
    if not sim.scripted_clue or not clue or sim.clue_sent or sim_s < clue["after_s"]:
        return sim.clue_sent
    draft = {k: v for k, v in clue.items() if k != "after_s"}
    _send(sim.http, "POST", f"/missions/{sim.mid}/clues", json=draft)
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
    station, then fly the legs approved for this drone and post its own photos until ``stop``.
    ``control`` brings link changes from the ground station's link model."""
    drone = next(d for d in scn.drones if d.id == cfg.drone_id)
    sim = DroneSim(drone, http, cfg.mission_id, scn, pool, photo_every_m=cfg.photo_every_m,
                   out=lambda s: out(f"[{drone.id} pid {_pid()}] {s}"))  # fmt: skip
    reports.put(sim.report())  # hello: the ground station adds it to the fleet
    while not stop.is_set():
        for kind, value in _drain(control):
            if kind == "link":
                sim.set_link(value)
        try:
            sim.step(cfg.dt_s * cfg.time_scale, *mission_view(http, cfg.mission_id, feed))
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
    which hears their reports through the link model and sends ``PUT /fleet`` once per tick."""

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
        links: Iterable[dict] | None = None,
        follow: bool = True,
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
        self.follow = follow
        self.sim_s = 0.0
        self.gcs = GroundStation(http, mission_id, out=out,
                                 schedule=self.scn.links if links is None else links,
                                 teams=self.scn.teams, lkp=self.scn.lkp,
                                 relay_radius_m=self.scn.relay_radius_m)  # fmt: skip
        self.feed: FleetFeed | None = None
        self.reports = self.ctx.Queue()
        self.stop = self.ctx.Event()
        self.controls = {d.id: self.ctx.Queue() for d in self.scn.drones}
        self.configs = [
            DroneConfig(d.id, api, mission_id, scenario, time_scale, photo_every_m, dt_s)
            for d in self.scn.drones
        ]
        self.procs: list[Any] = []

    def start(self) -> None:
        if self.http is not None:
            self.gcs.join_teams()
        if self.follow and self.feed is None and self.http is not None:
            self.feed = FleetFeed(httpx.Client(base_url=self.http.base_url, timeout=None), self.mid)
            self.feed.start()
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
        requests = self.feed.take_requests() if self.feed is not None else []
        for change in self.gcs.advance(self.sim_s, requests):
            if change.target in self.controls:
                self.controls[change.target].put(("link", change.link))
            self.gcs.announce(change)  # the drone process logs how many photos it synced
        latest: dict[str, dict] = {}
        for r in _drain(self.reports):
            latest[r["drone"]["id"]] = r
        for r in latest.values():
            if self.gcs.hear(r):
                self.out(f"{r['drone']['name']} joined the mission (simulated)")
        if self.gcs.heard:
            self.gcs.put()
        self.gcs.relay(self.sim_s)
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
        if self.feed is not None:
            self.feed.stop()
        for p in self.procs:
            p.join(10)
            if getattr(p, "is_alive", lambda: False)() and hasattr(p, "terminate"):
                p.terminate()


def parse_degrade(spec: tuple[str, str] | list[str] | None, at_s: float, link: str = "lost") -> list[dict]:  # fmt: skip
    """``--degrade D2 60s`` → one scheduled link change: D2 ``link`` for 60 simulated seconds,
    starting ``at_s`` simulated seconds into the run."""
    if not spec:
        return []
    target, dur = spec
    secs = float(dur.lower().removesuffix("s"))
    if secs <= 0:
        raise ValueError("--degrade needs a positive duration, like 60s")
    return [{"after_s": at_s, "target": target, "link": link, "for_s": secs}]


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
        degrade: tuple[str, str] = typer.Option(
            (None, None), help="cut a drone's link, e.g. --degrade D2 60s (simulated seconds)"
        ),
        degrade_at_s: float = typer.Option(120.0, help="when --degrade starts (simulated seconds)"),
        degrade_link: str = typer.Option("lost", help="lost or degraded"),
        no_signal: str = typer.Option("", help="teams with no signal from the start: T2 or T1,T2"),
    ) -> None:
        import signal

        def _stop(*_: Any) -> None:  # SIGTERM stops like Ctrl-C: the drone processes are joined
            raise KeyboardInterrupt

        signal.signal(signal.SIGTERM, _stop)
        extra = parse_degrade(degrade if degrade[0] else None, degrade_at_s, degrade_link)
        extra += [
            {"after_s": 0.0, "target": t.strip(), "link": "no_signal"}
            for t in no_signal.split(",")
            if t.strip()
        ]
        links = [*Scenario.load(scenario).links, *extra]
        with httpx.Client(base_url=api, timeout=httpx.Timeout(60.0, connect=10.0)) as http:
            if single:
                sim = FleetSim(http, mission, Scenario.load(scenario), time_scale=time_scale,
                               photo_every_m=photo_every_m, scripted_clue=scripted_clue, links=links)  # fmt: skip
                try:
                    sim.run(dt_s=dt_s)
                except KeyboardInterrupt:
                    say(f"stopped after {sim.photos} photos")
                return
            fleet = FleetProcesses(http, api, mission, scenario, time_scale=time_scale,
                                   photo_every_m=photo_every_m, dt_s=dt_s, scripted_clue=scripted_clue,
                                   links=links)  # fmt: skip
            try:
                fleet.run()
            except KeyboardInterrupt:
                say("stopped")

    @app.command("link")
    def link_cmd(
        target: str = typer.Argument(..., help="a drone (D2) or a team (T2)"),
        link: str = typer.Argument(
            ..., help="drone: connected, degraded, lost; team: connected, no_signal"
        ),
        api: str = typer.Option(..., help="API base URL"),
        mission: str = typer.Option(...),
        for_s: float = typer.Option(None, help="simulated seconds until it reverts"),
    ) -> None:
        """Ask a running fleet to change a link (``POST /fleet/link``; the sim applies it)."""
        with httpx.Client(base_url=api, timeout=30) as http:
            body = {"target": target, "link": link, "for_s": for_s, "by": "command (CLI)"}
            _send(http, "POST", f"/missions/{mission}/fleet/link", json=body)
        say(link_summary(body))

    @app.command("check")
    def check_cmd(scenario: str = typer.Option("creek")) -> None:
        """Loads the scenario and its frame pool (no API)."""
        scn = Scenario.load(scenario)
        pool = FramePool(scn)
        say(
            f"{scn.name}: {len(scn.drones)} drones, {len(pool.negatives)} no-person crops, positive {pool.positive.image.name}"
        )

    app()


if __name__ == "__main__":
    main()
