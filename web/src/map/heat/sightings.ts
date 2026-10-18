// Candidate sightings on the map (LANE_C_SEARCH §3.5). A "Person" answer says someone is there, not
// that it is the missing person (it could be a searcher or another hiker). The map keeps tracking one
// missing person: the heat is the plan "if none of the sightings is them", and each sighting's share
// is its chance if the missing person is one of them (search/update.ts candidateShares). No
// probability is invented for which case is true.
import type { MapFile } from "../../contract";
import type { CandidateShare } from "../../search/update";
import { toLocalM } from "./coverage";

type Grid = MapFile["grid"];

/** 1 for every cell of every candidate area. */
export function candidateMask(cellCount: number, sightings: readonly CandidateShare[]): Uint8Array {
  const mask = new Uint8Array(cellCount);
  for (const s of sightings) for (const c of s.cells) if (c >= 0 && c < cellCount) mask[c] = 1;
  return mask;
}

/** `mask` with the candidate cells cleared (they are drawn as sightings, not as awaiting review). */
export function withoutCandidates(mask: Uint8Array, candidate: Uint8Array): Uint8Array {
  return Uint8Array.from(mask, (v, i) => (v === 1 && candidate[i] !== 1 ? 1 : 0));
}

/** A share as a percentage: whole numbers from 10 %, else two significant digits ("0.021%"). */
export function pctText(x: number): string {
  const v = x * 100;
  if (v >= 10 || v === 0) return `${Math.round(v)}%`;
  return `${Number(v.toPrecision(2))}%`;
}

/** The reading on hover or tap of a sighting's pin or area, and in the found banner. */
export function sightingReading(s: CandidateShare, count: number): string {
  if (count <= 1) return "Candidate sighting · if this is the missing person, the search ends here (100%)";
  return `Candidate sighting · ${pctText(s.share)} of the chance among ${count} sightings`;
}

/** The area's own probability in the map (before it is treated as a sighting). */
export function sightingAreaText(s: CandidateShare): string {
  return `This area held ${pctText(s.poa)} of the map`;
}

/** The candidate area containing grid cell `idx`, if any. */
export function sightingAtCell(sightings: readonly CandidateShare[], idx: number): CandidateShare | undefined {
  return sightings.find((s) => s.cells.includes(idx));
}

/** The area holding a detection. */
export function sightingOf(sightings: readonly CandidateShare[], detectionId: string): CandidateShare | undefined {
  return sightings.find((s) => s.detectionIds.includes(detectionId));
}

/** Grid cell index under [lon, lat], or -1 outside the grid. */
export function cellAt(grid: Grid, lonLat: [number, number]): number {
  const [x, y] = toLocalM(grid, lonLat);
  const col = Math.floor(x / grid.cell_m);
  const row = Math.floor(y / grid.cell_m);
  if (row < 0 || col < 0 || row >= grid.rows || col >= grid.cols) return -1;
  return row * grid.cols + col;
}

/** Ids of the sectors (sectors.ts layout) that contain a candidate cell. */
export function sectorsWithSightings(cellSector: Int16Array, sectorIds: readonly string[], candidate: Uint8Array): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < candidate.length; i++) {
    if (candidate[i] === 1) {
      const id = sectorIds[cellSector[i] as number];
      if (id !== undefined) out.add(id);
    }
  }
  return out;
}
