"""Assignment cards (LANE_B §5.3, B-K1): one page a ground team takes into the field, and the same
as GPX 1.1 and KML 2.2 for a handheld GPS or CalTopo.

- **Sector:** outline and cells from C's lattice (``sectors.py``); POA from the live map; drone
  coverage = the share of the sector's cells a photo has looked at.
- **Entry:** the point on the sector's edge nearest the team's last position (else nearest the last
  known position); bearing (true) and distance from the team.
- **Waypoints:** the entry, the four corners, and sweep lines across the sector's long axis every
  ``SWEEP_M`` (25 m, a typical hasty-search spacing), as start/end points; at most 40 (handheld GPS).
- **Look for:** the mission's subject, plus what the second look saw (clothing, posture) on
  detections inside the sector that it called a person or unclear, with their crops.

Built by lane A for lane B (issue #74); lane B owns this file.
"""

from __future__ import annotations

import math
from datetime import UTC, datetime
from typing import Any
from xml.sax.saxutils import escape

from sightline.contract import AssignmentCard, LatLon, Waypoint
from sightline.search.grid import latlon_to_local_m, local_m_to_latlon
from sightline.search.sectors import SectorLayout

SWEEP_M = 25.0
MAX_WAYPOINTS = 40
RADIO_CHANNEL = "Channel 2"  # the radio desk's channel until the incident's ICS 205 sets one
RADIO = (
    RADIO_CHANNEL
    + ". Report clues by radio: say “Sightline, {callsign}”, then what you found and where."
)
PHONETIC = {"A": "Alpha", "B": "Bravo", "C": "Charlie", "D": "Delta"}
NUMBERS = {"1": "One", "2": "Two", "3": "Three", "4": "Four"}


def sector_label(sector_id: str) -> str:
    """'B3' → 'Bravo Three': how the radio says it."""
    if len(sector_id) == 2 and sector_id[0] in PHONETIC and sector_id[1] in NUMBERS:
        return f"{PHONETIC[sector_id[0]]} {NUMBERS[sector_id[1]]}"
    return sector_id


def bearing_distance(from_: LatLon, to: LatLon) -> tuple[float, float]:
    """(initial bearing in degrees true, great-circle distance in metres)."""
    r = 6_371_008.8
    p1, p2 = math.radians(from_.lat), math.radians(to.lat)
    dl = math.radians(to.lon - from_.lon)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    bearing = (math.degrees(math.atan2(y, x)) + 360) % 360
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return bearing, 2 * r * math.asin(math.sqrt(a))


def _edge_point(rect: dict[str, float], e: float, s: float) -> tuple[float, float, str]:
    """The point on the rectangle's edge nearest (e, s), and its name ('east edge', 'north-west corner')."""
    ce = min(max(e, rect["east_min"]), rect["east_max"])
    cs = min(max(s, rect["south_min"]), rect["south_max"])
    inside = ce == e and cs == s
    if inside:  # the team is inside: the nearest edge
        d = {
            "west": e - rect["east_min"],
            "east": rect["east_max"] - e,
            "north": s - rect["south_min"],
            "south": rect["south_max"] - s,
        }
        side = min(d, key=d.get)
        ce, cs = {
            "west": (rect["east_min"], s),
            "east": (rect["east_max"], s),
            "north": (e, rect["south_min"]),
            "south": (e, rect["south_max"]),
        }[side]
        return ce, cs, f"{side} edge"
    ns = "north" if cs == rect["south_min"] else "south" if cs == rect["south_max"] else ""
    ew = "west" if ce == rect["east_min"] else "east" if ce == rect["east_max"] else ""
    name = f"{ns}-{ew} corner" if ns and ew else f"{ns or ew} edge"
    return ce, cs, name


def _sweeps(
    rect: dict[str, float], spacing: float
) -> list[tuple[tuple[float, float], tuple[float, float]]]:
    """Lines across the long axis, ``spacing`` apart, alternating direction (local metres)."""
    w, h = rect["east_max"] - rect["east_min"], rect["south_max"] - rect["south_min"]
    lines = []
    if w >= h:  # long east–west: lines run east–west, stacked north to south
        n = max(1, math.floor(h / spacing))
        for i in range(n):
            s = rect["south_min"] + (i + 0.5) * h / n
            a, b = (rect["east_min"], s), (rect["east_max"], s)
            lines.append((a, b) if i % 2 == 0 else (b, a))
    else:
        n = max(1, math.floor(w / spacing))
        for i in range(n):
            e = rect["east_min"] + (i + 0.5) * w / n
            a, b = (e, rect["south_min"]), (e, rect["south_max"])
            lines.append((a, b) if i % 2 == 0 else (b, a))
    return lines


def _wp(grid, name: str, e: float, s: float, note: str | None = None) -> Waypoint:
    p = local_m_to_latlon(grid, e, s)
    return Waypoint(name=name, lat=round(p.lat, 6), lon=round(p.lon, 6), note=note)


def assignment_card(
    mission_id: str, sector_id: str, store: Any, layout: SectorLayout, now: str | None = None
) -> AssignmentCard:
    now = now or datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    state = store.state(mission_id)
    live = store.live(mission_id)
    grid = live.base.grid
    sector = next((s for s in layout.sectors if s.id == sector_id), None)
    if sector is None:
        raise KeyError(f"no sector {sector_id}")
    rect, cells = sector.rect, layout.cells_of(sector_id)
    task = next((t for t in state["tasks"] if t.sector_id == sector_id), None)
    team = next((t for t in state["teams"] if task and t.id == task.team_id), None)

    origin = team.position if team and team.position else live.base.lkp
    e0, s0 = latlon_to_local_m(grid, origin)
    ee, es, entry_name = _edge_point(rect, e0, s0)
    entry = _wp(grid, entry_name, ee, es, "entry")
    bearing = distance = None
    if team and team.position:
        bearing, distance = bearing_distance(team.position, LatLon(lat=entry.lat, lon=entry.lon))

    corners = [
        _wp(grid, "north-west corner", rect["east_min"], rect["south_min"]),
        _wp(grid, "north-east corner", rect["east_max"], rect["south_min"]),
        _wp(grid, "south-east corner", rect["east_max"], rect["south_max"]),
        _wp(grid, "south-west corner", rect["east_min"], rect["south_max"]),
    ]
    sweeps = []
    for k, (a, b) in enumerate(_sweeps(rect, SWEEP_M), start=1):
        sweeps += [
            _wp(grid, f"Sweep {k} start", *a, "sweep"),
            _wp(grid, f"Sweep {k} end", *b, "sweep"),
        ]
    waypoints = ([entry, *corners, *sweeps])[:MAX_WAYPOINTS]

    canopy = (
        live.canopy()
        if callable(getattr(live, "canopy", None))
        else [None] * (grid.rows * grid.cols)
    )
    coverage = float(sum(canopy[int(i)] is not None for i in cells) / len(cells))
    poa = float(live.sector_poa(layout).get(sector_id, 0.0))

    look_for = [state["mission"].subject] if state["mission"].subject else []
    crops = []
    verdicts = {v.detection_id: v for v in state["verdicts"]}
    for frame_dets in store.detections(mission_id).frames.values():
        for d in frame_dets:
            v = verdicts.get(d.id)
            if v is None or v.person == "no":
                continue
            r, c = _cell(grid, d.lat, d.lon)
            if r is None or layout.cell_sector[r * grid.cols + c] != layout.sectors.index(sector):
                continue
            seen = ", ".join(
                x for x in (v.clothing, None if v.posture == "unknown" else v.posture) if x
            )
            look_for.append(
                f"{'possible person' if v.person == 'unclear' else 'person seen in a photo'}{': ' + seen if seen else ''} ({d.id})"
            )
            if d.crop:
                crops.append(d.crop)

    c = state["conditions"]
    line = daylight = None
    if c is not None:
        bits = [
            f"wind {c.wind_kmh:.0f} km/h" if c.wind_kmh is not None else None,
            f"gusts {c.gust_kmh:.0f} km/h" if c.gust_kmh is not None else None,
            f"rain {c.precip_mm_h:g} mm/h" if c.precip_mm_h else None,
            *(a.title for a in c.alerts[:2]),
        ]
        line = ", ".join(b for b in bits if b) or None
        if c.civil_twilight_end:
            left = (
                datetime.fromisoformat(c.civil_twilight_end) - datetime.fromisoformat(now)
            ).total_seconds()
            daylight = max(0, int(left // 60))
    callsign = team.callsign if team else "your team"
    return AssignmentCard(
        mission_id=mission_id,
        sector_id=sector_id,
        sector_label=sector_label(sector_id),
        team_id=team.id if team else None,
        team_callsign=team.callsign if team else None,
        polygon=layout.polygon(sector_id, grid),
        area_m2=(rect["east_max"] - rect["east_min"]) * (rect["south_max"] - rect["south_min"]),
        entry=entry,
        bearing_deg_from_team=None if bearing is None else round(bearing),
        distance_m_from_team=None if distance is None else round(distance),
        waypoints=waypoints,
        poa=round(min(1.0, poa), 4),
        drone_coverage=round(coverage, 3),
        look_for=look_for,
        evidence_crops=crops,
        conditions_line=line,
        daylight_remaining_min=daylight,
        radio=RADIO.format(callsign=callsign),
        generated_at=now,
    )


def _cell(grid, lat: float, lon: float) -> tuple[int | None, int | None]:
    from sightline.search.grid import cell_containing

    rc = cell_containing(grid, LatLon(lat=lat, lon=lon))
    return (None, None) if rc is None else rc


def to_gpx(card: AssignmentCard) -> str:
    """GPX 1.1: a <wpt> per waypoint, the boundary as a <trk>, the sweep lines as one <rte>."""

    def pt(tag: str, w: Waypoint) -> str:
        return f'<{tag} lat="{w.lat}" lon="{w.lon}"><name>{escape(w.name)}</name>{f"<desc>{escape(w.note)}</desc>" if w.note else ""}</{tag}>'

    title = escape(f"Sector {card.sector_label} ({card.sector_id})")
    trk = "".join(f'<trkpt lat="{lat}" lon="{lon}"/>' for lon, lat in card.polygon)
    sweeps = [w for w in card.waypoints if w.note == "sweep"]
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<gpx version="1.1" creator="Sightline" xmlns="http://www.topografix.com/GPX/1/1">\n'
        f"<metadata><name>{title}</name><desc>{escape(card.radio)}</desc></metadata>\n"
        + "\n".join(pt("wpt", w) for w in card.waypoints)
        + "\n"
        + f"<trk><name>{title} boundary</name><trkseg>{trk}</trkseg></trk>\n"
        + (
            f"<rte><name>{title} sweep lines</name>"
            + "".join(pt("rtept", w) for w in sweeps)
            + "</rte>\n"
            if sweeps
            else ""
        )
        + "</gpx>\n"
    )


def to_kml(card: AssignmentCard) -> str:
    """KML 2.2: the sector polygon, a point per waypoint and a line per sweep, in one Document."""
    title = escape(f"Sector {card.sector_label} ({card.sector_id})")
    ring = " ".join(f"{lon},{lat},0" for lon, lat in card.polygon)
    points = "".join(
        f"<Placemark><name>{escape(w.name)}</name><Point><coordinates>{w.lon},{w.lat},0</coordinates></Point></Placemark>"
        for w in card.waypoints
    )
    sweeps = [w for w in card.waypoints if w.note == "sweep"]
    lines = "".join(
        f"<Placemark><name>{escape(a.name.removesuffix(' start'))}</name><LineString><coordinates>{a.lon},{a.lat},0 {b.lon},{b.lat},0</coordinates></LineString></Placemark>"
        for a, b in zip(sweeps[::2], sweeps[1::2], strict=False)
    )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
        f"<name>{title}</name><description>{escape(card.radio)}</description>"
        f"<Placemark><name>{title}</name><Polygon><outerBoundaryIs><LinearRing><coordinates>{ring}</coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>"
        f"{points}{lines}</Document></kml>\n"
    )
