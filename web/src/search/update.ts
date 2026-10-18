// TypeScript mirror of sightline/search/update.py and grid.cells_within_radius (LANE_C_SEARCH §6.5).
// Same math, same operation order. Checked against Python by update.test.ts (1e-9).
import type { MapFile } from "../contract";

type Grid = MapFile["grid"];

export interface MapState {
  p: Float64Array;
  outside: number;
}

const M_PER_DEG_LAT = 111_320;
const DEG_TO_RAD = Math.PI / 180; // same constant as Python's math.radians

/** One look at some cells that found nobody: cells = [idx, pod][]. Never mutates s. */
export function applyStep(s: MapState, cells: [number, number][]): MapState {
  const p = Float64Array.from(s.p);
  if (cells.length === 0) return { p, outside: s.outside };

  let stepped = 0;
  for (const [idx, pod] of cells) {
    if (!(pod >= 0 && pod <= 1)) throw new Error("every pod must be in [0, 1]");
    if (!Number.isInteger(idx) || idx < 0 || idx >= p.length) {
      throw new Error(`cell index ${idx} outside grid of ${p.length} cells`);
    }
    stepped += (p[idx] as number) * pod;
  }
  const denominator = 1 - stepped;
  if (!(denominator > 0)) throw new Error(`update denominator must be > 0, got ${denominator}`);

  for (const [idx, pod] of cells) p[idx] = (p[idx] as number) * (1 - pod);
  for (let i = 0; i < p.length; i++) p[i] = (p[i] as number) / denominator;
  return { p, outside: s.outside / denominator };
}

/** Apply steps[0 .. upTo-1] to prior; upTo is clamped to [0, steps.length]. Never mutates prior. */
export function replay(prior: MapState, steps: { cells: [number, number][] }[], upTo: number): MapState {
  const n = Math.max(0, Math.min(steps.length, Math.floor(upTo)));
  let s: MapState = { p: Float64Array.from(prior.p), outside: prior.outside };
  for (let k = 0; k < n; k++) s = applyStep(s, (steps[k] as { cells: [number, number][] }).cells);
  return s;
}

/**
 * Cells whose square lies within radiusM of (lat, lon), point-to-square distance.
 * Always includes the containing cell when the point is inside the grid; never cells
 * outside the grid. Sorted flat indices. Same rule as Python's cells_within_radius.
 */
export function cellsWithinRadius(grid: Grid, lat: number, lon: number, radiusM: number): number[] {
  if (!(radiusM >= 0)) throw new Error(`radiusM must be >= 0, got ${radiusM}`);
  const mPerDegLon = M_PER_DEG_LAT * Math.cos(grid.origin_nw.lat * DEG_TO_RAD);
  const eastM = (lon - grid.origin_nw.lon) * mPerDegLon;
  const southM = (grid.origin_nw.lat - lat) * M_PER_DEG_LAT;
  const c = grid.cell_m;
  const rowLo = Math.max(0, Math.floor((southM - radiusM) / c));
  const rowHi = Math.min(grid.rows - 1, Math.floor((southM + radiusM) / c));
  const colLo = Math.max(0, Math.floor((eastM - radiusM) / c));
  const colHi = Math.min(grid.cols - 1, Math.floor((eastM + radiusM) / c));

  const found = new Set<number>();
  for (let row = rowLo; row <= rowHi; row++) {
    const dSouthM = Math.max(row * c - southM, 0, southM - (row + 1) * c);
    for (let col = colLo; col <= colHi; col++) {
      const dEastM = Math.max(col * c - eastM, 0, eastM - (col + 1) * c);
      if (Math.hypot(dEastM, dSouthM) <= radiusM) found.add(row * grid.cols + col);
    }
  }

  const homeRow = Math.floor(southM / c);
  const homeCol = Math.floor(eastM / c);
  if (homeRow >= 0 && homeRow < grid.rows && homeCol >= 0 && homeCol < grid.cols) {
    found.add(homeRow * grid.cols + homeCol);
  }
  return [...found].sort((a, b) => a - b);
}

/** A searcher marked a detection "not a person": cells within radiusM get pod = min(reviewPod, podCap). */
export function applyReviewNotPerson(
  s: MapState,
  grid: Grid,
  lat: number,
  lon: number,
  radiusM: number,
  reviewPod: number,
  podCap: number,
): MapState {
  const pod = Math.min(reviewPod, podCap);
  const cells = cellsWithinRadius(grid, lat, lon, radiusM).map((i): [number, number] => [i, pod]);
  return applyStep(s, cells);
}
