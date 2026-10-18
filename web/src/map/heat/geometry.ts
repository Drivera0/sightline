// Pure grid geometry and panel maths for lane C's heat layer (contract §8 conventions).
// Row 0 = north, column 0 = west, idx = row * cols + col, polygons are [lon, lat].
import type { MapFile } from "../../contract";
import type { MapState } from "../../search/update";

type Grid = MapFile["grid"];
type LonLat = [number, number];

const M_PER_DEG_LAT = 111_320;
const DEG_TO_RAD = Math.PI / 180;

/** Highest heat opacity, for the most likely cell. */
export const MAX_OPACITY = 0.75;
/** Cells below this fraction of the most likely cell are fully transparent. */
export const MIN_SHARE_OF_MAX = 0.02;
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

/** Heat opacity for a cell: 0 … MAX_OPACITY in proportion to p / max, 0 below 2% of the max. */
export function heatOpacity(p: number, maxP: number): number {
  if (!(maxP > 0)) return 0;
  const share = p / maxP;
  return share < MIN_SHARE_OF_MAX ? 0 : MAX_OPACITY * Math.min(1, share);
}

export function maxOf(values: Float64Array): number {
  let max = 0;
  for (const v of values) if (v > max) max = v;
  return max;
}

/** Ground distance in metres, local equirectangular (fine at 1 km scale). */
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dy = (lat2 - lat1) * M_PER_DEG_LAT;
  const dx = (lon2 - lon1) * M_PER_DEG_LAT * Math.cos(((lat1 + lat2) / 2) * DEG_TO_RAD);
  return Math.hypot(dx, dy);
}

/** Indices of the n most likely cells, most likely first (ties: lower idx first). */
export function topCellIndices(p: Float64Array, n: number): number[] {
  const idx = Array.from(p.keys());
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
