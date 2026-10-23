// Cause and effect for a clue: when one is added or confirmed, a ring in the clue colour comes up on its pin
// and the cells it reweighted, and fades over two seconds (V3 §2: a ring that fades, not a flash; the clue's
// own map update: source "clue", ref = the clue's id).
// Pure helpers; LiveHeatMap draws and fades them. Built by lane A.
import type { Clue, MapBase, MapUpdate } from "../../contract";
import { circlePolygon } from "../base/circle";
import { cellRing } from "./geometry";

/** How long the ring takes to fade (ms): two seconds, slow enough to be seen, never a flash. */
export const FLASH_MS = 2000;

/** The ring's strength at `f` (0..1 of FLASH_MS): up over the first tenth, then an ease-out fade to 0. */
export function ringAlpha(f: number): number {
  const x = Math.min(1, Math.max(0, f));
  if (x < 0.1) return x / 0.1;
  return Math.pow(1 - (x - 0.1) / 0.9, 1.6);
}
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
