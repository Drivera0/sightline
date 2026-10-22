"""The simulated fleet (LANE_C §5.6, C-F1), an HTTP client like the photo clients:

    uv run python -m sightline.search.fleet run --api URL --mission ID [--scenario creek]

It registers the scenario's drones (``PUT /fleet``), then each tick reads the approved legs from the
mission (``GET /state``), moves each drone along its leg at ``speed_ms × time_scale``, and takes a photo
every ``photo_every_m`` along the leg: a crop of a HERIDAL **validation** photo with EXIF GPS, the
35 mm focal length and DJI XMP altitude/yaw written for its simulated pose, uploaded through
``POST /photos``: the same path as real photos. Each tick ends with ``PUT /fleet`` (positions,
battery, and only ``flying``/``done`` for its legs). The sim never creates, approves or reassigns legs.

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
import time
from collections.abc import Callable
from dataclasses import dataclass, field
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


@dataclass(frozen=True)
class Scenario:
    name: str
    lkp: LatLon
    drones: list[Drone]
    hidden: LatLon  # truth: only ever used to pick an image
    positive: dict  # {"image": name, "box": index}
    clue: dict | None  # a scripted clue for rehearsals: {"after_s": sim seconds, ...ClueDraft}
    line_spacing_m: float = 20.0

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
        for img in imgs:
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
            raise ValueError("no clear crops in the validation photos")


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


# --- the sim ------------------------------------------------------------------------------------


@dataclass
class SimDrone:
    drone: Drone
    leg: Leg | None = None
    route: list[tuple[float, float]] = field(default_factory=list)  # metres, from here to the end
    in_survey: bool = False  # past the leg's first waypoint: photos are taken
    to_next_photo_m: float = 0.0
    heading_deg: float = 0.0


class FleetSim:
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
        self.now = now or (lambda: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
        self.out = out
        self.sim_s = 0.0
        self.photos = 0
        self.drones = [SimDrone(d) for d in scenario.drones]
        self.leg_status: dict[str, str] = {}
        self.clue_sent = False

    def register(self) -> None:
        """The scenario's drones join the mission (the first ``PUT /fleet`` creates its fleet)."""
        self._put()
        self.out(f"fleet: {', '.join(d.drone.name for d in self.drones)} (simulated)")

    def _approved(self) -> dict[str, Leg]:
        fleet = _call(self.http, "GET", f"/missions/{self.mid}/state").json()["fleet"] or {}
        return {
            leg.id: leg
            for leg in (Leg.model_validate(x) for x in fleet.get("legs", []))
            if leg.status in ("approved", "flying")
        }

    def tick(self, dt_s: float) -> None:
        """``dt_s`` wall seconds: drones take their next approved leg, fly, photograph; telemetry."""
        sim_dt = dt_s * self.time_scale
        self.sim_s += sim_dt
        legs = self._approved()
        for sd in self.drones:
            if sd.leg is not None and sd.leg.id not in legs:  # re-tasked: the store cancelled it
                self.out(f"{sd.drone.name}: {sd.leg.id} cancelled")
                sd.leg = None
                sd.drone = sd.drone.model_copy(update={"status": "idle"})
            if sd.leg is None:
                nxt = next(
                    (
                        leg
                        for leg in legs.values()
                        if leg.drone_id == sd.drone.id and leg.id not in self.leg_status
                    ),
                    None,
                )
                if nxt is not None:
                    self._start(sd, nxt)
            self._fly(sd, sd.drone.speed_ms * sim_dt)
            pct = max(
                0.0, sd.drone.battery_pct - DRAIN_PCT_PER_MIN * sim_dt / 60 * (sd.leg is not None)
            )
            sd.drone = sd.drone.model_copy(update={"battery_pct": round(pct, 1)})
        if (
            self.scripted_clue
            and self.scn.clue
            and not self.clue_sent
            and self.sim_s >= self.scn.clue["after_s"]
        ):
            draft = {k: v for k, v in self.scn.clue.items() if k != "after_s"}
            _call(self.http, "POST", f"/missions/{self.mid}/clues", json=draft)
            self.clue_sent = True
            self.out(f"scripted clue (rehearsal): {draft['text']}")
        self._put()

    def _pos_m(self, sd: SimDrone) -> tuple[float, float]:
        p = sd.drone.position or self.scn.lkp
        return _to_m(self.scn.lkp, p.lon, p.lat)

    def _start(self, sd: SimDrone, leg: Leg) -> None:
        sd.leg = leg
        sd.route = [_to_m(self.scn.lkp, lon, lat) for lon, lat in leg.waypoints]
        sd.in_survey, sd.to_next_photo_m = False, 0.0
        self.leg_status[leg.id] = "flying"
        sd.drone = sd.drone.model_copy(update={"status": "flying", "altitude_m": leg.altitude_m})
        self.out(f"{sd.drone.name}: flying {leg.id} ({leg.sector_id or 'leg'})")

    def _fly(self, sd: SimDrone, dist_m: float) -> None:
        while sd.leg is not None and dist_m > 1e-9:
            x, y = self._pos_m(sd)
            tx, ty = sd.route[0]
            gap = math.hypot(tx - x, ty - y)
            if gap > 1e-9:
                sd.heading_deg = math.degrees(math.atan2(tx - x, ty - y)) % 360
            step = min(dist_m, gap)
            if sd.in_survey:  # photos only along the leg, not on the way to its start
                step = min(step, sd.to_next_photo_m)
            nx, ny = (
                (x + (tx - x) * step / gap, y + (ty - y) * step / gap) if gap > 1e-9 else (tx, ty)
            )
            lon, lat = _to_ll(self.scn.lkp, nx, ny)
            sd.drone = sd.drone.model_copy(update={"position": LatLon(lat=lat, lon=lon)})
            dist_m -= step
            if sd.in_survey:
                sd.to_next_photo_m -= step
                if sd.to_next_photo_m <= 1e-9:
                    self._photo(sd)
                    sd.to_next_photo_m = self.photo_every_m
            if math.hypot(tx - nx, ty - ny) <= 1e-6:
                sd.route.pop(0)
                if not sd.in_survey:  # reached the first waypoint: the survey starts with a photo
                    sd.in_survey = True
                    self._photo(sd)
                    sd.to_next_photo_m = self.photo_every_m
                if not sd.route:
                    self.leg_status[sd.leg.id] = "done"
                    self.out(f"{sd.drone.name}: {sd.leg.id} done")
                    sd.leg = None
                    sd.drone = sd.drone.model_copy(update={"status": "idle"})

    def _photo(self, sd: SimDrone) -> None:
        p = sd.drone.position
        assert p is not None
        pos = self.pool.positive
        w, h = pos.box[2] - pos.box[0], pos.box[3] - pos.box[1]
        pose = Pose(
            lat=p.lat,
            lon=p.lon,
            alt_agl_m=sd.drone.altitude_m,
            heading_deg=sd.heading_deg,
            gsd_m=pos.gsd_m,
        )
        crop = (
            pos
            if covers(pose, w, h, self.scn.hidden)
            else self.pool.negatives[self.photos % len(self.pool.negatives)]
        )
        self.photos += 1
        name = f"SIM_{sd.drone.id}_{self.photos:04d}.jpg"
        data = stamp(crop, p.lat, p.lon, sd.drone.altitude_m, sd.heading_deg)
        r = _call(
            self.http,
            "POST",
            f"/missions/{self.mid}/photos",
            files=[("files", (name, data, "image/jpeg"))],
        ).json()
        if r["rejected"]:
            self.out(f"{name} rejected: {r['rejected'][0]['reason']}")

    def _put(self) -> None:
        body = {
            "drones": [sd.drone.model_dump(mode="json") for sd in self.drones],
            "leg_status": dict(self.leg_status),
            "at": self.now(),
        }
        _call(self.http, "PUT", f"/missions/{self.mid}/fleet", json=body)

    def run(
        self,
        dt_s: float = 1.0,
        ticks: int | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.register()
        n = 0
        while ticks is None or n < ticks:
            try:
                self.tick(dt_s)
            except Offline as e:
                self.out(f"offline ({e}); retrying")
            n += 1
            sleep(dt_s)


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
        scripted_clue: bool = typer.Option(False, help="post the scenario's clue (rehearsals)"),
    ) -> None:
        with httpx.Client(base_url=api, timeout=httpx.Timeout(60.0, connect=10.0)) as http:
            sim = FleetSim(http, mission, Scenario.load(scenario), time_scale=time_scale,
                           photo_every_m=photo_every_m, scripted_clue=scripted_clue)  # fmt: skip
            try:
                sim.run()
            except KeyboardInterrupt:
                say(f"stopped after {sim.photos} photos")

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
