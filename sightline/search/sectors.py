"""Search sectors (LANE_C §4, C-S1): a line-for-line port of ``web/src/map/heat/sectors.ts``.

Two layouts, the same ids, rectangles and cell assignment in both languages (checked by the shared
vectors, ``write_sector_vectors`` → ``web/src/map/heat/__fixtures__/sector_vectors.json``):

- ``"flight"``: when the survey was flown as east–west lines (the demo flight), the photographed
  rectangle is cut into sectors of ``LINES_PER_SECTOR`` consecutive flight lines, S1, S2, … in flight
  order, and the rest of the grid becomes four outer sectors N, E, S, W (``build_sectors``).
- ``"lattice"``: otherwise, and always on live missions (stable ids while photos are still
  arriving): a 4 × 4 map-reference lattice, **columns A–D west to east, rows 1–4 north to south**
  (A1 is the north-west corner), bounds in metres (250 m on the 1 km grid).

A cell belongs to the sector that contains its centre. Rectangles are in metres from the grid's
north-west corner; Python names their sides ``east_min``/``east_max``/``south_min``/``south_max``
(TS: ``west``/``east``/``north``/``south``).

Changed 2026-10-22: the Python lattice used letter = row and number = column, so Python "B3" was
the TS "C2", and split by whole cells (a "250 m" sector was 240 m on a 20 m grid). Runs recorded
before then name sectors the old way.

Built by lane A for lane C (issue #64); lane C owns this file.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Literal

import numpy as np

from sightline.contract import Grid, LonLat
from sightline.search.grid import M_PER_DEG_LAT, local_m_to_latlon

LATTICE_SIZE = 4
LINES_PER_SECTOR = 4  # flight lines per sector (one flight block of the demo's blocks layout)
LINE_TOLERANCE_M = 3.0  # frames within this north–south are on the same east–west line
SEARCHED_COVERAGE = 0.9  # a sector is "searched by drone" at this share of photographed cells
STARTED_COVERAGE = 0.02  # below this it is "not yet searched"
SectorState = Literal["searched", "in_progress", "not_searched"]


@dataclass(frozen=True)
class Sector:
    id: str
    label: str
    kind: Literal["flight", "outer", "lattice"]
    # east_min, east_max, south_min, south_max: metres from the grid's north-west corner
    rect: dict[str, float]
    steps: tuple[int, int] | None = None


@dataclass(frozen=True)
class SectorLayout:
    kind: Literal["flight", "lattice"]
    sectors: list[Sector]
    cell_sector: np.ndarray = field(repr=False)  # sector index per cell (int16)

    def cells_of(self, sector_id: str) -> np.ndarray:
        i = next((k for k, s in enumerate(self.sectors) if s.id == sector_id), None)
        if i is None:
            raise KeyError(f"no sector {sector_id}")
        return np.flatnonzero(self.cell_sector == i)

    def polygon(self, sector_id: str, grid: Grid) -> list[LonLat]:
        """The sector's outline as a closed [lon, lat] ring (NW, NE, SE, SW, NW)."""
        r = next(s for s in self.sectors if s.id == sector_id).rect
        corners = [
            (r["east_min"], r["south_min"]),
            (r["east_max"], r["south_min"]),
            (r["east_max"], r["south_max"]),
            (r["east_min"], r["south_max"]),
        ]
        ring = [local_m_to_latlon(grid, e, s) for e, s in corners]
        out = [(p.lon, p.lat) for p in ring]
        return [*out, out[0]]


def _local(grid: Grid, lon: float, lat: float) -> tuple[float, float]:
    """(east, south) metres from the grid's NW corner: the TS ``toLocalM``."""
    m_lon = M_PER_DEG_LAT * math.cos(math.radians(grid.origin_nw.lat))
    return (lon - grid.origin_nw.lon) * m_lon, (grid.origin_nw.lat - lat) * M_PER_DEG_LAT


def _rect(west: float, east: float, north: float, south: float) -> dict[str, float]:
    return {"east_min": west, "east_max": east, "south_min": north, "south_max": south}


def assign_cells(grid: Grid, sectors: list[Sector]) -> np.ndarray:
    """Index of the sector containing each cell centre (first match; edges go east/south)."""
    out = np.full(grid.rows * grid.cols, -1, dtype=np.int16)
    for row in range(grid.rows):
        y = (row + 0.5) * grid.cell_m
        for col in range(grid.cols):
            x = (col + 0.5) * grid.cell_m
            out[row * grid.cols + col] = next(
                (k for k, s in enumerate(sectors)
                 if s.rect["east_min"] <= x < s.rect["east_max"] and s.rect["south_min"] <= y < s.rect["south_max"]),
                -1,
            )  # fmt: skip
    out[out == -1] = 0  # a centre can't be on the far edge, but keep every cell owned
    return out


def _lattice(grid: Grid) -> list[Sector]:
    width, height = grid.cols * grid.cell_m, grid.rows * grid.cell_m
    out = []
    for r in range(LATTICE_SIZE):
        for c in range(LATTICE_SIZE):
            sid = f"{chr(65 + c)}{r + 1}"  # column letter west→east, row number north→south
            rect = _rect(c * width / LATTICE_SIZE, (c + 1) * width / LATTICE_SIZE,
                         r * height / LATTICE_SIZE, (r + 1) * height / LATTICE_SIZE)  # fmt: skip
            out.append(Sector(sid, sid, "lattice", rect))
    return out


def lattice_sectors(grid: Grid) -> SectorLayout:
    """The 4 × 4 lattice (live missions): every cell belongs to exactly one sector."""
    sectors = _lattice(grid)
    return SectorLayout("lattice", sectors, assign_cells(grid, sectors))


@dataclass(frozen=True)
class FrameLike:
    """What ``build_sectors`` reads of a survey frame: its pose and its footprint ([lon, lat] × 4)."""

    lat: float
    lon: float
    footprint: list[tuple[float, float]]


def flight_lines(grid: Grid, frames: list[FrameLike]) -> list[tuple[int, int, float]] | None:
    """Consecutive frames grouped into east–west lines (first, last, south); None when the flight
    isn't such lines."""
    if len(frames) < LINES_PER_SECTOR * 2:
        return None
    lines: list[tuple[int, int, float]] = []
    start, start_south = 0, _local(grid, frames[0].lon, frames[0].lat)[1]
    for i in range(1, len(frames) + 1):
        south = _local(grid, frames[i].lon, frames[i].lat)[1] if i < len(frames) else math.nan
        if not abs(south - start_south) < LINE_TOLERANCE_M:
            lines.append((start, i - 1, start_south))
            start, start_south = i, south
    if len(lines) < LINES_PER_SECTOR or any(last - first < 2 for first, last, _ in lines):
        return None
    for first, last, _ in lines:
        xs = [_local(grid, frames[i].lon, frames[i].lat)[0] for i in range(first, last + 1)]
        if max(xs) - min(xs) < 2 * LINE_TOLERANCE_M:
            return None
    sign = lambda v: (v > 0) - (v < 0)
    d = sign(lines[1][2] - lines[0][2])
    if any(sign(lines[k][2] - lines[k - 1][2]) != d or d == 0 for k in range(1, len(lines))):
        return None
    return lines


def _footprint_bounds(
    grid: Grid, frames: list[FrameLike], first: int, last: int
) -> dict[str, float]:
    west, east, north, south = math.inf, -math.inf, math.inf, -math.inf
    for i in range(first, last + 1):
        for lon, lat in frames[i].footprint:
            x, y = _local(grid, lon, lat)
            west, east, north, south = min(west, x), max(east, x), min(north, y), max(south, y)
    return {"west": west, "east": east, "north": north, "south": south}


def build_sectors(grid: Grid, frames: list[FrameLike]) -> SectorLayout:
    """Flight blocks when the flight is east–west lines, else the 4 × 4 lattice (TS ``buildSectors``)."""
    width, height = grid.cols * grid.cell_m, grid.rows * grid.cell_m
    clamp = lambda v, size: min(size, max(0.0, v))
    lines = flight_lines(grid, frames)
    sectors: list[Sector] = []
    kind: Literal["flight", "lattice"] = "lattice"
    if lines:
        whole = _footprint_bounds(grid, frames, 0, len(frames) - 1)
        west, east = clamp(whole["west"], width), clamp(whole["east"], width)
        groups = [lines[k : k + LINES_PER_SECTOR] for k in range(0, len(lines), LINES_PER_SECTOR)]
        bounds = [_footprint_bounds(grid, frames, g[0][0], g[-1][1]) for g in groups]
        order = sorted(range(len(bounds)), key=lambda i: bounds[i]["north"])  # stable, as JS sort
        edges = [clamp(bounds[order[0]]["north"], height)]
        for k in range(1, len(order)):
            edges.append(
                clamp((bounds[order[k - 1]]["south"] + bounds[order[k]]["north"]) / 2, height)
            )
        edges.append(clamp(bounds[order[-1]]["south"], height))
        rect_of = {g: _rect(west, east, edges[k], edges[k + 1]) for k, g in enumerate(order)}
        if west < east and edges[0] < edges[-1]:
            kind = "flight"
            for i, g in enumerate(groups):
                sectors.append(
                    Sector(
                        f"S{i + 1}", str(i + 1), "flight", rect_of[i], (g[0][0] + 1, g[-1][1] + 1)
                    )
                )
            top, bottom = edges[0], edges[-1]
            for sid, r in (("N", _rect(0, width, 0, top)), ("E", _rect(east, width, top, bottom)),
                           ("S", _rect(0, width, bottom, height)), ("W", _rect(0, west, top, bottom))):  # fmt: skip
                if r["east_max"] - r["east_min"] > 0 and r["south_max"] - r["south_min"] > 0:
                    sectors.append(Sector(sid, sid, "outer", r))
    if kind == "lattice":
        sectors = _lattice(grid)
    return SectorLayout(kind, sectors, assign_cells(grid, sectors))


def sector_state(coverage: float) -> SectorState:
    if coverage >= SEARCHED_COVERAGE:
        return "searched"
    if coverage >= STARTED_COVERAGE:
        return "in_progress"
    return "not_searched"


# --- shared vectors (§6 test 1): the TS sectors.ts must give the same layouts ---------------------

SECTOR_VECTORS = "web/src/map/heat/__fixtures__/sector_vectors.json"


def _rle(a: np.ndarray) -> list[list[int]]:
    out: list[list[int]] = []
    for v in a.tolist():
        if out and out[-1][0] == v:
            out[-1][1] += 1
        else:
            out.append([int(v), 1])
    return out


def _case(name: str, grid: Grid, frames: list[FrameLike]) -> dict:
    layout = build_sectors(grid, frames)
    return {
        "name": name,
        "grid": grid.model_dump(mode="json"),
        "frames": [
            {"pose": {"lat": f.lat, "lon": f.lon}, "footprint": [list(c) for c in f.footprint]}
            for f in frames
        ],
        "kind": layout.kind,
        "sectors": [
            {
                "id": s.id,
                "label": s.label,
                "kind": s.kind,
                "steps": list(s.steps) if s.steps else None,
                "rect": {
                    "west": s.rect["east_min"],
                    "east": s.rect["east_max"],
                    "north": s.rect["south_min"],
                    "south": s.rect["south_max"],
                },
            }
            for s in layout.sectors
        ],
        "cell_sector_rle": _rle(layout.cell_sector),
    }


def _synthetic_flight(
    grid: Grid, lines: int, per_line: int, half_m: float = 10.0
) -> list[FrameLike]:
    """A serpentine of east–west lines 20 m apart, photos 20 m apart, footprints ±half_m."""
    from sightline.search.grid import local_m_to_latlon

    frames = []
    for k in range(lines):
        south = 100.0 + 20.0 * k
        xs = [150.0 + 20.0 * i for i in range(per_line)]
        for x in xs if k % 2 == 0 else reversed(xs):
            p = local_m_to_latlon(grid, x, south)
            fp = [
                local_m_to_latlon(grid, x + dx, south + dy)
                for dx, dy in (
                    (-half_m, -half_m),
                    (half_m, -half_m),
                    (half_m, half_m),
                    (-half_m, half_m),
                )
            ]
            frames.append(FrameLike(p.lat, p.lon, [(q.lon, q.lat) for q in fp]))
    return frames


def build_sector_vectors(demo_survey: str | None = "web/public/cache/demo/survey.json") -> dict:
    from pathlib import Path

    from sightline.contract import LatLon
    from sightline.search.grid import make_grid

    lkp = LatLon(lat=49.375, lon=-122.9375)
    g20, g5 = make_grid(lkp), make_grid(lkp, cell_m=5.0)
    odd = Grid(origin_nw=g20.origin_nw, cell_m=7.0, rows=37, cols=41)  # sectors cut through cells
    cases = [
        _case("lattice 50x50 (no frames)", g20, []),
        _case("lattice 37x41 of 7 m (edges inside cells)", odd, []),
        _case("synthetic serpentine, 12 lines of 8 photos", g5, _synthetic_flight(g5, 12, 8)),
        _case(
            "not lines: one column of photos (lattice fallback)", g20, _synthetic_flight(g20, 9, 1)
        ),
    ]
    if demo_survey and Path(demo_survey).is_file():
        from sightline.contract import MapFile, Survey

        survey = Survey.model_validate_json(Path(demo_survey).read_text())
        grid = MapFile.model_validate_json((Path(demo_survey).parent / "map.json").read_text()).grid
        frames = [FrameLike(f.pose.lat, f.pose.lon, [tuple(c) for c in f.footprint])
                  for f in sorted(survey.frames, key=lambda f: f.flight_index)]  # fmt: skip
        cases.append(_case("demo cache flight (Mount Seymour)", grid, frames))
    return {
        "note": "Generated by `python -m sightline.search.sectors`; do not edit by hand.",
        "cases": cases,
    }


def write_sector_vectors(out: str = SECTOR_VECTORS) -> None:
    import json
    from pathlib import Path

    Path(out).parent.mkdir(parents=True, exist_ok=True)
    Path(out).write_text(json.dumps(build_sector_vectors(), separators=(",", ":")) + "\n")


if __name__ == "__main__":
    write_sector_vectors()
    print(f"wrote {SECTOR_VECTORS}")
