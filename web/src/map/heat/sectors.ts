// Search sectors: the 1 km grid divided into named areas, each with its probability of area (POA),
// how much of it the drone photographed, and a state. Land SAR plans a search by "segments": areas a
// team can cover, each with a POA that sums over the segments, ranked so the most probable unsearched
// segment goes first (Koester, Lost Person Behavior 2008; NASAR Fundamentals of SAR; Frost, The Theory
// of Search, USCG). Everything here is computed in the browser from map.json, survey.json and the
// search store; nothing is stored in the cache.
//
// Two layouts:
// - "flight": when the survey was flown as east–west lines (the demo flight), the photographed
//   rectangle is cut into sectors of LINES_PER_SECTOR consecutive flight lines, numbered 1, 2, ... in
//   flight order, so "the drone finished sector 2 and moved to sector 3" is literally true. In the
//   demo's blocks layout one sector is one flight block (4 lines = one row of 4000 px photos, see
//   BLOCK_LINES in sightline/pipeline/survey.py). The rest of the grid becomes four outer sectors
//   N, E, S and W around it.
// - "lattice": otherwise, a 4 × 4 map-reference lattice: columns A–D west to east, rows 1–4 north
//   to south (A1 is the north-west corner), 250 m on the 1 km grid.
// A cell belongs to the sector that contains its centre, so the sums work at any cell size.
import type { MapFile } from "../../contract";
import type { MapState } from "../../search/update";
import { toLocalM } from "./coverage";
import { edgeLat, edgeLon } from "./geometry";

type Grid = MapFile["grid"];
type LonLat = [number, number];

/** Flight lines per sector in the "flight" layout (one flight block of the demo's blocks layout). */
export const LINES_PER_SECTOR = 4;
/** Frames whose pose differs by less than this north–south are on the same east–west flight line. */
export const LINE_TOLERANCE_M = 3;
/** A sector counts as "searched by drone" when at least this share of its cells is photographed. */
export const SEARCHED_COVERAGE = 0.9;
/** Below this share a sector counts as "not yet searched" (edge slivers of a neighbouring flight). */
export const STARTED_COVERAGE = 0.02;
export const LATTICE_SIZE = 4;

export type SectorState = "searched" | "in_progress" | "not_searched";
export const SECTOR_STATE_LABEL: Record<SectorState, string> = {
  searched: "Searched by drone",
  in_progress: "In progress",
  not_searched: "Not yet searched",
};

export interface Sector {
  id: string;
  /** Short label drawn on the map ("1", "N", "B3"). */
  label: string;
  kind: "flight" | "outer" | "lattice";
  /** Rectangle in local metres from the grid's NW corner (east, south). Outer sectors may be bands. */
  rect: { west: number; east: number; north: number; south: number };
  /** Flight steps (1-based, inclusive) of the frames in this sector; flight sectors only. */
  steps?: [number, number];
}

export interface SectorLayout {
  kind: "flight" | "lattice";
  sectors: Sector[];
  /** Per cell, the index into `sectors` (every cell belongs to exactly one sector). */
  cellSector: Int16Array;
}

export interface SurveyFrameLike {
  pose: { lat: number; lon: number };
  footprint: readonly (readonly [number, number])[];
}

interface Line {
  first: number;
  last: number;
  south: number;
}

/** Group consecutive frames (flight order) into east–west lines; null when the flight is not such lines. */
export function flightLines(grid: Grid, frames: readonly SurveyFrameLike[]): Line[] | null {
  if (frames.length < LINES_PER_SECTOR * 2) return null;
  const lines: Line[] = [];
  let start = 0;
  let startSouth = toLocalM(grid, [frames[0]!.pose.lon, frames[0]!.pose.lat])[1];
  for (let i = 1; i <= frames.length; i++) {
    const south = i < frames.length ? toLocalM(grid, [frames[i]!.pose.lon, frames[i]!.pose.lat])[1] : Number.NaN;
    if (!(Math.abs(south - startSouth) < LINE_TOLERANCE_M)) {
      lines.push({ first: start, last: i - 1, south: startSouth });
      start = i;
      startSouth = south;
    }
  }
  // Real east–west lines: several frames each, spread east–west more than north–south, and stepping
  // steadily north or south from one line to the next.
  if (lines.length < LINES_PER_SECTOR || lines.some((l) => l.last - l.first < 2)) return null;
  for (const l of lines) {
    const xs = [];
    for (let i = l.first; i <= l.last; i++) xs.push(toLocalM(grid, [frames[i]!.pose.lon, frames[i]!.pose.lat])[0]);
    if (Math.max(...xs) - Math.min(...xs) < 2 * LINE_TOLERANCE_M) return null;
  }
  const dir = Math.sign(lines[1]!.south - lines[0]!.south);
  for (let k = 1; k < lines.length; k++) if (Math.sign(lines[k]!.south - lines[k - 1]!.south) !== dir || dir === 0) return null;
  return lines;
}

function footprintBounds(grid: Grid, frames: readonly SurveyFrameLike[], first: number, last: number) {
  let west = Infinity;
  let east = -Infinity;
  let north = Infinity;
  let south = -Infinity;
  for (let i = first; i <= last; i++) {
    for (const c of frames[i]!.footprint) {
      const [x, y] = toLocalM(grid, c as LonLat);
      west = Math.min(west, x);
      east = Math.max(east, x);
      north = Math.min(north, y);
      south = Math.max(south, y);
    }
  }
  return { west, east, north, south };
}

const clampTo = (v: number, size: number) => Math.min(size, Math.max(0, v));

/** Sectors for this survey: flight blocks when the flight is east–west lines, else the 4 × 4 lattice. */
export function buildSectors(grid: Grid, frames: readonly SurveyFrameLike[]): SectorLayout {
  const widthM = grid.cols * grid.cell_m;
  const heightM = grid.rows * grid.cell_m;
  const lines = flightLines(grid, frames);
  const sectors: Sector[] = [];
  let kind: SectorLayout["kind"] = "lattice";
  if (lines) {
    const all = footprintBounds(grid, frames, 0, frames.length - 1);
    const west = clampTo(all.west, widthM);
    const east = clampTo(all.east, widthM);
    const groups: Line[][] = [];
    for (let k = 0; k < lines.length; k += LINES_PER_SECTOR) groups.push(lines.slice(k, k + LINES_PER_SECTOR));
    const bounds = groups.map((g) => footprintBounds(grid, frames, g[0]!.first, g.at(-1)!.last));
    // Order north to south for the shared edges, keep flight order for the numbers.
    const order = bounds.map((_, i) => i).sort((a, b) => bounds[a]!.north - bounds[b]!.north);
    const edges: number[] = [clampTo(bounds[order[0]!]!.north, heightM)];
    for (let k = 1; k < order.length; k++) {
      const above = bounds[order[k - 1]!]!;
      const below = bounds[order[k]!]!;
      edges.push(clampTo((above.south + below.north) / 2, heightM));
    }
    edges.push(clampTo(bounds[order.at(-1)!]!.south, heightM));
    const rectOf = new Map<number, Sector["rect"]>();
    order.forEach((g, k) => rectOf.set(g, { west, east, north: edges[k]!, south: edges[k + 1]! }));
    if (west < east && edges[0]! < edges.at(-1)!) {
      kind = "flight";
      groups.forEach((g, i) => {
        sectors.push({
          id: `S${i + 1}`,
          label: String(i + 1),
          kind: "flight",
          rect: rectOf.get(i)!,
          steps: [g[0]!.first + 1, g.at(-1)!.last + 1],
        });
      });
      const top = edges[0]!;
      const bottom = edges.at(-1)!;
      const outer: Sector[] = [
        { id: "N", label: "N", kind: "outer", rect: { west: 0, east: widthM, north: 0, south: top } },
        { id: "E", label: "E", kind: "outer", rect: { west: east, east: widthM, north: top, south: bottom } },
        { id: "S", label: "S", kind: "outer", rect: { west: 0, east: widthM, north: bottom, south: heightM } },
        { id: "W", label: "W", kind: "outer", rect: { west: 0, east: west, north: top, south: bottom } },
      ];
      for (const s of outer) if (s.rect.east - s.rect.west > 0 && s.rect.south - s.rect.north > 0) sectors.push(s);
    }
  }
  if (kind === "lattice") {
    for (let r = 0; r < LATTICE_SIZE; r++) {
      for (let c = 0; c < LATTICE_SIZE; c++) {
        const label = `${String.fromCharCode(65 + c)}${r + 1}`;
        sectors.push({
          id: label,
          label,
          kind: "lattice",
          rect: {
            west: (c * widthM) / LATTICE_SIZE,
            east: ((c + 1) * widthM) / LATTICE_SIZE,
            north: (r * heightM) / LATTICE_SIZE,
            south: ((r + 1) * heightM) / LATTICE_SIZE,
          },
        });
      }
    }
  }
  return { kind, sectors, cellSector: assignCells(grid, sectors) };
}

/** Index of the sector containing each cell centre (first match; edges go to the sector east/south). */
export function assignCells(grid: Grid, sectors: readonly Sector[]): Int16Array {
  const out = new Int16Array(grid.rows * grid.cols).fill(-1);
  for (let row = 0; row < grid.rows; row++) {
    const y = (row + 0.5) * grid.cell_m;
    for (let col = 0; col < grid.cols; col++) {
      const x = (col + 0.5) * grid.cell_m;
      const k = sectors.findIndex((s) => x >= s.rect.west && x < s.rect.east && y >= s.rect.north && y < s.rect.south);
      out[row * grid.cols + col] = k;
    }
  }
  // A centre exactly on the far grid edge cannot happen (centres are inside), but keep every cell owned.
  for (let i = 0; i < out.length; i++) if (out[i] === -1) out[i] = 0;
  return out;
}

export interface SectorStatus {
  sector: Sector;
  /** Probability of area: sum of p over the sector's cells (a share of the total, outside included). */
  poa: number;
  /** Share of the sector's cells photographed well enough (covered). */
  coverage: number;
  cells: number;
  state: SectorState;
}

export function sectorState(coverage: number): SectorState {
  if (coverage >= SEARCHED_COVERAGE) return "searched";
  if (coverage >= STARTED_COVERAGE) return "in_progress";
  return "not_searched";
}

/** POA, coverage and state of every sector, in layout order. */
export function sectorStatuses(layout: SectorLayout, state: MapState, covered: Uint8Array): SectorStatus[] {
  const n = layout.sectors.length;
  const poa = new Float64Array(n);
  const cells = new Int32Array(n);
  const seen = new Int32Array(n);
  let total = state.outside;
  for (let i = 0; i < state.p.length; i++) total += state.p[i] as number;
  const scale = total > 0 ? 1 / total : 0;
  for (let i = 0; i < layout.cellSector.length; i++) {
    const k = layout.cellSector[i] as number;
    poa[k] = (poa[k] as number) + (state.p[i] as number) * scale;
    cells[k] = (cells[k] as number) + 1;
    if (covered[i] === 1) seen[k] = (seen[k] as number) + 1;
  }
  return layout.sectors.map((sector, k) => {
    const coverage = cells[k]! > 0 ? seen[k]! / cells[k]! : 0;
    return { sector, poa: poa[k]!, coverage, cells: cells[k]!, state: sectorState(coverage) };
  });
}

/** Sectors ranked by POA, most probable first (ties: layout order). */
export function rankSectors(statuses: readonly SectorStatus[]): SectorStatus[] {
  return statuses
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.poa - a.s.poa || a.i - b.i)
    .map(({ s }) => s);
}

/** The flight sector the drone is in after `stepIndex` frames (null before the first, after the last, or for a lattice). */
export function currentSector(layout: SectorLayout, stepIndex: number, stepCount: number): Sector | null {
  if (stepIndex <= 0 || stepIndex >= stepCount) return null;
  return layout.sectors.find((s) => s.steps && stepIndex >= s.steps[0] && stepIndex <= s.steps[1]) ?? null;
}

/** [lon, lat] corners NW, NE, SE, SW, NW of a sector. */
export function sectorRing(grid: Grid, s: Sector): LonLat[] {
  const lon = (x: number) => edgeLon(grid, x / grid.cell_m);
  const lat = (y: number) => edgeLat(grid, y / grid.cell_m);
  const { west, east, north, south } = s.rect;
  return [
    [lon(west), lat(north)],
    [lon(east), lat(north)],
    [lon(east), lat(south)],
    [lon(west), lat(south)],
    [lon(west), lat(north)],
  ];
}

/** [[west, south], [east, north]] in lon/lat, for fitBounds. */
export function sectorBounds(grid: Grid, s: Sector): [[number, number], [number, number]] {
  const ring = sectorRing(grid, s);
  return [ring[3]!, ring[1]!];
}

/** "Sector 2", "Sector N", "Sector B3". */
export function sectorName(s: Sector): string {
  return `Sector ${s.label}`;
}
