"""Terrain affinity: where on the ground a lost person tends to be found (LANE_C_SEARCH §3.2).

The Koester rings (``sightline.search.prior``) say how far from the IPP a subject is found; they say
nothing about *where on the ground* at that distance. Find-location studies over ISRID say a good
deal: subjects are found disproportionately on or near trails and streams, and a land subject is
not found in a lake. Canopy is not on this list: Jacobs (2015, §4.6.2) found that "canopy coverage
and land cover were not found to affect PDEN"; canopy lowers the drone's POD (``search.pod``), it
does not move the person.

This module turns the basemap's vector features into a per-cell multiplier over a contract grid,
mean 1 over the grid, which ``prior.koester_prior(..., affinity=...)`` multiplies into the prior.

**Sources** (book vs this module's choices):

- Jacobs, M. (2015). *Terrain Based Probability Models for SAR*. Mountain Rescue Association
  (mra.org/wp-content/uploads/2016/05/TerrainProbabilityModelsReport.pdf). 1455 backcountry ISRID
  incidents in the contiguous US with find coordinates; PDEN = (% of finds matching a criterion) /
  (% of the search area matching it). Figures used here, as printed:
  - Table 1 ("Probability effect of various terrain features", uninjured / injured): roads 3x /
    1.5x, trails 5x / 7x, lakes 2x / 2x (the shore, within 40 m), streams 2x / 3.5x, stream/trail
    interfaces 7x / 12x.
  - §4.2.2: uninjured trail PDEN 8±1 within 20 m, 5.5±0.5 within 40 m. §4.3.2: uninjured stream
    PDEN 2.2±0.3 within 40 m, 1.8±0.2 within 80 m; streams did not spike at narrow offsets.
  - §4.3.4: stream PDEN was similar for on- and off-trail finds (so the two effects multiply).
  - §5.2 finding 4: "Roads, trails and streams should be searched to a maximum track offset of
    approximately 100m".
- Koester, R. (2008). *Lost Person Behavior*, dbS Productions: hikers, 50 % found within a 100 m
  track offset of a linear feature and 95 % within 424 m (as quoted by Jacobs 2015, §4.6.4; the
  book does not say which linear features). Not used as a number here; it agrees with the 100 m
  reach.

**Choices made here (assumptions, not from a source):**

- The multipliers are milder than Jacobs' PDENs (trail 2.0 against 5x, stream 1.5 against 2x): his
  are for narrow bands over whole search areas, mapped trails carry positional error, and the
  basemap's trail set is incomplete. A hedge, chosen by hand, not tuned.
- **Roads do not attract** (the owner's call): Jacobs measures 3x for uninjured subjects near
  roads, but a subject within reach of a road is usually not lost (they walk out or are picked up),
  and the roads ISRID counts are often the search's own. Within 50 m of a road the multiplier is
  0.7, back to 1.0 by 100 m.
- Water bodies 0.2 (a land subject is not found in a lake; not 0, since a drowning is a find in
  water) and cliffs/scree/bare rock 0.3 (rarely the find location; not 0, a fall is a find there):
  both by hand. Jacobs' lake-shore 2x is not applied (the shore is a 40 m band; the basemap does
  not give it apart from the water).
- Kernels multiply (Jacobs §4.3.4: streams act the same on and off trail), so a trail crossing a
  stream gets 2.0 × 1.5 = 3.0, his "stream/trail interface" effect at a milder scale.
"""

from __future__ import annotations

import gzip
import json
import math
import struct
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import shapely

from sightline.contract import Grid, LatLon
from sightline.search.grid import M_PER_DEG_LAT, latlon_to_local_m

JACOBS_2015 = (
    "Jacobs 2015, Terrain Based Probability Models for SAR (MRA; 1455 ISRID backcountry finds)"
)
KOESTER_LPB = "Koester 2008, Lost Person Behavior (track offsets, via Jacobs 2015 §4.6.4)"


@dataclass(frozen=True)
class Kernel:
    """A distance kernel: ``near`` within ``inner_m`` of the feature, linear to 1.0 at ``outer_m``."""

    near: float
    inner_m: float
    outer_m: float
    source: str

    def __call__(self, dist_m: np.ndarray) -> np.ndarray:
        t = np.clip((dist_m - self.inner_m) / (self.outer_m - self.inner_m), 0.0, 1.0)
        return self.near + (1.0 - self.near) * t


# Trails and paths: Jacobs Table 1 trails 5x (uninjured); here 2.0, out to his ~100 m reach (§5.2).
TRAIL = Kernel(2.0, 25.0, 100.0, f"{JACOBS_2015}, Table 1 trails 5x, §5.2 (milder by hand)")
# Streams: Jacobs Table 1 streams 2x; 2.2 at 40 m, 1.8 at 80 m (§4.3.2): a wider, flatter kernel.
STREAM = Kernel(1.5, 40.0, 120.0, f"{JACOBS_2015}, Table 1 streams 2x, §4.3.2 (milder by hand)")
# Roads: neutral to mildly negative near (owner's decision; Jacobs measures 3x, see the docstring).
ROAD = Kernel(0.7, 50.0, 100.0, "by hand: a subject within reach of a road is usually not lost")
WATER_BODY = 0.2  # inside a lake/pond/river polygon (by hand)
CLIFF = 0.3  # inside cliff/scree/bare-rock polygons, or within 10 m of a cliff line (by hand)
CLIFF_LINE_M = 10.0

# Protomaps basemap (v4) kinds: which roads are trails and which water lines are streams.
TRAIL_KINDS = {"path"}
TRAIL_DETAILS = {"path", "footway", "track", "bridleway", "steps", "cycleway", "trail"}
STREAM_KINDS = {"stream", "river", "canal", "drain", "ditch", "brook", "waterway"}
CLIFF_KINDS = {"cliff", "scree", "bare_rock", "rock", "glacier"}


@dataclass
class Features:
    """Linear and area features in lon/lat, by class (each a list of [(lon, lat), ...])."""

    trails: list[list[tuple[float, float]]] = field(default_factory=list)
    roads: list[list[tuple[float, float]]] = field(default_factory=list)
    streams: list[list[tuple[float, float]]] = field(default_factory=list)
    cliff_lines: list[list[tuple[float, float]]] = field(default_factory=list)
    # polygons: a list of rings, first the exterior (even-odd fill, so holes need no orientation)
    water: list[list[list[tuple[float, float]]]] = field(default_factory=list)
    cliffs: list[list[list[tuple[float, float]]]] = field(default_factory=list)

    def counts(self) -> dict[str, int]:
        return {k: len(v) for k, v in self.__dict__.items()}


@dataclass(frozen=True)
class TerrainAffinity:
    """The per-cell multiplier (row-major, mean 1) and the distance to the nearest road per cell."""

    grid: Grid
    multiplier: np.ndarray
    road_distance_m: np.ndarray
    source: str = ""

    def far_from_roads(self, min_road_distance_m: float) -> np.ndarray:
        """Bool per cell: the cell centre is at least ``min_road_distance_m`` from a mapped road."""
        return self.road_distance_m >= float(min_road_distance_m)

    def to_json(self) -> dict:
        return {
            "note": "Terrain affinity for the prior (sightline/geo/terrain_affinity.py): row-major "
            "per-cell multiplier, mean 1 over the grid; road_distance_m per cell (1e9: no road).",
            "grid": self.grid.model_dump(),
            "source": self.source,
            "kernels": kernel_table(),
            "multiplier": [round(float(x), 4) for x in self.multiplier],
            "road_distance_m": [round(min(float(x), 1e9), 1) for x in self.road_distance_m],
        }


def kernel_table() -> dict:
    """The constants, for files and reports."""
    k = {n: {"near": v.near, "inner_m": v.inner_m, "outer_m": v.outer_m, "source": v.source}
         for n, v in (("trail", TRAIL), ("stream", STREAM), ("road", ROAD))}  # fmt: skip
    k["water_body"] = {"inside": WATER_BODY, "source": "by hand"}
    k["cliff"] = {"inside": CLIFF, "line_m": CLIFF_LINE_M, "source": "by hand"}
    return k


def load_affinity(path: str | Path, grid: Grid | None = None) -> TerrainAffinity:
    """Read a file ``to_json`` wrote; with ``grid``, check it is that grid."""
    d = json.loads(Path(path).read_text())
    g = Grid.model_validate(d["grid"])
    if grid is not None and g.model_dump() != grid.model_dump():
        raise ValueError(f"{path}: affinity grid {g.model_dump()} is not {grid.model_dump()}")
    m = np.asarray(d["multiplier"], dtype=np.float64)
    r = np.asarray(d["road_distance_m"], dtype=np.float64)
    if m.size != g.rows * g.cols or r.size != m.size:
        raise ValueError(f"{path}: {m.size} cells, grid has {g.rows * g.cols}")
    return TerrainAffinity(g, m, r, d.get("source", ""))


# --- the raster -------------------------------------------------------------------------------


def _cell_centres(grid: Grid) -> np.ndarray:
    rows, cols = np.divmod(np.arange(grid.rows * grid.cols), grid.cols)
    return np.column_stack(((cols + 0.5) * grid.cell_m, (rows + 0.5) * grid.cell_m))


def _local(grid: Grid, line: Sequence[tuple[float, float]]) -> list[tuple[float, float]]:
    return [latlon_to_local_m(grid, LatLon(lat=lat, lon=lon)) for lon, lat in line]


def _distance(grid: Grid, lines: Iterable[Sequence[tuple[float, float]]], xy: np.ndarray):
    parts = [shapely.LineString(_local(grid, ln)) for ln in lines if len(ln) >= 2]
    if not parts:
        return np.full(len(xy), np.inf)
    return shapely.distance(shapely.MultiLineString(parts), shapely.points(xy))


def _inside(grid: Grid, polys: Iterable[Sequence[Sequence[tuple[float, float]]]], xy: np.ndarray):
    """Even-odd inside test per cell centre, OR-ed over the polygons."""
    out = np.zeros(len(xy), dtype=bool)
    for rings in polys:
        inside = np.zeros(len(xy), dtype=bool)
        for ring in rings:
            if len(ring) < 3:
                continue
            p = np.asarray(_local(grid, ring))
            x0, y0 = p[:, 0], p[:, 1]
            x1, y1 = np.roll(x0, -1), np.roll(y0, -1)
            px, py = xy[:, :1], xy[:, 1:]
            crosses = (y0 > py) != (y1 > py)
            with np.errstate(divide="ignore", invalid="ignore"):
                xc = x0 + (py - y0) * (x1 - x0) / (y1 - y0)
            inside ^= (np.sum(crosses & (px < xc), axis=1) % 2).astype(bool)
        out |= inside
    return out


def affinity_raster(grid: Grid, features: Features, source: str = "") -> TerrainAffinity:
    """The multiplier per cell: trail × stream × road kernels × water × cliff, scaled to mean 1."""
    xy = _cell_centres(grid)
    road_d = _distance(grid, features.roads, xy)
    m = TRAIL(_distance(grid, features.trails, xy)) * STREAM(_distance(grid, features.streams, xy))
    m *= ROAD(road_d)
    m[_inside(grid, features.water, xy)] *= WATER_BODY
    rocky = _inside(grid, features.cliffs, xy) | (
        _distance(grid, features.cliff_lines, xy) <= CLIFF_LINE_M
    )
    m[rocky] *= CLIFF
    return TerrainAffinity(grid, normalise(m), np.asarray(road_d, dtype=np.float64), source)


def normalise(m: np.ndarray) -> np.ndarray:
    """Scale to mean 1 (all ones if the input has no positive mass)."""
    m = np.asarray(m, dtype=np.float64)
    if m.size == 0 or not np.all(np.isfinite(m)) or np.any(m < 0):
        raise ValueError("affinity must be finite and non-negative")
    mean = float(m.mean())
    return m / mean if mean > 0 else np.ones_like(m)


def grid_bbox(grid: Grid, pad_m: float = 150.0) -> tuple[float, float, float, float]:
    """(west, south, east, north) of the grid plus ``pad_m``: features just outside still count."""
    lon_m = M_PER_DEG_LAT * math.cos(math.radians(grid.origin_nw.lat))
    w = grid.origin_nw.lon - pad_m / lon_m
    n = grid.origin_nw.lat + pad_m / M_PER_DEG_LAT
    e = grid.origin_nw.lon + (grid.cols * grid.cell_m + pad_m) / lon_m
    s = grid.origin_nw.lat - (grid.rows * grid.cell_m + pad_m) / M_PER_DEG_LAT
    return w, s, e, n


# --- reading the basemap: PMTiles v3 + Mapbox Vector Tiles, no extra dependency ----------------


def _varint(buf: bytes, i: int) -> tuple[int, int]:
    shift = result = 0
    while True:
        b = buf[i]
        i += 1
        result |= (b & 0x7F) << shift
        if b < 0x80:
            return result, i
        shift += 7


def _fields(buf: bytes):
    """Protobuf wire fields: yields (field number, wire type, value: int or bytes)."""
    i = 0
    while i < len(buf):
        key, i = _varint(buf, i)
        f, wt = key >> 3, key & 7
        if wt == 0:
            v, i = _varint(buf, i)
        elif wt == 1:
            v, i = buf[i : i + 8], i + 8
        elif wt == 2:
            n, i = _varint(buf, i)
            v, i = buf[i : i + n], i + n
        elif wt == 5:
            v, i = buf[i : i + 4], i + 4
        else:
            raise ValueError(f"unsupported protobuf wire type {wt}")
        yield f, wt, v


def _packed(buf: bytes) -> list[int]:
    out, i = [], 0
    while i < len(buf):
        v, i = _varint(buf, i)
        out.append(v)
    return out


def _value(buf: bytes):
    for f, _, v in _fields(buf):
        if f == 1:
            return v.decode()
        if f == 2:
            return struct.unpack("<f", v)[0]
        if f == 3:
            return struct.unpack("<d", v)[0]
        if f in (4, 5):
            return v
        if f == 6:
            return (v >> 1) ^ -(v & 1)
        if f == 7:
            return bool(v)
    return None


def _geometry(cmds: list[int]) -> list[list[tuple[int, int]]]:
    """MVT geometry commands to parts (lines or rings) in tile coordinates."""
    parts: list[list[tuple[int, int]]] = []
    x = y = i = 0
    while i < len(cmds):
        cmd, count = cmds[i] & 7, cmds[i] >> 3
        i += 1
        if cmd == 7:  # ClosePath
            if parts and parts[-1]:
                parts[-1].append(parts[-1][0])
            continue
        for _ in range(count):
            dx, dy = cmds[i], cmds[i + 1]
            i += 2
            x += (dx >> 1) ^ -(dx & 1)
            y += (dy >> 1) ^ -(dy & 1)
            if cmd == 1:
                parts.append([(x, y)])
            else:
                parts[-1].append((x, y))
    return parts


def decode_mvt(data: bytes) -> dict[str, list[tuple[int, dict, list, int]]]:
    """{layer: [(geom type, properties, parts in tile coords, extent)]} for one tile."""
    layers: dict[str, list[tuple[int, dict, list, int]]] = {}
    for f, _, layer in _fields(data):
        if f != 3:
            continue
        name, keys, values, feats, extent = "", [], [], [], 4096
        for lf, _, v in _fields(layer):
            if lf == 1:
                name = v.decode()
            elif lf == 2:
                feats.append(v)
            elif lf == 3:
                keys.append(v.decode())
            elif lf == 4:
                values.append(_value(v))
            elif lf == 5:
                extent = v
        out = []
        for feat in feats:
            gtype, tags, geom = 0, [], []
            for ff, wt, v in _fields(feat):
                if ff == 2:
                    tags = _packed(v) if wt == 2 else [v]
                elif ff == 3:
                    gtype = v
                elif ff == 4:
                    geom = _packed(v)
            props = {keys[tags[j]]: values[tags[j + 1]] for j in range(0, len(tags) - 1, 2)}
            out.append((gtype, props, _geometry(geom), extent))
        layers.setdefault(name, []).extend(out)
    return layers


def zxy_to_tileid(z: int, x: int, y: int) -> int:
    """PMTiles v3 tile id: tiles of lower zooms first, then the Hilbert index at zoom z."""
    acc = ((1 << (2 * z)) - 1) // 3
    tx, ty = x, y
    s = 1 << (z - 1) if z > 0 else 0
    while s > 0:
        rx, ry = 1 if tx & s else 0, 1 if ty & s else 0
        acc += s * s * ((3 * rx) ^ ry)
        if ry == 0:
            if rx == 1:
                tx, ty = s - 1 - tx, s - 1 - ty
            tx, ty = ty, tx
        s >>= 1
    return acc


class PMTiles:
    """A read-only PMTiles v3 archive (local file)."""

    def __init__(self, path: str | Path):
        self.buf = Path(path).read_bytes()
        h = self.buf[:127]
        if h[:7] != b"PMTiles" or h[7] != 3:
            raise ValueError(f"{path}: not a PMTiles v3 archive")
        (self.root_off, self.root_len, _, _, self.leaf_off, _, self.data_off, _, _, _, _) = (
            struct.unpack("<11Q", h[8:96])
        )
        self.internal_gzip = h[97] == 2
        self.tile_gzip = h[98] == 2
        self.min_zoom, self.max_zoom = h[100], h[101]

    def _dir(self, off: int, length: int) -> list[tuple[int, int, int, int]]:
        raw = self.buf[off : off + length]
        raw = gzip.decompress(raw) if self.internal_gzip else raw
        n, i = _varint(raw, 0)
        cols: list[list[int]] = []
        for _ in range(4):
            col = []
            for _ in range(n):
                v, i = _varint(raw, i)
                col.append(v)
            cols.append(col)
        ids, runs, lens, offs = cols
        tid, entries = 0, []
        for k in range(n):
            tid += ids[k]
            o = offs[k] - 1 if offs[k] else entries[-1][3] + entries[-1][2]
            entries.append((tid, runs[k], lens[k], o))
        return entries

    def tile(self, z: int, x: int, y: int) -> bytes | None:
        tid = zxy_to_tileid(z, x, y)
        off, length = self.root_off, self.root_len
        for _ in range(4):
            entries = self._dir(off, length)
            best = None
            for e in entries:
                if e[0] <= tid:
                    best = e
                else:
                    break
            if best is None:
                return None
            if best[1] == 0:  # a leaf directory
                off, length = self.leaf_off + best[3], best[2]
                continue
            if tid >= best[0] + best[1]:
                return None
            raw = self.buf[self.data_off + best[3] : self.data_off + best[3] + best[2]]
            return gzip.decompress(raw) if self.tile_gzip else raw
        return None


def _lonlat_tile(lon: float, lat: float, z: int) -> tuple[float, float]:
    n = 1 << z
    x = (lon + 180.0) / 360.0 * n
    y = (1.0 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2.0 * n
    return x, y


def _tile_lonlat(z: int, x: int, y: int, px: float, py: float, extent: int):
    n = 1 << z
    lon = (x + px / extent) / n * 360.0 - 180.0
    lat = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + py / extent) / n))))
    return lon, lat


def classify(layer: str, gtype: int, props: dict) -> str | None:
    """The class of one basemap feature (Protomaps v4 schema), or None to ignore it."""
    kind = str(props.get("kind", "")).lower()
    detail = str(props.get("kind_detail", "")).lower()
    if layer == "roads" and gtype == 2:
        if kind in TRAIL_KINDS or detail in TRAIL_DETAILS:
            return "trails"
        return "roads" if kind not in ("rail", "ferry", "aerialway") else None
    if layer == "water":
        if gtype == 2 and (kind in STREAM_KINDS or detail in STREAM_KINDS):
            return "streams"
        if gtype == 3:
            return "water"
    rocky = kind in CLIFF_KINDS or detail in CLIFF_KINDS
    if layer in ("landcover", "landuse", "natural", "earth") and rocky:
        return "cliffs" if gtype == 3 else "cliff_lines" if gtype == 2 else None
    return None


def features_from_pmtiles(path: str | Path, bbox: tuple[float, float, float, float]) -> Features:
    """The classed features of the archive's deepest zoom tiles covering ``bbox`` (W, S, E, N)."""
    pm = PMTiles(path)
    z = pm.max_zoom
    w, s, e, n = bbox
    x0, y0 = _lonlat_tile(w, n, z)
    x1, y1 = _lonlat_tile(e, s, z)
    feats = Features()
    for x in range(int(x0), int(x1) + 1):
        for y in range(int(y0), int(y1) + 1):
            data = pm.tile(z, x, y)
            if data is None:
                continue
            for layer, items in decode_mvt(data).items():
                for gtype, props, parts, extent in items:
                    cls = classify(layer, gtype, props)
                    if cls is None:
                        continue
                    ll = [[_tile_lonlat(z, x, y, px, py, extent) for px, py in p] for p in parts]
                    if cls in ("water", "cliffs"):
                        getattr(feats, cls).append(ll)
                    else:
                        getattr(feats, cls).extend(ll)
    return feats


# --- the Overpass fallback (when the archive lacks the layers) ---------------------------------

OVERPASS_QUERY = """[out:json][timeout:60];
(
  way["highway"]({s},{w},{n},{e});
  way["waterway"]({s},{w},{n},{e});
  way["natural"~"^(water|cliff|scree|bare_rock)$"]({s},{w},{n},{e});
);
out geom;"""


def features_from_overpass(doc: dict) -> Features:
    """Classed features from an Overpass ``out geom`` answer (ways only; relations left out)."""
    feats = Features()
    for el in doc.get("elements", []):
        geom = [(p["lon"], p["lat"]) for p in el.get("geometry", [])]
        tags = el.get("tags", {})
        if len(geom) < 2:
            continue
        hw, ww, nat = tags.get("highway"), tags.get("waterway"), tags.get("natural")
        closed = geom[0] == geom[-1] and len(geom) > 3
        if hw:
            (feats.trails if hw in TRAIL_DETAILS else feats.roads).append(geom)
        elif ww in STREAM_KINDS:
            feats.streams.append(geom)
        elif nat == "water" and closed:
            feats.water.append([geom])
        elif nat == "cliff":
            feats.cliff_lines.append(geom)
        elif nat in CLIFF_KINDS and closed:
            feats.cliffs.append([geom])
    return feats
