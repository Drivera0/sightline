"""Search sectors (LANE_C §4, C-S1): the 4 × 4 lattice live and replay missions use.

Rows A–D from north, columns 1–4 from west (A1 is the north-west corner): stable ids while photos
are still arriving. Each sector knows its cells (``cells_of``) and its outline (``polygon``, for
assignment cards and the map). Demo caches keep the flight-line sectors drawn by
``web/src/map/heat/sectors.ts``; porting ``buildSectors`` to Python is still lane C's.

Built by lane A for lane C (issue #64); lane C owns this file.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

import numpy as np

from sightline.contract import Grid, LonLat
from sightline.search.grid import local_m_to_latlon

LATTICE_SIZE = 4
ROWS = "ABCD"


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


def lattice_sectors(grid: Grid) -> SectorLayout:
    """A 4 × 4 lattice over the grid; every cell belongs to exactly one sector."""
    n = grid.rows * grid.cols
    rows, cols = np.arange(n) // grid.cols, np.arange(n) % grid.cols
    cell_sector = np.zeros(n, dtype=np.int16)
    sectors: list[Sector] = []
    for r in range(LATTICE_SIZE):
        for c in range(LATTICE_SIZE):
            sid = f"{ROWS[r]}{c + 1}"
            r0, r1 = r * grid.rows // LATTICE_SIZE, (r + 1) * grid.rows // LATTICE_SIZE
            c0, c1 = c * grid.cols // LATTICE_SIZE, (c + 1) * grid.cols // LATTICE_SIZE
            cell_sector[(rows >= r0) & (rows < r1) & (cols >= c0) & (cols < c1)] = len(sectors)
            rect = {
                "east_min": c0 * grid.cell_m,
                "east_max": c1 * grid.cell_m,
                "south_min": r0 * grid.cell_m,
                "south_max": r1 * grid.cell_m,
            }
            sectors.append(Sector(sid, f"Sector {sid}", "lattice", rect))
    return SectorLayout("lattice", sectors, cell_sector)
