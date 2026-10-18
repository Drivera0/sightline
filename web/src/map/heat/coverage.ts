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
 * those are the cells we want to list. Demo cache (500 frames, 288 cells with overlap > 0):
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
