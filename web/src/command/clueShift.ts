// Which confirmed clues moved a sector's probability, read off the map log: the planner's reason gives a
// sector's share of the probability, and this says which clue put it there ("c003, blue water bottle by
// the creek crossing, raised C3 from 3.1 % to 3.9 %"). Computed in the console from the mission's own
// map log (each clue's `MapUpdate`, source "clue", ref the clue id), for any mission; the agent's reason
// is left as the agent wrote it.

import type { Clue, MapBase, MapUpdate } from "../contract";
import type { SectorNow } from "../lib/api";
import { applyUpdate, baseState } from "../search/live";
import type { MapState } from "../search/update";
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

/** The replay keeps the map's state every this many updates, to pick up from when the log changes. */
const CHECKPOINT_EVERY = 25;

interface Replay {
  cells: Map<string, number[]>;
  sigs: string[];
  /** The state after the first k updates, for k = 0, 25, 50, … and the whole log. */
  at: Map<number, MapState>;
  s: MapState;
  /** Each shift found, with the index of its update in the log. */
  found: (Omit<ClueShift, "text"> & { k: number })[];
}
const replays = new WeakMap<MapBase, Replay>();
const sigOf = (u: MapUpdate) => `${u.seq}|${u.source}|${u.kind}|${u.ref ?? ""}|${u.cells.length}|${u.cells[0]?.join(",") ?? ""}|${u.cells.at(-1)?.join(",") ?? ""}`;

/**
 * For each sector, the clue updates that changed its share by at least MIN_SHIFT, in log order: one
 * replay of the log, the sector's share read before and after each clue's reweight. The replay is kept
 * per map (the guided clock asks ten times a second while photos land ahead of a clue's update): a log
 * that changes picks up from the last checkpoint before the first update that differs.
 */
export function clueShifts(base: MapBase, updates: readonly MapUpdate[], sectors: readonly SectorNow[], clues: readonly Clue[] = []): Map<string, ClueShift[]> {
  const cells = sectorCells(base, sectors);
  const share = (p: Float64Array, own: number[]) => own.reduce((n, i) => n + (p[i] ?? 0), 0);
  const sigs = updates.map(sigOf);
  let r = replays.get(base);
  if (!r || r.cells !== cells) {
    r = { cells, sigs: [], at: new Map([[0, baseState(base)]]), s: baseState(base), found: [] };
    replays.set(base, r);
  }
  // the first update that differs from the last replay's log
  let same = 0;
  while (same < r.sigs.length && same < sigs.length && r.sigs[same] === sigs[same]) same++;
  if (same < r.sigs.length) {
    const from = Math.floor(same / CHECKPOINT_EVERY) * CHECKPOINT_EVERY;
    r.s = r.at.get(from)!;
    for (const k of r.at.keys()) if (k > from) r.at.delete(k);
    r.found = r.found.filter((f) => f.k < from);
    r.sigs = r.sigs.slice(0, from);
  }
  for (let k = r.sigs.length; k < updates.length; k++) {
    const u = updates[k]!;
    const before = r.s;
    r.s = applyUpdate(r.s, u);
    if ((k + 1) % CHECKPOINT_EVERY === 0) r.at.set(k + 1, r.s);
    if (u.source !== "clue") continue;
    for (const [sector, own] of cells) {
      if (!own.length) continue;
      const [a, b] = [share(before.p, own), share(r.s.p, own)];
      if (Math.abs(b - a) >= MIN_SHIFT) r.found.push({ clue: u.ref ?? "?", sector, before: a, after: b, k });
    }
  }
  r.sigs = sigs;
  const out = new Map<string, ClueShift[]>();
  for (const { k: _k, ...f } of r.found) {
    const text = clues.find((c) => c.id === f.clue)?.text ?? null;
    out.set(f.sector, [...(out.get(f.sector) ?? []), { ...f, text }]);
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
