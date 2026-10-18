// How much of each grid cell the camera footprints covered (lane C, "Search next" eligibility).
// Works in local metres from the grid's NW corner, with the same formulas as contract §8.
import type { MapFile } from "../../contract";

type Grid = MapFile["grid"];
export type Point = [number, number];
type LonLat = readonly [number, number];

const M_PER_DEG_LAT = 111_320;

/**
 * A cell is "photographed well enough" for "Search next" when the footprints covered at least
 * this much of it, counted in cell areas (1 = the whole cell seen once). 0.5 = half the cell seen once.
 *
 * It is a threshold on overlap, not on pod: dense forest has a low pod because of the canopy, and
 * those are the cells we want to list. Demo cache on the earlier 20 m grid, summed overlap (500 frames, 288 cells with overlap > 0):
 * min 0.055, p10 0.131, median 1.557, p90 1.691, max 1.698. 32 cells are below 0.25 (edge slivers),
 * none lie between 0.25 and 0.5, 31 lie in 0.5 to 0.75 (edge cells, still half seen) and 225 are at
 * 0.75 or more (interior, 1.38 to 1.70). So 0.5 drops every sliver and keeps every interior cell.
 */
export const MIN_OVERLAP = 0.5;

/** [lon, lat] to [east, south] metres from the grid's NW corner (contract §8). */
export function toLocalM(grid: Grid, [lon, lat]: LonLat): Point {
  const { origin_nw } = grid;
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((origin_nw.lat * Math.PI) / 180);
  return [(lon - origin_nw.lon) * mPerDegLon, (origin_nw.lat - lat) * M_PER_DEG_LAT];
}

/** Absolute area of a simple polygon (shoelace). */
export function polygonArea(poly: readonly Point[]): number {
  let twice = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i] as Point;
    const [x2, y2] = poly[(i + 1) % poly.length] as Point;
    twice += x1 * y2 - x2 * y1;
  }
  return Math.abs(twice) / 2;
}

/** Keep the part of `poly` where `inside` holds; `cut` finds the edge crossing (Sutherland–Hodgman). */
function clipHalfPlane(
  poly: readonly Point[],
  inside: (p: Point) => boolean,
  cut: (a: Point, b: Point) => Point,
): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i] as Point;
    const b = poly[(i + 1) % poly.length] as Point;
    const aIn = inside(a);
    const bIn = inside(b);
    if (aIn) out.push(a);
    if (aIn !== bIn) out.push(cut(a, b));
  }
  return out;
}

/** Clip a convex polygon to the box [x0, x1] × [y0, y1]. Returns [] when they do not overlap. */
export function clipConvex(poly: readonly Point[], x0: number, y0: number, x1: number, y1: number): Point[] {
  const atX = (x: number) => (a: Point, b: Point): Point => [x, a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])];
  const atY = (y: number) => (a: Point, b: Point): Point => [a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]), y];
  let out: Point[] = [...poly];
  out = clipHalfPlane(out, (p) => p[0] >= x0, atX(x0));
  out = clipHalfPlane(out, (p) => p[0] <= x1, atX(x1));
  out = clipHalfPlane(out, (p) => p[1] >= y0, atY(y0));
  out = clipHalfPlane(out, (p) => p[1] <= y1, atY(y1));
  return out;
}

/**
 * For each cell: the sum over frames of area(cell ∩ footprint) / cell area. Index = row * cols + col.
 * Only the cells inside each footprint's bounding window are tested.
 */
export function summedOverlap(grid: Grid, footprints: readonly (readonly LonLat[])[]): Float64Array {
  const { rows, cols, cell_m } = grid;
  const out = new Float64Array(rows * cols);
  const cellArea = cell_m * cell_m;
  for (const fp of footprints) {
    const poly = fp.map((c) => toLocalM(grid, c));
    if (poly.length < 3) continue;
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    const colLo = Math.max(0, Math.floor(Math.min(...xs) / cell_m));
    const colHi = Math.min(cols - 1, Math.floor(Math.max(...xs) / cell_m));
    const rowLo = Math.max(0, Math.floor(Math.min(...ys) / cell_m));
    const rowHi = Math.min(rows - 1, Math.floor(Math.max(...ys) / cell_m));
    for (let row = rowLo; row <= rowHi; row++) {
      for (let col = colLo; col <= colHi; col++) {
        const clipped = clipConvex(poly, col * cell_m, row * cell_m, (col + 1) * cell_m, (row + 1) * cell_m);
        if (clipped.length >= 3) {
          out[row * cols + col] = (out[row * cols + col] as number) + polygonArea(clipped) / cellArea;
        }
      }
    }
  }
  return out;
}

/**
 * Per frame, the cells its footprint touches as [idx, overlap] (overlap in cell areas). Flight order.
 * Only each footprint's bounding window is read, so this stays cheap on fine grids (40,000 cells).
 */
export function frameOverlaps(grid: Grid, footprints: readonly (readonly LonLat[])[]): [number, number][][] {
  const scratch = new Float64Array(grid.rows * grid.cols);
  return footprints.map((fp) => {
    const cells: [number, number][] = [];
    const touched = summedInto(scratch, grid, fp);
    for (const idx of touched) {
      const v = scratch[idx] as number;
      if (v > 0) cells.push([idx, v]);
      scratch[idx] = 0;
    }
    return cells;
  });
}

/** Add one footprint's overlaps into `out`; returns the visited cell indices in row-major order. */
function summedInto(out: Float64Array, grid: Grid, fp: readonly LonLat[]): number[] {
  const { rows, cols, cell_m } = grid;
  const visited: number[] = [];
  const poly = fp.map((c) => toLocalM(grid, c));
  if (poly.length < 3) return visited;
  const cellArea = cell_m * cell_m;
  const xs = poly.map((p) => p[0]);
  const ys = poly.map((p) => p[1]);
  const colLo = Math.max(0, Math.floor(Math.min(...xs) / cell_m));
  const colHi = Math.min(cols - 1, Math.floor(Math.max(...xs) / cell_m));
  const rowLo = Math.max(0, Math.floor(Math.min(...ys) / cell_m));
  const rowHi = Math.min(rows - 1, Math.floor(Math.max(...ys) / cell_m));
  for (let row = rowLo; row <= rowHi; row++) {
    for (let col = colLo; col <= colHi; col++) {
      const clipped = clipConvex(poly, col * cell_m, row * cell_m, (col + 1) * cell_m, (row + 1) * cell_m);
      const idx = row * cols + col;
      visited.push(idx);
      if (clipped.length >= 3) out[idx] = (out[idx] as number) + polygonArea(clipped) / cellArea;
    }
  }
  return visited;
}

/** Save the running total every this many frames, so scrubbing adds at most CHECKPOINT_EVERY - 1 frames. */
const CHECKPOINT_EVERY = 25;

/**
 * How the frames' overlaps add up per cell. "sum": total looks in cell areas (two photos of the
 * whole cell = 2). "max": the largest share of the cell inside any one photo, the cell's coverage.
 *
 * The heat map and Search next use "max". With "sum", an edge cell that two overlapping photos each
 * cut at about 30 % counted 0.6 although only the same 30 % of it was ever seen, which drew a fringe
 * of single photographed cells at every seam along the survey's edge (demo cache: 68 cells, summed
 * 0.50 to 0.62, none above 0.5 in any one photo). Where photos overlap, one of them holds the whole
 * cell, so interior cells and real edge cells (at least half inside one photo) are unchanged.
 */
export type OverlapCombine = "sum" | "max";

export interface OverlapIndex {
  frames: readonly (readonly [number, number][])[];
  combine: OverlapCombine;
  /** checkpoints[i] = summed overlap of frames 0 .. i * CHECKPOINT_EVERY - 1. */
  checkpoints: Float64Array[];
  cellCount: number;
}

const add = (combine: OverlapCombine) =>
  combine === "max" ? (a: number, b: number) => Math.max(a, b) : (a: number, b: number) => a + b;

/** Precompute once per survey. */
export function buildOverlapIndex(
  frames: readonly (readonly [number, number][])[],
  cellCount: number,
  combine: OverlapCombine = "sum",
): OverlapIndex {
  const op = add(combine);
  const checkpoints = [new Float64Array(cellCount)];
  let running = new Float64Array(cellCount);
  frames.forEach((cells, k) => {
    for (const [idx, v] of cells) running[idx] = op(running[idx] as number, v);
    if ((k + 1) % CHECKPOINT_EVERY === 0) {
      checkpoints.push(running);
      running = Float64Array.from(running);
    }
  });
  return { frames, combine, checkpoints, cellCount };
}

/**
 * Overlap of frames 0 .. k-1 (k is clamped to 0 .. frames), combined by the index's rule. Returns a
 * new array. Frames are added in flight order, so for "sum" at k = frames.length it equals
 * summedOverlap() over all footprints.
 */
export function overlapAtStep(index: OverlapIndex, k: number): Float64Array {
  const n = Math.max(0, Math.min(index.frames.length, Math.floor(k)));
  const base = Math.floor(n / CHECKPOINT_EVERY);
  const out = Float64Array.from(index.checkpoints[base] as Float64Array);
  const op = add(index.combine);
  for (let f = base * CHECKPOINT_EVERY; f < n; f++) {
    for (const [idx, v] of index.frames[f] as readonly [number, number][]) out[idx] = op(out[idx] as number, v);
  }
  return out;
}

/**
 * 1 where the cell counts as photographed for the heat map: summed overlap >= MIN_OVERLAP, the same
 * rule as "Search next". Slivers the footprints only touched (0 < overlap < MIN_OVERLAP) are 0, so they
 * are drawn as "not yet searched" and stay out of the stretch bounds and the surveyed outline.
 */
export function photographedCells(overlap: Float64Array): Uint8Array {
  return Uint8Array.from(overlap, (v) => (v >= MIN_OVERLAP ? 1 : 0));
}

/**
 * Per cell, the number of frames after which it first counts as photographed (summed overlap reaches
 * MIN_OVERLAP), 1-based; 0 for a cell the survey never photographs well enough. The Search next
 * build-up reveals cells in this order, so the heat sweeps in along the flight.
 */
export function firstPhotographedStep(index: OverlapIndex): Int32Array {
  const first = new Int32Array(index.cellCount);
  const running = new Float64Array(index.cellCount);
  const op = add(index.combine);
  index.frames.forEach((cells, k) => {
    for (const [idx, v] of cells) {
      running[idx] = op(running[idx] as number, v);
      if (first[idx] === 0 && (running[idx] as number) >= MIN_OVERLAP) first[idx] = k + 1;
    }
  });
  return first;
}


/** 1 where "Search next" may rank the cell: summed overlap >= MIN_OVERLAP and not awaiting review. */
export function eligibleCells(overlap: Float64Array, held?: Uint8Array): Uint8Array {
  return Uint8Array.from(overlap, (v, i) => (v >= MIN_OVERLAP && held?.[i] !== 1 ? 1 : 0));
}
