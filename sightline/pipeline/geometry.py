"""Flat-earth geometry for 1 km areas: footprints, pixel to lat/lon and a placeholder flight.

Lane B owns the real versions (`sightline.geo`). These keep the pipeline and the sample cache
working until B's functions exist; the `place` and `georef` stages prefer B's when they can.
"""

from __future__ import annotations

import math

from sightline.contract import Grid, LatLon, Pose

M_PER_DEG_LAT = 111320.0
FRAME_W_PX, FRAME_H_PX = 1000, 750
GSD_M = 0.02
LINE_SPACING_M = 20.0  # between flight lines; equals the frame width on the ground
FRAME_SPACING_M = 15.0  # along a line; equals the frame height on the ground


def offset(lat: float, lon: float, east_m: float, north_m: float) -> tuple[float, float]:
    """Move (lat, lon) by metres east and north."""
    return (
        lat + north_m / M_PER_DEG_LAT,
        lon + east_m / (M_PER_DEG_LAT * math.cos(math.radians(lat))),
    )


def _axes(heading_deg: float) -> tuple[tuple[float, float], tuple[float, float]]:
    """(east, north) unit vectors of the image's up and right directions."""
    h = math.radians(heading_deg)
    return (math.sin(h), math.cos(h)), (math.cos(h), -math.sin(h))


def footprint(
    pose: Pose, width_px: int = FRAME_W_PX, height_px: int = FRAME_H_PX
) -> tuple[tuple[float, float], ...]:
    """Image corners as [lon, lat]: top-left, top-right, bottom-right, bottom-left (image order)."""
    up, right = _axes(pose.heading_deg)
    half_w, half_h = width_px * pose.gsd_m / 2, height_px * pose.gsd_m / 2
    corners = []
    for sign_up, sign_right in ((1, -1), (1, 1), (-1, 1), (-1, -1)):
        east = sign_up * half_h * up[0] + sign_right * half_w * right[0]
        north = sign_up * half_h * up[1] + sign_right * half_w * right[1]
        lat, lon = offset(pose.lat, pose.lon, east, north)
        corners.append((lon, lat))
    return tuple(corners)


def pixel_to_latlon(
    pose: Pose,
    x_px: float,
    y_px: float,
    width_px: int = FRAME_W_PX,
    height_px: int = FRAME_H_PX,
) -> tuple[float, float]:
    """Ground position (lat, lon) of a pixel in a frame whose centre is at `pose`."""
    up, right = _axes(pose.heading_deg)
    dx = (x_px - width_px / 2) * pose.gsd_m  # metres to the right of the centre
    dy = (y_px - height_px / 2) * pose.gsd_m  # metres below the centre
    return offset(pose.lat, pose.lon, dx * right[0] - dy * up[0], dx * right[1] - dy * up[1])


def placeholder_flight(n_frames: int, lkp: LatLon) -> list[Pose]:
    """A lawnmower path centred on the LKP: lines 20 m apart going south, frames 15 m apart.

    500 frames make 20 lines of 25, 20 make 4 of 5, 41 make lines of 25 and 16. Up to 1200 frames
    fit inside the 1 km grid. Lines alternate between heading 90 (east) and 270 (west).
    Simulated, like the real demo path.
    """
    if n_frames % 25 == 0:
        per_line = 25
    elif n_frames % 5 == 0 and n_frames <= 250:
        per_line = 5
    else:
        per_line = min(25, n_frames)
    lines = -(-n_frames // per_line)  # ceiling division; the last line may be shorter
    poses = []
    for k in range(n_frames):
        line, i = divmod(k, per_line)
        eastward = line % 2 == 0
        east = (-(per_line - 1) * FRAME_SPACING_M / 2) + FRAME_SPACING_M * (
            i if eastward else per_line - 1 - i
        )
        north = ((lines - 1) * LINE_SPACING_M / 2) - LINE_SPACING_M * line
        lat, lon = offset(lkp.lat, lkp.lon, east, north)
        poses.append(
            Pose(
                lat=lat,
                lon=lon,
                alt_agl_m=None,
                heading_deg=90.0 if eastward else 270.0,
                gsd_m=GSD_M,
            )
        )
    return poses


GRID_ROWS = GRID_COLS = 50
CELL_M = 20.0


def grid_origin_nw(
    lkp: LatLon, rows: int = GRID_ROWS, cols: int = GRID_COLS, cell_m: float = CELL_M
) -> LatLon:
    """North-west corner of a grid centred on the LKP (contract section 8)."""
    lat = lkp.lat + (rows * cell_m / 2) / M_PER_DEG_LAT
    lon = lkp.lon - (cols * cell_m / 2) / (M_PER_DEG_LAT * math.cos(math.radians(lat)))
    return LatLon(lat=lat, lon=lon)


def cell_center(grid: Grid, idx: int) -> tuple[float, float]:
    """(lat, lon) of a cell centre. Row 0 is the northernmost row, column 0 the westernmost."""
    row, col = divmod(idx, grid.cols)
    lat = grid.origin_nw.lat - (row + 0.5) * grid.cell_m / M_PER_DEG_LAT
    lon = grid.origin_nw.lon + (col + 0.5) * grid.cell_m / (
        M_PER_DEG_LAT * math.cos(math.radians(grid.origin_nw.lat))
    )
    return lat, lon
