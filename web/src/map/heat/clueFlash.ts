// Cause and effect for a clue: when one is added or confirmed, its pin's circle and the map cells it
// reweighted flash for a moment (the clue's own map update: source "clue", ref = the clue's id).
// Pure helpers; LiveHeatMap draws and fades them. Built by lane A.
import type { Clue, MapBase, MapUpdate } from "../../contract";
import { circlePolygon } from "../base/circle";
import { cellRing } from "./geometry";

/** How long the flash takes to fade (ms). */
export const FLASH_MS = 1800;
/** The circle drawn for a clue with no radius of its own (m). */
const MIN_RADIUS_M = 60;

/** What each clue was last seen as: confirmed or not. */
export type ClueSeen = ReadonlyMap<string, boolean>;

export function seenOf(clues: readonly Clue[]): ClueSeen {
  return new Map(clues.map((c) => [c.id, c.confirmed]));
}

/** The clues to flash: new since `before`, or confirmed since. The first look (no `before`) flashes none. */
export function cluesToFlash(before: ClueSeen | null, clues: readonly Clue[]): Clue[] {
  if (before === null) return [];
  return clues.filter((c) => !before.has(c.id) || (c.confirmed && before.get(c.id) === false));
}

type Feature = { type: "Feature"; properties: Record<string, string | number>; geometry: { type: "Polygon"; coordinates: number[][][] } };

/** The flash for some clues: each one's circle, and the cells its own map update touched. */
export function flashFeatures(base: MapBase, clues: readonly Clue[], updates: readonly MapUpdate[]): Feature[] {
  const out: Feature[] = [];
  for (const c of clues) {
    out.push({ type: "Feature", properties: { kind: "circle", clue: c.id }, geometry: circlePolygon(c.lon, c.lat, Math.max(MIN_RADIUS_M, c.radius_m || 0)) });
    const cells = new Set<number>();
    for (const u of updates) if (u.source === "clue" && u.ref === c.id) for (const [i] of u.cells) cells.add(i);
    for (const i of cells) out.push({ type: "Feature", properties: { kind: "cell", clue: c.id }, geometry: { type: "Polygon", coordinates: [cellRing(base.grid, i)] } });
  }
  return out;
}
