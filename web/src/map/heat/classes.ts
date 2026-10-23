// The heat as probability-mass classes (highest-density regions), and their shapes for MapLibre.
//
// Each photographed cell gets the class of the smallest set of cells that holds a given share of the
// probability on photographed ground: the likeliest cells that together hold 50 % of it, then the
// next ones up to 80 %, then up to 90 %. Cells outside the 90 % region get no fill, so the basemap
// shows through where little probability is left (Hyndman 1996, "Computing and graphing highest
// density regions"; the 25/50/75/95 % rings of lost-person behaviour, Koester 2008). Equal-interval
// classes on a peaked posterior tint the whole area; mass classes do not.
//
// Pure functions: a Uint8Array of cell kinds (one per cell, row-major, row 0 = north) drives both the
// raster (raster.ts, while it animates) and the GeoJSON fills and contour lines (surface.ts, at rest).
import type { MapFile } from "../../contract";
import { edgeLat, edgeLon } from "./geometry";

type Grid = MapFile["grid"];
type LonLat = [number, number];

/** The cumulative shares of probability that bound the three classes. */
export const MASS_LEVELS = [0.5, 0.8, 0.9] as const;

/** What a cell shows. TOP/MID/LOW are the mass classes, likeliest first. */
export const CELL = {
  /** Photographed, outside the 90 % region: no fill. */
  none: 0,
  /** Inside the likeliest 50 % of the probability. */
  top: 1,
  /** In the 50–80 % band. */
  mid: 2,
  /** In the 80–90 % band. */
  low: 3,
  /** Photographed, awaiting review: a neutral tone, no class (no update yet). */
  held: 4,
  /** Not photographed at this step: the "not yet searched" veil. */
  veil: 5,
  /** The console: ground a search has lowered (photos or a ground team found nobody there): a dark, cool tint. */
  searched: 6,
} as const;
export type CellKind = (typeof CELL)[keyof typeof CELL];
export const CLASS_KINDS = [CELL.top, CELL.mid, CELL.low] as const;
export const FILL_KINDS = [CELL.veil, CELL.held, CELL.searched, CELL.low, CELL.mid, CELL.top] as const;

/**
 * The probability thresholds of the 50 / 80 / 90 % regions over the eligible cells: a cell is in the
 * X % region when its p is at least the X % threshold. Ties never split: cells with the same p as the
 * cell that crosses a level are all inside (a flat area is shaded whole, never cut in an arbitrary
 * place), so a region can hold a little more than its share. null when no eligible cell has mass.
 */
export function massThresholds(p: ArrayLike<number>, eligible: Uint8Array, levels: readonly number[] = MASS_LEVELS): number[] | null {
  let count = 0;
  for (let i = 0; i < p.length; i++) if (eligible[i] === 1 && (p[i] as number) > 0) count++;
  if (count === 0) return null;
  const values = new Float64Array(count);
  let total = 0;
  for (let i = 0, k = 0; i < p.length; i++) {
    const v = p[i] as number;
    if (eligible[i] === 1 && v > 0) {
      values[k++] = v;
      total += v;
    }
  }
  values.sort(); // ascending (typed-array numeric sort); walked from the top
  const out: number[] = [];
  let cum = 0;
  let at = count - 1;
  for (const level of levels) {
    // A hair under the exact share, so a sum that lands on it in floating point does not pull in one
    // more (tied) group of cells.
    const target = level * total * (1 - 1e-12);
    while (at >= 0 && cum < target) cum += values[at--] as number;
    out.push(values[Math.min(count - 1, at + 1)] as number);
  }
  return out;
}

/**
 * The kind of every cell. Eligible for a class: photographed, not awaiting review, not a candidate
 * sighting. A candidate sighting is drawn as the top class (someone is there; no probability is
 * invented for it). Writes into `out` when given.
 */
export function cellKinds(
  p: ArrayLike<number>,
  covered: Uint8Array,
  held: Uint8Array,
  candidate?: Uint8Array | null,
  out = new Uint8Array(p.length),
): Uint8Array {
  const eligible = new Uint8Array(p.length);
  for (let i = 0; i < p.length; i++) {
    if (covered[i] === 1 && held[i] !== 1 && candidate?.[i] !== 1) eligible[i] = 1;
  }
  const t = massThresholds(p, eligible);
  for (let i = 0; i < p.length; i++) {
    const v = p[i] as number;
    if (candidate?.[i] === 1) out[i] = CELL.top;
    else if (covered[i] !== 1) out[i] = CELL.veil;
    else if (held[i] === 1) out[i] = CELL.held;
    else if (!t || !(v > 0)) out[i] = CELL.none;
    else if (v >= (t[0] as number)) out[i] = CELL.top;
    else if (v >= (t[1] as number)) out[i] = CELL.mid;
    else if (v >= (t[2] as number)) out[i] = CELL.low;
    else out[i] = CELL.none;
  }
  return out;
}

/** The share of the eligible probability inside each class (top, mid, low), for tests and readouts. */
export function classShares(p: ArrayLike<number>, kinds: Uint8Array): [number, number, number] {
  let top = 0;
  let mid = 0;
  let low = 0;
  let total = 0;
  for (let i = 0; i < p.length; i++) {
    const k = kinds[i];
    if (k === CELL.veil || k === CELL.held) continue;
    const v = p[i] as number;
    total += v;
    if (k === CELL.top) top += v;
    else if (k === CELL.mid) mid += v;
    else if (k === CELL.low) low += v;
  }
  return total > 0 ? [top / total, mid / total, low / total] : [0, 0, 0];
}

function edges(grid: Grid): { lats: Float64Array; lons: Float64Array } {
  const lats = new Float64Array(grid.rows + 1);
  const lons = new Float64Array(grid.cols + 1);
  for (let r = 0; r <= grid.rows; r++) lats[r] = edgeLat(grid, r);
  for (let c = 0; c <= grid.cols; c++) lons[c] = edgeLon(grid, c);
  return { lats, lons };
}

/**
 * The cells where `inside(kind)` holds, as rectangles: runs along each row, merged down the rows
 * while a run keeps the same columns. Returns polygon rings ([lon, lat], closed) for one MultiPolygon.
 */
export function maskRectangles(grid: Grid, kinds: Uint8Array, inside: (kind: number) => boolean): LonLat[][][] {
  const { lats, lons } = edges(grid);
  const { rows, cols } = grid;
  const out: LonLat[][][] = [];
  // Open rectangles by "c0,c1": the row they started in.
  let open = new Map<number, number>();
  const close = (key: number, r0: number, r1: number) => {
    const c0 = Math.floor(key / (cols + 1));
    const c1 = key % (cols + 1);
    const w = lons[c0] as number;
    const e = lons[c1] as number;
    const n = lats[r0] as number;
    const s = lats[r1] as number;
    out.push([
      [
        [w, n],
        [w, s],
        [e, s],
        [e, n],
        [w, n],
      ],
    ]);
  };
  for (let r = 0; r < rows; r++) {
    const next = new Map<number, number>();
    let c = 0;
    while (c < cols) {
      if (!inside(kinds[r * cols + c] as number)) {
        c++;
        continue;
      }
      const c0 = c;
      while (c < cols && inside(kinds[r * cols + c] as number)) c++;
      const key = c0 * (cols + 1) + c;
      const started = open.get(key);
      next.set(key, started ?? r);
      open.delete(key);
    }
    for (const [key, r0] of open) close(key, r0, r);
    open = next;
  }
  for (const [key, r0] of open) close(key, r0, rows);
  return out;
}

/** 1 where `inside(kind)` holds. */
export function maskOf(kinds: Uint8Array, inside: (kind: number) => boolean): Uint8Array {
  const out = new Uint8Array(kinds.length);
  for (let i = 0; i < kinds.length; i++) if (inside(kinds[i] as number)) out[i] = 1;
  return out;
}

/**
 * A contour's region without the specks: inside parts smaller than `minCells` (8-connected) are
 * dropped and outside holes smaller than it (4-connected, not touching the grid edge) are filled. On a
 * posterior that changes cell to cell (canopy decides how much a photo lowers a cell) the exact edge
 * of a mass region rings every few cells; the line should trace the regions, and the fills under it
 * keep every cell exact.
 */
export function withoutSpecks(grid: Pick<Grid, "rows" | "cols">, mask: Uint8Array, minCells: number): Uint8Array {
  const { rows, cols } = grid;
  const out = Uint8Array.from(mask);
  if (minCells <= 1) return out;
  const seen = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const pass = (value: 0 | 1, diagonal: boolean) => {
    seen.fill(0);
    for (let start = 0; start < out.length; start++) {
      if (out[start] !== value || seen[start]) continue;
      let head = 0;
      let tail = 0;
      let touchesEdge = false;
      queue[tail++] = start;
      seen[start] = 1;
      while (head < tail) {
        const i = queue[head++] as number;
        const r = Math.floor(i / cols);
        const c = i - r * cols;
        if (r === 0 || c === 0 || r === rows - 1 || c === cols - 1) touchesEdge = true;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            if ((dr === 0 && dc === 0) || (!diagonal && dr !== 0 && dc !== 0)) continue;
            const rr = r + dr;
            const cc = c + dc;
            if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
            const j = rr * cols + cc;
            if (out[j] === value && !seen[j]) {
              seen[j] = 1;
              queue[tail++] = j;
            }
          }
        }
      }
      // A small part goes; a hole goes only if it is enclosed (an edge gap is not a hole).
      if (tail < minCells && (value === 1 || !touchesEdge)) {
        for (let k = 0; k < tail; k++) out[queue[k] as number] = value === 1 ? 0 : 1;
      }
    }
  };
  pass(1, true);
  pass(0, false);
  return out;
}

/** Contours leave out parts and holes smaller than this many cells (5 m cells: 0.04 ha). */
export const CONTOUR_MIN_CELLS = 16;

/** One 3 × 3 step of a binary dilation (`grow`) or erosion; cells beyond the grid edge count as outside. */
function morph(grid: Pick<Grid, "rows" | "cols">, mask: Uint8Array, grow: boolean): Uint8Array {
  const { rows, cols } = grid;
  const out = new Uint8Array(mask.length);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let any = false;
      let all = true;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          const v = rr >= 0 && rr < rows && cc >= 0 && cc < cols ? mask[rr * cols + cc] === 1 : !grow && mask[r * cols + c] === 1;
          if (v) any = true;
          else all = false;
        }
      }
      out[r * cols + c] = (grow ? any : all) ? 1 : 0;
    }
  }
  return out;
}

/**
 * A contour's region, generalised for the line: a closing then an opening (3 × 3) smooths away gaps
 * and spurs one cell wide, then parts and holes under `minCells` go (withoutSpecks). The line traces
 * the regions at a glance; the fills under it keep every cell exact.
 */
export function contourMask(grid: Pick<Grid, "rows" | "cols">, mask: Uint8Array, minCells = CONTOUR_MIN_CELLS): Uint8Array {
  const closed = morph(grid, morph(grid, mask, true), false);
  const opened = morph(grid, morph(grid, closed, false), true);
  return withoutSpecks(grid, opened, minCells);
}

/**
 * The boundary of a mask: every cell side with an inside cell on one side and an outside cell (or
 * the grid edge) on the other, joined into straight lines along each grid line, so a dashed line
 * keeps its rhythm. Returns [lon, lat] lines for one MultiLineString.
 */
export function maskBoundary(grid: Grid, mask: Uint8Array): LonLat[][] {
  const { lats, lons } = edges(grid);
  const { rows, cols } = grid;
  const at = (r: number, c: number) => r >= 0 && r < rows && c >= 0 && c < cols && mask[r * cols + c] === 1;
  const lines: LonLat[][] = [];
  // Horizontal lines: the edge above row r (r = rows is the south edge).
  for (let r = 0; r <= rows; r++) {
    let start = -1;
    for (let c = 0; c <= cols; c++) {
      const edge = c < cols && at(r - 1, c) !== at(r, c);
      if (edge && start < 0) start = c;
      if (!edge && start >= 0) {
        lines.push([
          [lons[start] as number, lats[r] as number],
          [lons[c] as number, lats[r] as number],
        ]);
        start = -1;
      }
    }
  }
  // Vertical lines: the edge left of column c.
  for (let c = 0; c <= cols; c++) {
    let start = -1;
    for (let r = 0; r <= rows; r++) {
      const edge = r < rows && at(r, c - 1) !== at(r, c);
      if (edge && start < 0) start = r;
      if (!edge && start >= 0) {
        lines.push([
          [lons[c] as number, lats[start] as number],
          [lons[c] as number, lats[r] as number],
        ]);
        start = -1;
      }
    }
  }
  return lines;
}

export const inTop = (k: number) => k === CELL.top;
export const inNinety = (k: number) => k === CELL.top || k === CELL.mid || k === CELL.low;

type Feature = { type: "Feature"; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } };
export interface SurfaceData {
  fills: { type: "FeatureCollection"; features: Feature[] };
  contours: { type: "FeatureCollection"; features: Feature[] };
}

/**
 * One MultiPolygon per fill kind and one MultiLineString per contour (the 50 % and 90 % edges, each
 * without parts and holes under `minCells`).
 */
export function surfaceData(grid: Grid, kinds: Uint8Array, minCells = CONTOUR_MIN_CELLS): SurfaceData {
  const fills: Feature[] = [];
  for (const kind of FILL_KINDS) {
    const polygons = maskRectangles(grid, kinds, (k) => k === kind);
    if (polygons.length) fills.push({ type: "Feature", properties: { kind }, geometry: { type: "MultiPolygon", coordinates: polygons } });
  }
  const contours: Feature[] = [];
  for (const [level, inside] of [
    [90, inNinety],
    [50, inTop],
  ] as const) {
    const lines = maskBoundary(grid, contourMask(grid, maskOf(kinds, inside), minCells));
    if (lines.length) contours.push({ type: "Feature", properties: { level }, geometry: { type: "MultiLineString", coordinates: lines } });
  }
  return { fills: { type: "FeatureCollection", features: fills }, contours: { type: "FeatureCollection", features: contours } };
}
