"""Demo scenarios: a different search each time (contract §15, v1.3). Demo only, labelled so.

``generate(seed, grid, survey)`` draws one search from a seed, deterministically (the same seed and
survey give the same scenario, field for field: ``numpy.random.default_rng(seed)`` is the only
source of chance):

- the **lost-person category** (or the preset's) and a subject line;
- the **last known point**, inside the survey area (the simulated flight path stays the survey; the
  photo-to-cell placement follows it, so only the prior and the clues move);
- the **time of day** the person was last seen, and when the call comes;
- **where the person is**, drawn from the prior the mission will use (``koester_prior`` around the
  LKP; the uniform placeholder for a category with no checked distance rings);
- **3 or 4 clues**, on the way from the LKP towards the person (as a person walking leaves them),
  of kinds that fit the category, each with a time, a reliability and who reported it;
- the **base camp**: the staging point nearest the LKP (``STAGING``: the trailhead lot and three
  stopping places on Mount Seymour Road): where a team can drive to, and where the drones launch
  from and fly out to the search area (``survey_launch``);
- with ``min_road_distance_m`` (and ``affinity``, which carries each cell's distance to a road), the
  **last known point** too is at least that far from a road (``MIN_ROAD_M``, 300 m, for the demo's
  presets and shuffle: ``demo_affinity`` builds the affinity from the basemap); people go missing in
  the terrain, not beside the car park;
- the **distractors** (with ``frames``, the survey's photo centres in flight order): two or three
  things a drone photo shows that look like a search but are not the person (``DISTRACTORS``: a
  backpack, a fire ring, a shelter, other hikers), each next to a survey photo where it is
  plausible (by a trail for the backpack, the fire ring and the hikers, off it for the shelter),
  never near the person. The fixture adds each as an extra photo of the flight (real licensed
  photos, ``web/public/cache-extras/distractors/``) with the live second look's verdict.

Four named presets fix the seed and the category: "Overdue hiker", "Missing child", "Despondent",
"Dementia walk-away". The prior has checked Koester distance rings only for hikers and dementia
(``prior.py``: nothing else could be checked against a source), so "Missing child" and "Despondent"
use the labelled uniform placeholder prior, and say so in ``prior_source``.

The person's position is truth: it is used to script the find, never sent to the mission's files
(``public`` leaves it out).
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta
from functools import lru_cache
from typing import Any

import numpy as np

from sightline.contract import Grid, LatLon
from sightline.search.grid import cell_center, latlon_to_local_m, local_m_to_latlon
from sightline.search.prior import koester_prior, prior_source

# Where teams can stage on the demo map (Mount Seymour): the trailhead lot at the end of Mount
# Seymour Road and three stopping places down the road, each on the basemap's road (within 2 m).
STAGING: tuple[tuple[str, float, float], ...] = (
    ("Mount Seymour trailhead lot", 49.36585, -122.94840),
    ("Viewpoint lot", 49.36416, -122.94832),
    ("Creek bridge pull-out", 49.36186, -122.95080),
    ("Power-line access", 49.36080, -122.95297),
)
MIN_ROAD_M = 300.0  # the demo's presets and shuffle: LKP and person at least this far from a road
DRONE_KMH = 36.0  # the drones' transit speed from base camp to the survey (an assumption, 10 m/s)

# What a drone photo shows that looks like a search and is not the person: (kind, the review
# answer the scripted image reviewer gives it, the object type of that answer, by a trail).
DISTRACTORS: tuple[tuple[str, str, str | None, bool], ...] = (
    ("backpack", "object", "backpack", True),
    ("fire ring", "object", "fire ring", True),
    ("shelter", "object", "shelter", False),
    ("hikers", "not_subject", None, True),
)
TRAIL_M = 40.0  # "by a trail": a photo centre this close to a basemap path
CLEAR_OF_PERSON_M = 120.0  # a distractor's photo is never this near the person

KINDS = {
    # kind key: (category for the prior or None, subject line, clue texts by kind)
    "hiker": ("hiker/temperate_mountainous", "adult day hiker, overdue, red jacket", (
        ("track", "fresh boot prints leaving the trail"),
        ("object", "energy bar wrapper by a fallen log"),
        ("sound", "possible whistle, three blasts"),
        ("sighting", "another hiker saw someone in a red jacket off the trail"),
        ("object", "blue water bottle by the creek"),
    )),
    "child": (None, "child, 8, missing from a family picnic, yellow raincoat", (
        ("object", "a small yellow hood caught on a bush"),
        ("sound", "a child's voice heard calling"),
        ("track", "small shoe prints in the mud"),
        ("object", "a juice box, half full"),
        ("sighting", "a dog walker saw a child in yellow near the trees"),
    )),
    "despondent": (None, "despondent adult, left a note, grey jacket", (
        ("object", "a grey scarf on a rock"),
        ("track", "a single set of prints off the trail"),
        ("object", "a phone case, the subject's colour"),
        ("sighting", "a cyclist saw someone sitting alone near the viewpoint"),
    )),
    "dementia": ("dementia/temperate_mountainous", "older adult with dementia, walked away, slippers", (
        ("object", "a slipper on the path"),
        ("sighting", "a neighbour saw someone in a dressing gown walking slowly"),
        ("track", "shuffling prints on the gravel"),
        ("object", "a cardigan on a fence"),
    )),
}  # fmt: skip

PRESETS = {
    "overdue-hiker": ("Overdue hiker", 1101, "hiker"),
    "missing-child": ("Missing child", 2202, "child"),
    "despondent": ("Despondent", 3303, "despondent"),
    "dementia": ("Dementia walk-away", 4404, "dementia"),
}


@dataclass(frozen=True)
class ScenarioClue:
    minutes: float  # after the call
    kind: str
    text: str
    lat: float
    lon: float
    reliability: str
    reported_by: str  # a team id or "command" (a member of the public, by phone)


@dataclass(frozen=True)
class ScenarioDistractor:
    kind: str  # "backpack" | "fire ring" | "shelter" | "hikers"
    near_frame: str  # the survey photo it is placed after (its own photo is the next in flight)
    lat: float
    lon: float
    review: str  # the image reviewer's answer: "object" or "not_subject"
    object: str | None  # the object type for an "object" answer
    trail_m: float  # metres from the photo centre to the nearest basemap trail


@dataclass(frozen=True)
class DemoScenario:
    seed: int
    name: str
    kind: str
    category: str | None
    prior_source: str
    subject: str
    lkp: LatLon
    last_seen_at: str
    call_at: str
    base_camp: dict
    clues: list[ScenarioClue] = field(default_factory=list)
    person: LatLon | None = None  # truth: never in a mission file
    lkp_road_m: float | None = None  # metres from the LKP to the nearest basemap road
    survey_launch: dict | None = None  # {"from": base camp name, "transit_m", "transit_min"}
    distractors: list[ScenarioDistractor] = field(default_factory=list)

    def public(self) -> dict:
        """Everything but where the person is."""
        d = asdict(self)
        d.pop("person")
        d["lkp"] = self.lkp.model_dump()
        return d


def _bounds(
    survey: list[tuple[float, float]] | None, grid: Grid
) -> tuple[float, float, float, float]:
    """(south, north, west, east) of the survey's footprints, shrunk by a tenth on each side; the
    grid's middle half when there is no survey yet."""
    if survey:
        lats, lons = [p[1] for p in survey], [p[0] for p in survey]
        s, n, w, e = min(lats), max(lats), min(lons), max(lons)
    else:
        size_e, size_s = grid.cols * grid.cell_m, grid.rows * grid.cell_m
        nw = local_m_to_latlon(grid, size_e * 0.25, size_s * 0.25)
        se = local_m_to_latlon(grid, size_e * 0.75, size_s * 0.75)
        s, n, w, e = se.lat, nw.lat, nw.lon, se.lon
    dl, dn = (n - s) * 0.1, (e - w) * 0.1
    return s + dl, n - dl, w + dn, e - dn


def preset_seed(name_or_seed: str | int) -> int:
    """A preset's seed by its key ("dementia") or name ("Dementia walk-away"), or the seed itself."""
    if isinstance(name_or_seed, int) or str(name_or_seed).lstrip("-").isdigit():
        return int(name_or_seed)
    key = str(name_or_seed).strip().lower()
    for k, (name, seed, _) in PRESETS.items():
        if key in (k, name.lower()):
            return seed
    raise KeyError(f"no preset {name_or_seed!r}: {', '.join(PRESETS)} or a number")


def generate(
    seed: int,
    grid: Grid,
    survey: list[tuple[float, float]] | None = None,
    day: str = "2026-10-24",
    affinity: Any = None,
    min_road_distance_m: float | None = None,
    frames: list[tuple[str, float, float]] | None = None,
) -> DemoScenario:
    """The scenario for ``seed`` on ``grid`` (``survey``: the flight's footprint corners, [lon, lat]).

    Optional, both off by default (the same seed then gives the same scenario as before):
    ``affinity`` (a ``geo.terrain_affinity.TerrainAffinity``) draws the person from the prior
    multiplied by the terrain, as a mission using it would; ``min_road_distance_m`` (needs
    ``affinity``, which carries each cell's distance to a road) keeps the person at least that far
    from a mapped road, since a subject within reach of a road is usually not lost. If no cell is
    that far, the condition is dropped. With it the LKP is drawn that far from a road as well.
    ``frames``: the survey photos' ``(id, lat, lon)`` in flight order, for the distractors."""
    preset = next(((name, kind) for name, s, kind in PRESETS.values() if s == seed), None)
    rng = np.random.default_rng(seed)
    kind = preset[1] if preset else str(rng.choice(sorted(KINDS)))
    category, subject, texts = KINDS[kind]
    name = preset[0] if preset else f"Random search (seed {seed})"

    if min_road_distance_m is not None and affinity is None:
        raise ValueError("min_road_distance_m needs affinity (the road distances)")
    lkp = _lkp(rng, grid, survey, affinity if min_road_distance_m is not None else None,
               min_road_distance_m)  # fmt: skip

    hour = int(rng.integers(9, 16))  # last seen between 09:00 and 15:59 local (UTC-7 in October)
    minute = int(rng.integers(0, 60))
    seen = datetime.fromisoformat(f"{day}T{hour + 7:02d}:{minute:02d}:00+00:00")
    call = seen + timedelta(minutes=int(rng.integers(90, 241)))

    p, _ = koester_prior(grid, lkp, category, affinity=affinity)
    if min_road_distance_m is not None:
        far = affinity.far_from_roads(min_road_distance_m)
        if np.any(p[far] > 0):
            p = np.where(far, p, 0.0)
    idx = int(rng.choice(p.size, p=p / p.sum()))
    c = cell_center(grid, idx)
    jitter = rng.uniform(-0.4, 0.4, size=2) * grid.cell_m
    ce, cs = latlon_to_local_m(grid, c)
    person = local_m_to_latlon(grid, ce + jitter[0], cs + jitter[1])
    person = LatLon(lat=round(person.lat, 6), lon=round(person.lon, 6))

    k = int(rng.integers(3, 5))
    picks = rng.choice(len(texts), size=min(k, len(texts)), replace=False)
    le, ls = latlon_to_local_m(grid, lkp)
    pe, ps = latlon_to_local_m(grid, person)
    clues = []
    for j, t in enumerate(sorted(int(x) for x in picks)):
        f = (j + 1) / (len(picks) + 1) + float(rng.uniform(-0.08, 0.08))  # along the way, in order
        ne, ns = (
            le + (pe - le) * f + float(rng.normal(0, 25)),
            ls + (ps - ls) * f + float(rng.normal(0, 25)),
        )
        ne = min(max(ne, 0.0), grid.cols * grid.cell_m - 1)
        ns = min(max(ns, 0.0), grid.rows * grid.cell_m - 1)
        at = local_m_to_latlon(grid, ne, ns)
        clue_kind, text = texts[t]
        clues.append(ScenarioClue(
            minutes=round(20 + 50 * (j + 1) / (len(picks) + 1) + float(rng.uniform(-3, 3)), 1),
            kind=clue_kind, text=text, lat=round(at.lat, 6), lon=round(at.lon, 6),
            reliability=str(rng.choice(["low", "medium", "high"], p=[0.25, 0.5, 0.25])),
            reported_by="command" if clue_kind == "sighting" else f"T{int(rng.integers(1, 5))}",
        ))  # fmt: skip

    camp = base_camp(lkp)
    return DemoScenario(
        seed=seed, name=name, kind=kind, category=category,
        prior_source=prior_source(category, affinity=affinity is not None),
        subject=subject, lkp=lkp, last_seen_at=seen.strftime("%Y-%m-%dT%H:%M:%SZ"),
        call_at=call.strftime("%Y-%m-%dT%H:%M:%SZ"), base_camp=camp,
        clues=clues, person=person, lkp_road_m=round(float(road_m(lkp.lat, lkp.lon)), 1),
        survey_launch=_launch(camp, survey),
        distractors=pick_distractors(seed, frames or [], person),
    )  # fmt: skip


def road_m(lat: float, lon: float) -> float:
    """Metres to the nearest basemap road (``sightline/geo/roads.py``)."""
    from sightline.geo.roads import distance_to_road_m

    return distance_to_road_m(lat, lon)


@lru_cache(maxsize=4)
def _affinity_cached(grid_json: str) -> Any:
    from sightline.geo.roads import BASEMAP
    from sightline.geo.terrain_affinity import affinity_raster, features_from_pmtiles, grid_bbox

    grid = Grid.model_validate_json(grid_json)
    return affinity_raster(grid, features_from_pmtiles(BASEMAP, grid_bbox(grid)), "basemap")


def demo_affinity(grid: Grid) -> Any:
    """The terrain affinity of ``grid`` from the web's basemap (``geo.terrain_affinity``), for the
    demo's presets and shuffle (with ``min_road_distance_m=MIN_ROAD_M``)."""
    return _affinity_cached(grid.model_dump_json())


def _lkp(rng: np.random.Generator, grid: Grid, survey: list[tuple[float, float]] | None,
         affinity: Any = None, min_m: float | None = None) -> LatLon:  # fmt: skip
    """A point inside the survey area (shrunk by a tenth). With ``min_m``: one whose cell is at least
    that far from a road (``affinity.road_distance_m``), drawn again up to 400 times, then a cell of
    the grid's middle half that is; none at all (a grid in a town): the first draw."""
    from sightline.search.grid import cell_containing

    s, n, w, e = _bounds(survey, grid)
    first = None
    for _ in range(400 if min_m is not None else 1):
        p = LatLon(lat=round(float(rng.uniform(s, n)), 6), lon=round(float(rng.uniform(w, e)), 6))
        first = first or p
        if min_m is None:
            return p
        rc = cell_containing(grid, p)
        if rc is not None and affinity.road_distance_m[rc[0] * grid.cols + rc[1]] >= min_m:
            return p
    d = affinity.road_distance_m.reshape(grid.rows, grid.cols)
    r0, r1, c0, c1 = grid.rows // 4, 3 * grid.rows // 4, grid.cols // 4, 3 * grid.cols // 4
    ok = [r * grid.cols + c for r in range(r0, r1) for c in range(c0, c1) if d[r, c] >= min_m]
    if not ok:
        return first
    c = cell_center(grid, int(rng.choice(ok)))
    return LatLon(lat=round(c.lat, 6), lon=round(c.lon, 6))


def base_camp(lkp: LatLon) -> dict:
    """The staging point nearest the LKP (``STAGING``: all on the road, where a team can drive to)."""
    camp = min(STAGING, key=lambda x: _metres(lkp.lat, lkp.lon, x[1], x[2]))
    return {"lat": camp[1], "lon": camp[2], "name": camp[0]}


def _metres(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    kx = 111_320.0 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot((lon2 - lon1) * kx, (lat2 - lat1) * 110_540.0)


def _launch(camp: dict, survey: list[tuple[float, float]] | None) -> dict | None:
    """The survey flight starts at the base camp and flies out to the search area: how far."""
    if not survey:
        return None
    d = min(_metres(camp["lat"], camp["lon"], lat, lon) for lon, lat in survey)
    return {"from": camp["name"], "transit_m": round(d),
            "transit_min": round(d / (DRONE_KMH * 1000 / 60), 1)}  # fmt: skip


def pick_distractors(
    seed: int, frames: list[tuple[str, float, float]], person: LatLon | None
) -> list[ScenarioDistractor]:
    """Two or three of ``DISTRACTORS`` for this seed, each placed after a survey photo where it is
    plausible and away from the person. Its own random stream (``[seed, 7]``), so the rest of the
    scenario does not depend on it."""
    if not frames:
        return []
    from sightline.geo.roads import distances_m, paths

    rng = np.random.default_rng([seed, 7])
    n = int(rng.integers(2, 4))
    kinds = sorted(int(k) for k in rng.choice(len(DISTRACTORS), size=n, replace=False))
    trail = distances_m([f[1] for f in frames], [f[2] for f in frames], paths())
    used: list[int] = []
    out = []
    for k in kinds:
        kind, review, obj, by_trail = DISTRACTORS[k]
        ok = [
            i for i, f in enumerate(frames)
            if (trail[i] <= TRAIL_M) == by_trail
            and (person is None or _metres(f[1], f[2], person.lat, person.lon) >= CLEAR_OF_PERSON_M)
            and all(abs(i - j) > len(frames) // 10 for j in used)
        ]  # fmt: skip
        if not ok:
            continue
        i = int(rng.choice(ok))
        used.append(i)
        fid, lat, lon = frames[i]
        out.append(ScenarioDistractor(kind=kind, near_frame=fid, lat=round(lat, 6), lon=round(lon, 6),
                                      review=review, object=obj, trail_m=round(float(trail[i]), 1)))  # fmt: skip
    return sorted(out, key=lambda d: d.near_frame)
