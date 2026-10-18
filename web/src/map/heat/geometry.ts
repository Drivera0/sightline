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
 * The fixed top of the heat scale: the highest per-cell probability of the prior (before the flight).
 * The same for every replay step, so a cell's shade changes only when its own probability does.
 */
export function heatScaleMax(prior: ArrayLike<number>): number {
  let max = 0;
  for (let i = 0; i < prior.length; i++) max = Math.max(max, prior[i] as number);
  return max;
}

/**
 * Heat level per cell in [0, 1] on a fixed scale: p / scaleMax (heatScaleMax), clamped. Photographed
 * cells that are not held get a level; the rest 0. Unlike relativeHeatLevels the scale does not move
 * with the replay step or with which cells are photographed, so the darkest class always means "about
 * as likely as the likeliest cell before the flight" and a pale cell is one the photos made unlikely.
 * Demo cache (placeholder uniform prior), photographed cells at the end of the flight: p / scaleMax is
 * 0.11 at the 5th percentile, 0.45 at the median, 1.03 at the 95th (renormalisation lifts p slightly).
 */
export function fixedHeatLevels(p: Float64Array, covered: Uint8Array, scaleMax: number, held?: Uint8Array): Float64Array {
  const out = new Float64Array(p.length);
  if (!(scaleMax > 0)) return out;
  for (let i = 0; i < p.length; i++) {
    if (covered[i] === 1 && held?.[i] !== 1) out[i] = Math.min(1, Math.max(0, (p[i] as number) / scaleMax));
  }
  return out;
}

/**
 * Heat level per cell in [0, 1], relative to the photographed cells only (no longer drawn: the map
 * uses fixedHeatLevels; kept for relativeHeatOpacities).
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
  // One pass keeping the best n in order (n is small), instead of sorting every cell: the same
  // result, run on every replay commit over 40,000 cells.
  const top: number[] = [];
  if (n <= 0) return top;
  for (let i = 0; i < p.length; i++) {
    if (only !== undefined && only[i] !== 1) continue;
    const v = p[i] as number;
    // Scanning in index order, a tie never displaces an earlier (lower) index.
    if (top.length === n && !(v > (p[top[n - 1] as number] as number))) continue;
    let at = top.length;
    while (at > 0 && v > (p[top[at - 1] as number] as number)) at--;
    top.splice(at, 0, i);
    if (top.length > n) top.pop();
  }
  return top;
}

/** Cells within 5% of the likeliest eligible cell form the candidate search patches. */
export const LIKELY_PATCH_RATIO = 0.95;
/** The panel and map show at most five patches; the remainder is reported separately. */
export const MAX_LIKELY_PATCHES = 5;

export interface LikelyPatch {
  /** Stable identity for this replay state: the lowest grid index in the connected component. */
  id: number;
  cells: number[];
  centroid: { lat: number; lon: number };
  probability: number;
  /** Patch probability divided by probability over all eligible surveyed cells. */
  share: number;
  /** Mean patch-cell probability divided by the mean over eligible surveyed cells. */
  density: number;
  areaHa: number;
  canopy: number | null;
  sectorIndex: number | null;
}

export interface LikelyPatchResult {
  patches: LikelyPatch[];
  surveyedProbability: number;
  meanProbability: number;
  /** Probability share outside the displayed patches, so displayed shares total exactly one. */
  otherShare: number;
}

interface LikelyPatchOptions {
  canopy?: readonly (number | null)[];
  cellSector?: Int16Array;
  thresholdRatio?: number;
  maxPatches?: number;
}

/** Return the valid 8-connected neighbours of a grid cell in deterministic index order. */
function neighbours8(grid: Grid, idx: number): number[] {
  const row = Math.floor(idx / grid.cols);
  const col = idx % grid.cols;
  const neighbours: number[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const r = row + dr;
      const c = col + dc;
      if (r >= 0 && r < grid.rows && c >= 0 && c < grid.cols) neighbours.push(r * grid.cols + c);
    }
  }
  return neighbours.sort((a, b) => a - b);
}

/** Summarise one connected component as a field-search patch. */
function summarisePatch(
  grid: Grid,
  cells: number[],
  p: Float64Array,
  surveyedProbability: number,
  meanProbability: number,
  options: LikelyPatchOptions,
): LikelyPatch {
  let probability = 0;
  let weightedLat = 0;
  let weightedLon = 0;
  let canopySum = 0;
  let canopyWeight = 0;
  const sectorProbability = new Map<number, number>();
  for (const idx of cells) {
    const weight = p[idx] as number;
    const center = cellCenter(grid, idx);
    probability += weight;
    weightedLat += center.lat * weight;
    weightedLon += center.lon * weight;
    const canopy = options.canopy?.[idx];
    if (canopy !== null && canopy !== undefined) {
      canopySum += canopy * weight;
      canopyWeight += weight;
    }
    const sector = options.cellSector?.[idx];
    if (sector !== undefined && sector >= 0) sectorProbability.set(sector, (sectorProbability.get(sector) ?? 0) + weight);
  }
  const sectorIndex = [...sectorProbability].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
  return {
    id: cells[0] as number,
    cells,
    centroid: {
      lat: probability > 0 ? weightedLat / probability : cellCenter(grid, cells[0] as number).lat,
      lon: probability > 0 ? weightedLon / probability : cellCenter(grid, cells[0] as number).lon,
    },
    probability,
    share: surveyedProbability > 0 ? probability / surveyedProbability : 0,
    density: meanProbability > 0 ? probability / cells.length / meanProbability : 0,
    areaHa: (cells.length * grid.cell_m * grid.cell_m) / 10_000,
    canopy: canopyWeight > 0 ? canopySum / canopyWeight : null,
    sectorIndex,
  };
}

/**
 * Group the likeliest eligible surveyed cells into 8-connected patches.
 *
 * A cell qualifies when its probability is at least 95% of the highest eligible probability. This
 * relative rule keeps genuinely tied ground together instead of inventing an order between nearly
 * identical cells. Patch shares use every eligible cell as the denominator; cells outside the five
 * displayed patches are returned as `otherShare`, keeping the visible arithmetic honest.
 */
export function likelyPatches(
  grid: Grid,
  p: Float64Array,
  eligible: Uint8Array,
  options: LikelyPatchOptions = {},
): LikelyPatchResult {
  const n = Math.min(grid.rows * grid.cols, p.length, eligible.length);
  let surveyedProbability = 0;
  let eligibleCount = 0;
  let highest = 0;
  for (let idx = 0; idx < n; idx++) {
    if (eligible[idx] !== 1) continue;
    const probability = p[idx] as number;
    surveyedProbability += probability;
    eligibleCount++;
    highest = Math.max(highest, probability);
  }
  const meanProbability = eligibleCount > 0 ? surveyedProbability / eligibleCount : 0;
  if (!(highest > 0) || !(surveyedProbability > 0)) return { patches: [], surveyedProbability, meanProbability, otherShare: 0 };

  const ratio = Math.min(1, Math.max(0, options.thresholdRatio ?? LIKELY_PATCH_RATIO));
  const selected = new Uint8Array(n);
  for (let idx = 0; idx < n; idx++) {
    if (eligible[idx] === 1 && (p[idx] as number) >= highest * ratio) selected[idx] = 1;
  }

  const visited = new Uint8Array(n);
  const components: number[][] = [];
  for (let start = 0; start < n; start++) {
    if (selected[start] !== 1 || visited[start] === 1) continue;
    const cells: number[] = [];
    const queue = [start];
    visited[start] = 1;
    for (let at = 0; at < queue.length; at++) {
      const idx = queue[at] as number;
      cells.push(idx);
      for (const next of neighbours8(grid, idx)) {
        if (next < n && selected[next] === 1 && visited[next] !== 1) {
          visited[next] = 1;
          queue.push(next);
        }
      }
    }
    cells.sort((a, b) => a - b);
    components.push(cells);
  }

  const maxPatches = Math.max(0, Math.floor(options.maxPatches ?? MAX_LIKELY_PATCHES));
  const patches = components
    .map((cells) => summarisePatch(grid, cells, p, surveyedProbability, meanProbability, options))
    .sort((a, b) => b.probability - a.probability || a.id - b.id)
    .slice(0, maxPatches);
  const shownShare = patches.reduce((sum, patch) => sum + patch.share, 0);
  return { patches, surveyedProbability, meanProbability, otherShare: Math.max(0, 1 - shownShare) };
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
  const p = state.p;
  for (let i = 0; i < p.length; i++) {
    if (covered[i] === 1) surveyed += p[i] as number;
    else rest += p[i] as number;
  }
  const total = surveyed + rest + state.outside;
  if (!(total > 0)) return { surveyed: 0, restOfGrid: 0, outside: 0 };
  return { surveyed: surveyed / total, restOfGrid: rest / total, outside: state.outside / total };
}
