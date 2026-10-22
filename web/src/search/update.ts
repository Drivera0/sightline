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
// Float error can put an edge neighbour at 10.0000001 m; this keeps it in a 10 m radius.
const RADIUS_TOLERANCE_M = 1e-6; // same as RADIUS_TOLERANCE_M in grid.py

/** One look at some cells that found nobody: cells = [idx, pod][]. Never mutates s. */
export function applyStep(s: MapState, cells: [number, number][]): MapState {
  const p = new Float64Array(s.p);
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
  let s: MapState = { p: new Float64Array(prior.p), outside: prior.outside };
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
  const reachM = radiusM + RADIUS_TOLERANCE_M;
  const rowLo = Math.max(0, Math.floor((southM - reachM) / c));
  const rowHi = Math.min(grid.rows - 1, Math.floor((southM + reachM) / c));
  const colLo = Math.max(0, Math.floor((eastM - reachM) / c));
  const colHi = Math.min(grid.cols - 1, Math.floor((eastM + reachM) / c));

  const found = new Set<number>();
  for (let row = rowLo; row <= rowHi; row++) {
    const dSouthM = Math.max(row * c - southM, 0, southM - (row + 1) * c);
    for (let col = colLo; col <= colHi; col++) {
      const dEastM = Math.max(col * c - eastM, 0, eastM - (col + 1) * c);
      if (Math.hypot(dEastM, dSouthM) <= reachM) found.add(row * grid.cols + col);
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

/**
 * A searcher marked a detection "Person": undo the "nobody here" evidence its own photo put on the
 * cells within radiusM, as if that photo had not covered them. `step` is that photo's step from
 * map.json (pass null when the replay has not flown it yet: nothing to undo). Each cell's p is divided
 * by (1 − pod) of that step, then the whole map (outside included) is renormalised to 1. Updates
 * commute, so this is exactly the map that every other step and answer give without that photo's look
 * at those cells. Cells held for review have pod 0 in the step and do not change. Never mutates s.
 */
export function applyReviewPerson(
  s: MapState,
  grid: Grid,
  lat: number,
  lon: number,
  radiusM: number,
  step: { cells: [number, number][] } | null,
): MapState {
  const p = new Float64Array(s.p);
  if (!step) return { p, outside: s.outside };
  const inRadius = new Set(cellsWithinRadius(grid, lat, lon, radiusM));
  let changed = false;
  for (const [idx, pod] of step.cells) {
    if (!inRadius.has(idx) || !(pod > 0)) continue;
    if (!(pod < 1)) throw new Error("cannot undo a step with pod 1");
    p[idx] = (p[idx] as number) / (1 - pod);
    changed = true;
  }
  if (!changed) return { p, outside: s.outside };
  let total = s.outside;
  for (let i = 0; i < p.length; i++) total += p[i] as number;
  for (let i = 0; i < p.length; i++) p[i] = (p[i] as number) / total;
  return { p, outside: s.outside / total };
}

/** One candidate area: the union of overlapping sightings' cells (sorted), with their detections. */
export interface CandidateArea {
  detectionIds: string[];
  cells: number[];
}

/**
 * Merge sightings whose cell sets overlap (for example two boxes on one person, or two people side by
 * side) into one candidate area each. Order: by the first sighting of each area in the input order.
 */
export function mergeSightings(sightings: readonly { detectionId: string; cells: readonly number[] }[]): CandidateArea[] {
  const parent = sightings.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i] as number] as number;
      i = parent[i] as number;
    }
    return i;
  };
  const owner = new Map<number, number>();
  sightings.forEach((s, i) => {
    for (const c of s.cells) {
      const j = owner.get(c);
      if (j === undefined) owner.set(c, i);
      else parent[find(i)] = find(j);
    }
  });
  const areas = new Map<number, { detectionIds: string[]; cells: Set<number> }>();
  sightings.forEach((s, i) => {
    const root = find(i);
    let area = areas.get(root);
    if (!area) {
      area = { detectionIds: [], cells: new Set() };
      areas.set(root, area);
    }
    area.detectionIds.push(s.detectionId);
    for (const c of s.cells) area.cells.add(c);
  });
  return [...areas.values()].map((a) => ({ detectionIds: a.detectionIds, cells: [...a.cells].sort((x, y) => x - y) }));
}

export interface CandidateShare extends CandidateArea {
  /** P(S): the area's probability in the map (a share of the total, outside included). */
  poa: number;
  /** P(S) / Σ P(S_j): its chance if the missing person is one of the sightings. 1 with one area. */
  share: number;
}

/**
 * Each area's share of the chance, conditional on "the missing person is one of these sightings":
 * P(S_i) / Σ_j P(S_j) on the given map state (textbook Bayes; nothing is assumed about which case is
 * true). If every area has probability 0, they share equally.
 */
export function candidateShares(s: MapState, areas: readonly CandidateArea[]): CandidateShare[] {
  let total = s.outside;
  for (let i = 0; i < s.p.length; i++) total += s.p[i] as number;
  const poas = areas.map((a) => a.cells.reduce((sum, c) => sum + (s.p[c] as number), 0) / (total > 0 ? total : 1));
  const sum = poas.reduce((a, b) => a + b, 0);
  return areas.map((a, i) => ({
    ...a,
    poa: poas[i] as number,
    share: sum > 0 ? (poas[i] as number) / sum : 1 / areas.length,
  }));
}
