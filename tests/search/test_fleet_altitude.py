"""The fleet sim's crop follows the leg's altitude (the re-look leg flies at 25 m): a narrower
window around the same centre, stamped at the same pixel size with half the GSD, so a person is
twice as large; at 50 m nothing changes. The drone goes back to its survey altitude afterwards."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from sightline.contract import Drone, LatLon, Leg
from sightline.geo.pose import read_pose
from sightline.search.fleet import NATIVE_ALT_M, Crop, DroneSim, Scenario, at_altitude, stamp
from tests.fixtures.drone_photos import LKP

GSD = 0.02


def _square_crop(tmp: Path) -> Crop:
    """A grey 1000×750 crop with a 20×20 px dark square at its centre (the 'person')."""
    img = np.full((900, 1200, 3), 180, np.uint8)
    img[365:385, 490:510] = 20  # centre of the (0, 0, 1000, 750) box is (500, 375)
    p = tmp / "src.png"
    Image.fromarray(img).save(p)
    return Crop(p, (0, 0, 1000, 750), GSD)


def _dark_width(path: Path) -> int:
    a = np.asarray(Image.open(path).convert("L"))
    cols = np.where((a < 90).any(axis=0))[0]
    return int(cols.max() - cols.min() + 1)


def test_at_native_altitude_and_above_the_crop_is_unchanged(tmp_path: Path) -> None:
    c = _square_crop(tmp_path)
    assert at_altitude(c, NATIVE_ALT_M) is c
    assert at_altitude(c, 80.0) is c


def test_a_25_m_pass_doubles_the_person_and_halves_the_gsd(tmp_path: Path) -> None:
    c = _square_crop(tmp_path)
    low = at_altitude(c, 25.0)
    assert low.zoom == pytest.approx(2.0) and low.gsd_m == pytest.approx(GSD / 2)
    assert low.box == (250, 188, 750, 563)  # half as wide, same centre
    p50, p25 = tmp_path / "p50.jpg", tmp_path / "p25.jpg"
    p50.write_bytes(stamp(c, 49.37, -122.93, 50.0, 0.0))
    p25.write_bytes(stamp(low, 49.37, -122.93, 25.0, 0.0))
    with Image.open(p50) as a, Image.open(p25) as b:
        assert a.size == b.size == (1000, 750)  # same pixels, half the ground
    assert _dark_width(p25) == pytest.approx(2 * _dark_width(p50), abs=3)
    info = read_pose(p25)
    assert info is not None and info.pose.alt_agl_m == 25.0
    assert info.pose.gsd_m == pytest.approx(GSD / 2, rel=0.03)  # lane B reads the lower pass back


class _Http:
    def __init__(self) -> None:
        self.posts: list[list] = []

    def request(self, method, path, files=None, **kw):
        self.posts.append(files or [])

        class R:
            status_code = 200

            def json(self):
                return {"accepted": [], "rejected": []}

            def raise_for_status(self):
                return None

        return R()


def test_the_drone_photographs_at_the_legs_altitude_then_goes_back_up(tmp_path: Path) -> None:
    c = _square_crop(tmp_path)

    class Pool:
        positive, negatives = c, [c]

    d = Drone(id="D1", name="Drone 1", simulated=True, position=LatLon(**LKP), altitude_m=50,
              speed_ms=8, battery_pct=100, max_wind_kmh=38, status="idle", leg_id=None)  # fmt: skip
    scn = Scenario(name="t", lkp=LatLon(**LKP), drones=[d], hidden=LatLon(**LKP), positive={},
                   clue=None)  # fmt: skip
    http = _Http()
    sim = DroneSim(d, http, "m", scn, Pool(), out=lambda _: None)
    here = (LKP["lon"], LKP["lat"])
    there = (LKP["lon"] + 0.0004, LKP["lat"])  # about 29 m east
    leg = Leg(id="L9", drone_id="D1", sector_id="C3", waypoints=[here, there], altitude_m=25,
              est_minutes=1, expected_clearance=0.01, score_per_min=0.01, reason="re-look",
              status="approved")  # fmt: skip
    sim.step(1.0, {"L9": leg})
    assert sim.drone.altitude_m == 25.0
    for _ in range(6):
        sim.step(1.0, {"L9": leg})
    assert sim.leg_status["L9"] == "done"
    assert sim.drone.altitude_m == 50.0  # the planner plans the next leg from the survey altitude
    photos = [f for batch in http.posts for f in batch]
    assert photos
    first = tmp_path / "first.jpg"
    first.write_bytes(photos[0][1][1])
    info = read_pose(first)
    assert info is not None and info.pose.alt_agl_m == 25.0
    assert info.pose.gsd_m == pytest.approx(GSD / 2, rel=0.03)
