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
- the **base camp**: the staging point nearest the LKP (``STAGING``, demo points on this map).

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
from typing import Any

import numpy as np

from sightline.contract import Grid, LatLon
from sightline.search.grid import cell_center, latlon_to_local_m, local_m_to_latlon
from sightline.search.prior import koester_prior, prior_source

# Where teams can stage on the demo map (Mount Seymour); the first is the story's trailhead lot.
# Demo points, labelled so: not a survey of the real access points.
STAGING: tuple[tuple[str, float, float], ...] = (
    ("Trailhead lot", 49.373, -122.949),
    ("Forest road gate (demo point)", 49.3665, -122.9395),
    ("Power-line access (demo point)", 49.3700, -122.9505),
    ("Creek bridge pull-out (demo point)", 49.3740, -122.9420),
)

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
) -> DemoScenario:
    """The scenario for ``seed`` on ``grid`` (``survey``: the flight's footprint corners, [lon, lat]).

    Optional, both off by default (the same seed then gives the same scenario as before):
    ``affinity`` (a ``geo.terrain_affinity.TerrainAffinity``) draws the person from the prior
    multiplied by the terrain, as a mission using it would; ``min_road_distance_m`` (needs
    ``affinity``, which carries each cell's distance to a road) keeps the person at least that far
    from a mapped road, since a subject within reach of a road is usually not lost. If no cell is
    that far, the condition is dropped."""
    preset = next(((name, kind) for name, s, kind in PRESETS.values() if s == seed), None)
    rng = np.random.default_rng(seed)
    kind = preset[1] if preset else str(rng.choice(sorted(KINDS)))
    category, subject, texts = KINDS[kind]
    name = preset[0] if preset else f"Random search (seed {seed})"

    s, n, w, e = _bounds(survey, grid)
    lkp = LatLon(lat=round(float(rng.uniform(s, n)), 6), lon=round(float(rng.uniform(w, e)), 6))

    hour = int(rng.integers(9, 16))  # last seen between 09:00 and 15:59 local (UTC-7 in October)
    minute = int(rng.integers(0, 60))
    seen = datetime.fromisoformat(f"{day}T{hour + 7:02d}:{minute:02d}:00+00:00")
    call = seen + timedelta(minutes=int(rng.integers(90, 241)))

    p, _ = koester_prior(grid, lkp, category, affinity=affinity)
    if min_road_distance_m is not None:
        if affinity is None:
            raise ValueError("min_road_distance_m needs affinity (the road distances)")
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

    camp = min(STAGING, key=lambda x: math.dist((x[1], x[2]), (lkp.lat, lkp.lon)))
    return DemoScenario(
        seed=seed, name=name, kind=kind, category=category,
        prior_source=prior_source(category, affinity=affinity is not None),
        subject=subject, lkp=lkp, last_seen_at=seen.strftime("%Y-%m-%dT%H:%M:%SZ"),
        call_at=call.strftime("%Y-%m-%dT%H:%M:%SZ"),
        base_camp={"lat": camp[1], "lon": camp[2], "name": camp[0]},
        clues=clues, person=person,
    )  # fmt: skip
