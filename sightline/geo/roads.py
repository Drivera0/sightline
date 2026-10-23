"""Roads from the web's basemap (``web/public/basemap/northshore.pmtiles``), read in pure Python.

The demo scenarios (``sightline/search/demo_scenario.py``) put the last known point and the person
at least ``MIN_ROAD_M`` from any road, and the base camp at the road access nearest the LKP. This
reads the same PMTiles archive the map draws (Protomaps basemap, OpenStreetMap data, ODbL), so the
scenario and the map agree on where the roads are.

Only what that needs: a PMTiles v3 reader (header, directories, gzip tiles) and a Mapbox Vector Tile
decoder for line geometry. No dependency beyond the standard library.

A **road** is a feature of the ``roads`` layer whose ``kind`` is ``highway``, ``major_road`` or
``minor_road`` (forest service roads and tracks are ``minor_road`` in Protomaps); ``path`` (trails,
footways) is not a road: hikers walk them, cars do not reach them.
"""

from __future__ import annotations

import gzip
import itertools
import math
import struct
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASEMAP = ROOT / "web/public/basemap/northshore.pmtiles"
ROAD_KINDS = ("highway", "major_road", "minor_road")
ZOOM = 15  # the basemap's most detailed zoom: service roads and lots appear only there

# --- PMTiles v3 ------------------------------------------------------------------------------


def _varint(buf: bytes, pos: int) -> tuple[int, int]:
    out = shift = 0
    while True:
        b = buf[pos]
        pos += 1
        out |= (b & 0x7F) << shift
        if not b & 0x80:
            return out, pos
        shift += 7


def _unzip(data: bytes, compression: int) -> bytes:
    if compression == 2:
        return gzip.decompress(data)
    if compression in (0, 1):
        return data
    raise ValueError(f"PMTiles compression {compression} not supported")


def _directory(buf: bytes) -> list[tuple[int, int, int, int]]:
    """(tile_id, offset, length, run_length) entries of one decompressed directory."""
    n, pos = _varint(buf, 0)
    ids, runs, lens, offs = [], [], [], []
    last = 0
    for _ in range(n):
        d, pos = _varint(buf, pos)
        last += d
        ids.append(last)
    for _ in range(n):
        v, pos = _varint(buf, pos)
        runs.append(v)
    for _ in range(n):
        v, pos = _varint(buf, pos)
        lens.append(v)
    for i in range(n):
        v, pos = _varint(buf, pos)
        offs.append(offs[i - 1] + lens[i - 1] if v == 0 and i > 0 else v - 1)
    return list(zip(ids, offs, lens, runs, strict=True))


def zxy_to_tileid(z: int, x: int, y: int) -> int:
    """PMTiles' tile id: the tiles of lower zooms, then the Hilbert index at ``z``."""
    acc = sum(4**k for k in range(z))
    n = 1 << z
    d, s = 0, n >> 1
    while s > 0:
        rx = 1 if x & s else 0
        ry = 1 if y & s else 0
        d += s * s * ((3 * rx) ^ ry)
        if ry == 0:
            if rx == 1:
                x, y = n - 1 - x, n - 1 - y
            x, y = y, x
        s >>= 1
    return acc + d


@dataclass(frozen=True)
class PmTiles:
    data: bytes

    @property
    def header(self) -> dict:
        if self.data[:7] != b"PMTiles" or self.data[7] != 3:
            raise ValueError("not a PMTiles v3 archive")
        f = struct.unpack("<QQQQQQQQQQQBBBBBBiiiiBii", self.data[8:127])
        keys = ("root_off", "root_len", "meta_off", "meta_len", "leaf_off", "leaf_len",
                "tile_off", "tile_len", "addressed", "entries", "contents", "clustered",
                "internal_comp", "tile_comp", "tile_type", "min_zoom", "max_zoom",
                "min_lon_e7", "min_lat_e7", "max_lon_e7", "max_lat_e7", "center_zoom",
                "center_lon_e7", "center_lat_e7")  # fmt: skip
        return dict(zip(keys, f, strict=True))

    def tile(self, z: int, x: int, y: int) -> bytes | None:
        """The decompressed tile, or None when the archive has none there."""
        h = self.header
        tid = zxy_to_tileid(z, x, y)
        off, length = h["root_off"], h["root_len"]
        for _ in range(4):  # root, then at most three levels of leaves
            entries = _directory(_unzip(self.data[off : off + length], h["internal_comp"]))
            hit = None
            for e in entries:
                if e[0] > tid:
                    break
                hit = e
            if hit is None:
                return None
            eid, eoff, elen, run = hit
            if run == 0:  # a leaf directory
                off, length = h["leaf_off"] + eoff, elen
                continue
            if tid >= eid + run:
                return None
            raw = self.data[h["tile_off"] + eoff : h["tile_off"] + eoff + elen]
            return _unzip(raw, h["tile_comp"])
        return None


# --- Mapbox Vector Tile: line geometry of one layer ------------------------------------------


def _fields(buf: bytes):
    """(field number, wire type, value) of one protobuf message; length-delimited as bytes."""
    pos = 0
    while pos < len(buf):
        key, pos = _varint(buf, pos)
        fn, wt = key >> 3, key & 7
        if wt == 0:
            v, pos = _varint(buf, pos)
        elif wt == 2:
            n, pos = _varint(buf, pos)
            v, pos = buf[pos : pos + n], pos + n
        elif wt == 5:
            v, pos = buf[pos : pos + 4], pos + 4
        elif wt == 1:
            v, pos = buf[pos : pos + 8], pos + 8
        else:
            raise ValueError(f"protobuf wire type {wt}")
        yield fn, wt, v


def _packed(buf: bytes) -> list[int]:
    out, pos = [], 0
    while pos < len(buf):
        v, pos = _varint(buf, pos)
        out.append(v)
    return out


def _value(buf: bytes):
    for fn, _, v in _fields(buf):
        if fn == 1:
            return v.decode()
        if fn in (4, 5):
            return v
        if fn == 6:
            return (v >> 1) ^ -(v & 1)
        if fn == 7:
            return bool(v)
        if fn == 3:
            return struct.unpack("<d", v)[0]
        if fn == 2:
            return struct.unpack("<f", v)[0]
    return None


def _lines(geom: list[int]) -> list[list[tuple[int, int]]]:
    out: list[list[tuple[int, int]]] = []
    x = y = i = 0
    while i < len(geom):
        cmd, count = geom[i] & 7, geom[i] >> 3
        i += 1
        if cmd == 7:  # ClosePath
            if out and out[-1]:
                out[-1].append(out[-1][0])
            continue
        for _ in range(count):
            dx, dy = geom[i], geom[i + 1]
            i += 2
            x += (dx >> 1) ^ -(dx & 1)
            y += (dy >> 1) ^ -(dy & 1)
            if cmd == 1:
                out.append([(x, y)])
            else:
                out[-1].append((x, y))
    return out


def layer_lines(tile: bytes, layer: str) -> list[tuple[dict, list[list[tuple[int, int]]], int]]:
    """(properties, lines in tile units, extent) of each feature in ``layer``."""
    out = []
    for fn, _, lbuf in _fields(tile):
        if fn != 3:
            continue
        name, keys, values, feats, extent = None, [], [], [], 4096
        for f, _, v in _fields(lbuf):
            if f == 1:
                name = v.decode()
            elif f == 2:
                feats.append(v)
            elif f == 3:
                keys.append(v.decode())
            elif f == 4:
                values.append(_value(v))
            elif f == 5:
                extent = v
        if name != layer:
            continue
        for fb in feats:
            tags, geom, gtype = [], [], 0
            for f, wt, v in _fields(fb):
                if f == 2:
                    tags = _packed(v) if wt == 2 else [v]
                elif f == 3:
                    gtype = v
                elif f == 4:
                    geom = _packed(v)
            if gtype != 2:  # lines only
                continue
            props = {keys[tags[k]]: values[tags[k + 1]] for k in range(0, len(tags) - 1, 2)}
            out.append((props, _lines(geom), extent))
    return out


# --- roads -----------------------------------------------------------------------------------


def _lonlat(z: int, x: int, y: int, px: float, py: float, extent: int) -> tuple[float, float]:
    n = 1 << z
    lon = (x + px / extent) / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + py / extent) / n))))
    return lon, lat


def roads(
    path: str = str(BASEMAP), zoom: int = ZOOM
) -> tuple[tuple[tuple[float, float], ...], ...]:
    """Every road line in the archive as ``((lon, lat), ...)``, read at ``zoom``."""
    return lines_of(ROAD_KINDS, path, zoom)


def paths(
    path: str = str(BASEMAP), zoom: int = ZOOM
) -> tuple[tuple[tuple[float, float], ...], ...]:
    """Every trail (``kind`` ``path``: paths, tracks, footways, steps) as ``((lon, lat), ...)``."""
    return lines_of(("path",), path, zoom)


@lru_cache(maxsize=8)
def lines_of(
    kinds: tuple[str, ...], path: str = str(BASEMAP), zoom: int = ZOOM
) -> tuple[tuple[tuple[float, float], ...], ...]:
    """The ``roads`` layer's lines whose ``kind`` is one of ``kinds``, read at ``zoom``."""
    pm = PmTiles(Path(path).read_bytes())
    h = pm.header
    w, s = h["min_lon_e7"] / 1e7, h["min_lat_e7"] / 1e7
    e, n = h["max_lon_e7"] / 1e7, h["max_lat_e7"] / 1e7

    def tx(lon: float) -> int:
        return int((lon + 180.0) / 360.0 * (1 << zoom))

    def ty(lat: float) -> int:
        r = math.radians(lat)
        return int((1 - math.asinh(math.tan(r)) / math.pi) / 2 * (1 << zoom))

    out = []
    for x in range(tx(w), tx(e) + 1):
        for y in range(ty(n), ty(s) + 1):
            t = pm.tile(zoom, x, y)
            if not t:
                continue
            for props, lines, extent in layer_lines(t, "roads"):
                if props.get("kind") not in kinds:
                    continue
                for ln in lines:
                    out.append(tuple(_lonlat(zoom, x, y, px, py, extent) for px, py in ln))
    return tuple(out)


def _seg_dist_m(p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]) -> float:
    """Metres from ``p`` to segment ``ab`` (lon, lat), on a local flat projection at ``p``."""
    kx = 111_320.0 * math.cos(math.radians(p[1]))
    ky = 110_540.0
    ax, ay = (a[0] - p[0]) * kx, (a[1] - p[1]) * ky
    bx, by = (b[0] - p[0]) * kx, (b[1] - p[1]) * ky
    dx, dy = bx - ax, by - ay
    L = dx * dx + dy * dy
    t = 0.0 if L == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / L))
    return math.hypot(ax + t * dx, ay + t * dy)


def distance_to_road_m(lat: float, lon: float, lines=None) -> float:
    """Metres from the point to the nearest road (``roads()`` unless ``lines`` is given)."""
    lines = roads() if lines is None else lines
    p = (lon, lat)
    best = math.inf
    for ln in lines:
        for a, b in itertools.pairwise(ln):
            best = min(best, _seg_dist_m(p, a, b))
    return best


def nearest_road_point(lat: float, lon: float, lines=None) -> tuple[float, float, float]:
    """(lat, lon, metres) of the closest point on any road."""
    lines = roads() if lines is None else lines
    kx = 111_320.0 * math.cos(math.radians(lat))
    ky = 110_540.0
    best = (math.inf, lat, lon)
    for ln in lines:
        for a, b in itertools.pairwise(ln):
            ax, ay = (a[0] - lon) * kx, (a[1] - lat) * ky
            bx, by = (b[0] - lon) * kx, (b[1] - lat) * ky
            dx, dy = bx - ax, by - ay
            L = dx * dx + dy * dy
            t = 0.0 if L == 0 else max(0.0, min(1.0, -(ax * dx + ay * dy) / L))
            qx, qy = ax + t * dx, ay + t * dy
            d = math.hypot(qx, qy)
            if d < best[0]:
                best = (d, lat + qy / ky, lon + qx / kx)
    return best[1], best[2], best[0]


def distances_m(lats, lons, lines=None):
    """``distance_to_road_m`` for many points at once (numpy arrays in, metres out)."""
    import numpy as np

    lines = roads() if lines is None else lines
    lat = np.asarray(lats, dtype=float)
    lon = np.asarray(lons, dtype=float)
    kx = 111_320.0 * np.cos(np.radians(lat))
    ky = 110_540.0
    best = np.full(lat.shape, np.inf)
    for ln in lines:
        for a, b in itertools.pairwise(ln):
            ax, ay = (a[0] - lon) * kx, (a[1] - lat) * ky
            bx, by = (b[0] - lon) * kx, (b[1] - lat) * ky
            dx, dy = bx - ax, by - ay
            L = dx * dx + dy * dy
            t = np.where(L == 0, 0.0, np.clip(-(ax * dx + ay * dy) / np.where(L == 0, 1, L), 0, 1))
            best = np.minimum(best, np.hypot(ax + t * dx, ay + t * dy))
    return best
