// Pure grid geometry and panel maths for lane C's heat layer (contract §8 conventions).
// Row 0 = north, column 0 = west, idx = row * cols + col, polygons are [lon, lat].
import type { MapFile } from "../../contract";
import type { MapState } from "../../search/update";

type Grid = MapFile["grid"];
type LonLat = [number, number];

const M_PER_DEG_LAT = 111_320;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Heat opacity range for photographed cells. The floor keeps seen open ground faintly visible
 * (it was searched and is unlikely, not absent); the ceiling leaves the basemap readable.
 */
export const HEAT_FLOOR = 0.08;
export const HEAT_CEIL = 0.85;
/** Robust bounds of the stretch: the 5th and 95th percentile of p over photographed cells. */
export const STRETCH_LOW_PERCENTILE = 0.05;
export const STRETCH_HIGH_PERCENTILE = 0.95;
/** Canopy at or above this is "dense forest"; below it is "open" (LANE_C_SEARCH §9). */
export const DENSE_CANOPY = 0.5;

function mPerDegLon(grid: Grid): number {
  return M_PER_DEG_LAT * Math.cos(grid.origin_nw.lat * DEG_TO_RAD);
}

/** Latitude of the horizontal edge above `row` (row = rows gives the south edge). */
export function edgeLat(grid: Grid, row: number): number {
  return grid.origin_nw.lat - (row * grid.cell_m) / M_PER_DEG_LAT;
}

/** Longitude of the vertical edge left of `col` (col = cols gives the east edge). */
export function edgeLon(grid: Grid, col: number): number {
  return grid.origin_nw.lon + (col * grid.cell_m) / mPerDegLon(grid);
}

export function cellCenter(grid: Grid, idx: number): { lat: number; lon: number } {
  const row = Math.floor(idx / grid.cols);
  const col = idx % grid.cols;
  return { lat: edgeLat(grid, row + 0.5), lon: edgeLon(grid, col + 0.5) };
}

/** Closed ring NW, NE, SE, SW, NW as [lon, lat]. */
export function cellRing(grid: Grid, idx: number): LonLat[] {
  const row = Math.floor(idx / grid.cols);
  const col = idx % grid.cols;
  const n = edgeLat(grid, row);
  const s = edgeLat(grid, row + 1);
  const w = edgeLon(grid, col);
  const e = edgeLon(grid, col + 1);
  return [
    [w, n],
    [e, n],
    [e, s],
    [w, s],
    [w, n],
  ];
}

export interface CellFeatureCollection {
  type: "FeatureCollection";
  features: {
    type: "Feature";
    properties: { idx: number };
    geometry: { type: "Polygon"; coordinates: LonLat[][] };
  }[];
}

/** Every cell as a polygon with an `idx` property (used as MapLibre's promoteId). Build once per grid. */
export function buildCellFeatures(grid: Grid): CellFeatureCollection {
  const n = grid.rows * grid.cols;
  const features: CellFeatureCollection["features"] = [];
  for (let idx = 0; idx < n; idx++) {
    features.push({
      type: "Feature",
      properties: { idx },
      geometry: { type: "Polygon", coordinates: [cellRing(grid, idx)] },
    });
  }
  return { type: "FeatureCollection", features };
}

/** 1 for each cell that any step covered or that has a canopy value; else 0. */
export function coveredCells(map: Pick<MapFile, "grid" | "steps" | "canopy">): Uint8Array {
  const n = map.grid.rows * map.grid.cols;
  const covered = new Uint8Array(n);
  for (const step of map.steps) {
    for (const [idx] of step.cells) if (idx >= 0 && idx < n) covered[idx] = 1;
  }
  map.canopy.forEach((c, idx) => {
    if (c !== null && idx < n) covered[idx] = 1;
  });
  return covered;
}

/**
 * Boundary of the covered area: every cell side that has a covered cell on one side and an
 * uncovered cell (or the grid edge) on the other. Returns [lon, lat] segments.
 */
export function surveyedBoundary(grid: Grid, covered: Uint8Array): LonLat[][] {
  const { rows, cols } = grid;
  const isCovered = (row: number, col: number) =>
    row >= 0 && row < rows && col >= 0 && col < cols && covered[row * cols + col] === 1;
  const segments: LonLat[][] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      if (!isCovered(row, col)) continue;
      const n = edgeLat(grid, row);
      const s = edgeLat(grid, row + 1);
      const w = edgeLon(grid, col);
      const e = edgeLon(grid, col + 1);
      if (!isCovered(row - 1, col)) segments.push([[w, n], [e, n]]);
      if (!isCovered(row + 1, col)) segments.push([[w, s], [e, s]]);
      if (!isCovered(row, col - 1)) segments.push([[w, n], [w, s]]);
      if (!isCovered(row, col + 1)) segments.push([[e, n], [e, s]]);
    }
  }
  return segments;
}

/** q-th quantile (0…1) of `values` by linear interpolation. NaN for an empty list. */
export function percentile(values: ArrayLike<number>, q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = Array.from(values).sort((a, b) => a - b);
  const pos = Math.min(1, Math.max(0, q)) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo);
}

/**
 * Heat level per cell in [0, 1], relative to the photographed cells only.
 *
 * Unphotographed and held cells get 0 (they are drawn as "not yet searched" / "awaiting review").
 * Photographed cells get a min–max stretch of p between the 5th and 95th percentile of p over
 * photographed cells (values outside are clamped). Why not p / max: unphotographed cells keep the
 * flat prior, so the global max is far above every photographed cell, and all photographed values
 * are tiny and close together. p / max would make them all look the same. Stretching inside the
 * photographed set keeps the forest-versus-open difference visible, and the percentile bounds stop
 * one outlier cell from squashing the rest. If all photographed cells share one p, they get 0.5.
 */
export function relativeHeatLevels(p: Float64Array, covered: Uint8Array, held?: Uint8Array): Float64Array {
  const out = new Float64Array(p.length);
  const shown = (i: number) => covered[i] === 1 && held?.[i] !== 1;
  const seen: number[] = [];
  for (let i = 0; i < p.length; i++) if (shown(i)) seen.push(p[i] as number);
  if (seen.length === 0) return out;
  seen.sort((a, b) => a - b);
  const lo = sortedPercentile(seen, STRETCH_LOW_PERCENTILE);
  const hi = sortedPercentile(seen, STRETCH_HIGH_PERCENTILE);
  const span = hi - lo;
  for (let i = 0; i < p.length; i++) {
    if (!shown(i)) continue;
    out[i] = span > 0 ? Math.min(1, Math.max(0, ((p[i] as number) - lo) / span)) : 0.5;
  }
  return out;
}

function sortedPercentile(sorted: readonly number[], q: number): number {
  const pos = Math.min(1, Math.max(0, q)) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (pos - lo);
}

/**
 * Heat opacity per cell: relativeHeatLevels mapped to HEAT_FLOOR … HEAT_CEIL for photographed
 * cells that are not held; 0 elsewhere.
 */
export function relativeHeatOpacities(p: Float64Array, covered: Uint8Array, held?: Uint8Array): Float64Array {
  const levels = relativeHeatLevels(p, covered, held);
  const out = new Float64Array(p.length);
  for (let i = 0; i < p.length; i++) {
    if (covered[i] === 1 && held?.[i] !== 1) out[i] = HEAT_FLOOR + (levels[i] as number) * (HEAT_CEIL - HEAT_FLOOR);
  }
  return out;
}

/** Ground distance in metres, local equirectangular (fine at 1 km scale). */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dy = (lat2 - lat1) * M_PER_DEG_LAT;
  const dx = (lon2 - lon1) * M_PER_DEG_LAT * Math.cos(((lat1 + lat2) / 2) * DEG_TO_RAD);
  return Math.hypot(dx, dy);
}

/**
 * Indices of the n most likely cells, most likely first (ties: lower idx first). With `only`,
 * just the cells where `only[idx] === 1` are considered.
 */
export function topCellIndices(p: Float64Array, n: number, only?: Uint8Array): number[] {
  const idx = Array.from(p.keys()).filter((i) => only === undefined || only[i] === 1);
  idx.sort((a, b) => (p[b] as number) - (p[a] as number) || a - b);
  return idx.slice(0, n);
}

/** "dense forest" (canopy ≥ 0.5), "open" (< 0.5) or "not photographed" (null). */
export function canopyLabel(canopy: number | null | undefined): string {
  if (canopy === null || canopy === undefined) return "not photographed";
  return canopy >= DENSE_CANOPY ? "dense forest" : "open";
}

export interface Shares {
  surveyed: number;
  restOfGrid: number;
  outside: number;
}

/** Where the probability is, as fractions that sum to 1. */
export function probabilityShares(state: MapState, covered: Uint8Array): Shares {
  let surveyed = 0;
  let rest = 0;
  state.p.forEach((v, i) => {
    if (covered[i] === 1) surveyed += v;
    else rest += v;
  });
  const total = surveyed + rest + state.outside;
  if (!(total > 0)) return { surveyed: 0, restOfGrid: 0, outside: 0 };
  return { surveyed: surveyed / total, restOfGrid: rest / total, outside: state.outside / total };
}
