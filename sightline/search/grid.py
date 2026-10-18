"""The search grid: cell geometry and lookups (contract section 8).

All metres-to-degrees conversions use 111320 m per degree, and longitude uses
cos(origin_nw.lat) for the whole grid, exactly as the contract's cell formulas do.
"Local metres" below means (east_m, south_m) from origin_nw in that same flat model,
so cell (row, col) is the square [col, col+1] x [row, row+1] times cell_m.
"""

from __future__ import annotations

import math

from sightline.contract import Grid, LatLon

M_PER_DEG_LAT = 111_320.0


# Metres per degree of longitude for the whole grid (fixed at origin_nw's latitude).
def _m_per_deg_lon(grid: Grid) -> float:
    return M_PER_DEG_LAT * math.cos(math.radians(grid.origin_nw.lat))


# Build the 1 km grid centred on the LKP.
def make_grid(lkp: LatLon, size_m: float = 1000.0, cell_m: float = 20.0) -> Grid:
    """Square grid of side size_m centred on the LKP; origin_nw is its north-west corner.

    The longitude offset uses cos(origin_nw.lat), so the LKP is exactly the shared corner
    of the four middle cells under the contract's cell formulas.
    """
    n_cells = size_m / cell_m
    if cell_m <= 0 or size_m <= 0 or abs(n_cells - round(n_cells)) > 1e-9:
        raise ValueError(f"size_m={size_m} must be a positive whole multiple of cell_m={cell_m}")
    n = round(n_cells)
    origin_lat_deg = lkp.lat + (size_m / 2) / M_PER_DEG_LAT
    origin_lon_deg = lkp.lon - (size_m / 2) / (
        M_PER_DEG_LAT * math.cos(math.radians(origin_lat_deg))
    )
    return Grid(
        origin_nw=LatLon(lat=origin_lat_deg, lon=origin_lon_deg),
        cell_m=cell_m,
        rows=n,
        cols=n,
    )


# Convert a position to (east_m, south_m) from origin_nw.
def latlon_to_local_m(grid: Grid, p: LatLon) -> tuple[float, float]:
    """(east_m, south_m) of p from the grid's north-west corner, in the grid's flat model."""
    east_m = (p.lon - grid.origin_nw.lon) * _m_per_deg_lon(grid)
    south_m = (grid.origin_nw.lat - p.lat) * M_PER_DEG_LAT
    return east_m, south_m


# Convert (east_m, south_m) from origin_nw back to a position.
def local_m_to_latlon(grid: Grid, east_m: float, south_m: float) -> LatLon:
    """Inverse of latlon_to_local_m."""
    return LatLon(
        lat=grid.origin_nw.lat - south_m / M_PER_DEG_LAT,
        lon=grid.origin_nw.lon + east_m / _m_per_deg_lon(grid),
    )


def _row_col(grid: Grid, idx: int) -> tuple[int, int]:
    if not 0 <= idx < grid.rows * grid.cols:
        raise IndexError(f"cell index {idx} outside grid of {grid.rows * grid.cols} cells")
    return divmod(idx, grid.cols)


# Centre of one cell.
def cell_center(grid: Grid, idx: int) -> LatLon:
    """Centre of cell idx (row 0 = north, col 0 = west, idx = row * cols + col)."""
    row, col = _row_col(grid, idx)
    return local_m_to_latlon(grid, (col + 0.5) * grid.cell_m, (row + 0.5) * grid.cell_m)


# Four corners of one cell, GeoJSON order.
def cell_polygon(grid: Grid, idx: int) -> list[tuple[float, float]]:
    """Cell corners as [lon, lat] in the order NW, NE, SE, SW. Not closed (4 points)."""
    row, col = _row_col(grid, idx)
    west_m, east_m = col * grid.cell_m, (col + 1) * grid.cell_m
    north_m, south_m = row * grid.cell_m, (row + 1) * grid.cell_m
    corners = []
    for e_m, s_m in ((west_m, north_m), (east_m, north_m), (east_m, south_m), (west_m, south_m)):
        c = local_m_to_latlon(grid, e_m, s_m)
        corners.append((c.lon, c.lat))
    return corners


# Row and column of the cell that contains a point, or None outside the grid.
def cell_containing(grid: Grid, p: LatLon) -> tuple[int, int] | None:
    """(row, col) of the cell containing p; None if p is outside the grid.

    Points exactly on an inner edge belong to the cell to the south / east.
    """
    east_m, south_m = latlon_to_local_m(grid, p)
    row = math.floor(south_m / grid.cell_m)
    col = math.floor(east_m / grid.cell_m)
    if 0 <= row < grid.rows and 0 <= col < grid.cols:
        return row, col
    return None


# All cells whose square comes within radius_m of a point.
def cells_within_radius(grid: Grid, p: LatLon, radius_m: float) -> list[int]:
    """Cells whose square lies within radius_m of p (point-to-square distance).

    Always includes the cell containing p when p is inside the grid. Never returns cells
    outside the grid. Returns sorted flat indices. Only the bounding window of rows and
    columns around p is checked.
    """
    if radius_m < 0:
        raise ValueError(f"radius_m must be >= 0, got {radius_m}")
    east_m, south_m = latlon_to_local_m(grid, p)
    c = grid.cell_m
    row_lo = max(0, math.floor((south_m - radius_m) / c))
    row_hi = min(grid.rows - 1, math.floor((south_m + radius_m) / c))
    col_lo = max(0, math.floor((east_m - radius_m) / c))
    col_hi = min(grid.cols - 1, math.floor((east_m + radius_m) / c))

    found: set[int] = set()
    for row in range(row_lo, row_hi + 1):
        # Distance from p to the cell's band along each axis; 0 when p is inside it.
        d_south_m = max(row * c - south_m, 0.0, south_m - (row + 1) * c)
        for col in range(col_lo, col_hi + 1):
            d_east_m = max(col * c - east_m, 0.0, east_m - (col + 1) * c)
            if math.hypot(d_east_m, d_south_m) <= radius_m:
                found.add(row * grid.cols + col)

    home = cell_containing(grid, p)
    if home is not None:
        found.add(home[0] * grid.cols + home[1])
    return sorted(found)
