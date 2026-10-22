// Which confirmed clues moved a sector's probability, read off the map log: the planner's reason gives a
// sector's share of the probability, and this says which clue put it there ("c003, blue water bottle by
// the creek crossing, raised C3 from 3.1 % to 3.9 %"). Computed in the console from the mission's own
// map log (each clue's `MapUpdate`, source "clue", ref the clue id), for any mission; the agent's reason
// is left as the agent wrote it.

import type { Clue, MapBase, MapUpdate } from "../contract";
import type { SectorNow } from "../lib/api";
import { applyUpdate, baseState } from "../search/live";
import { sectorCells } from "./missionTime";

export interface ClueShift {
  clue: string;
  text: string | null;
  sector: string;
  before: number;
  after: number;
}

/** Changes smaller than this (a share of the whole probability) are not worth a line. */
export const MIN_SHIFT = 0.001;

/**
 * For each sector, the clue updates that changed its share by at least MIN_SHIFT, in log order: one
 * replay of the log, the sector's share read before and after each clue's reweight.
 */
export function clueShifts(base: MapBase, updates: readonly MapUpdate[], sectors: readonly SectorNow[], clues: readonly Clue[] = []): Map<string, ClueShift[]> {
  const cells = sectorCells(base, sectors);
  const share = (p: Float64Array, own: number[]) => own.reduce((n, i) => n + (p[i] ?? 0), 0);
  const out = new Map<string, ClueShift[]>();
  let s = baseState(base);
  for (const u of updates) {
    if (u.source !== "clue") {
      s = applyUpdate(s, u);
      continue;
    }
    const before = s;
    s = applyUpdate(s, u);
    for (const [sector, own] of cells) {
      if (!own.length) continue;
      const [a, b] = [share(before.p, own), share(s.p, own)];
      if (Math.abs(b - a) < MIN_SHIFT) continue;
      const text = clues.find((c) => c.id === u.ref)?.text ?? null;
      out.set(sector, [...(out.get(sector) ?? []), { clue: u.ref ?? "?", text, sector, before: a, after: b }]);
    }
  }
  return out;
}

const pct = (v: number) => `${(v * 100).toFixed(1)} %`;

/** One line for a proposal card: "c001 (hiker …) raised C2 from 2.9 % to 5.0 %; …", rises only, biggest first. */
export function clueLine(shifts: readonly ClueShift[] | undefined): string | null {
  const up = (shifts ?? []).filter((x) => x.after > x.before).sort((a, b) => b.after - b.before - (a.after - a.before));
  if (!up.length) return null;
  return up.map((x) => `${x.clue}${x.text ? ` (${x.text})` : ""} raised ${x.sector} from ${pct(x.before)} to ${pct(x.after)}`).join("; ");
}

/** A clue id in a reason ("c001"): the planner's reasons name their evidence (agent.md, "Reasons name their evidence"). */
const CLUE_ID = /\bc\d{2,}\b/;

/** Whether a proposal's reason already names the clues behind it, so the card needs no line of its own. */
export function reasonNamesClues(reason: string): boolean {
  return CLUE_ID.test(reason);
}

/**
 * The card's clue line, or null when the reason already names its clues (any planner reason since the
 * evidence format); the line stays for reasons written before it (old fixtures, older missions).
 */
export function clueNoteFor(reason: string, line: string | null): string | null {
  return line && !reasonNamesClues(reason) ? line : null;
}
