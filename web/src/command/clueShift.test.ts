// Which clue moved a sector, read off the map log: the line under an assignment's reason (review item 2).
import { describe, expect, it } from "vitest";
import type { Clue, MapBase, MapUpdate, Proposal } from "../contract";
import type { SectorNow } from "../lib/api";
import fixture from "./__fixtures__/demo_mission.json";
import { clueLine, clueNoteFor, clueShifts, reasonNamesClues } from "./clueShift";
import { STORY_PROPOSAL, STORY_SECTOR } from "./missionTime";

const GRID = { origin_nw: { lat: 49.374492, lon: -122.951898 }, cell_m: 5, rows: 200, cols: 200 };
const base = {
  contract_version: "1.2",
  grid: GRID,
  lkp: { lat: 49.37, lon: -122.945 },
  params: { recall: 0.864, recall_source: "x", pod_cap: 0.95, review_pod: 0.9, prior_source: "placeholder" },
  prior: { p: new Array(40000).fill(0.5 / 40000), outside: 0.5 },
  canopy: new Array(40000).fill(null),
} as unknown as MapBase;
const fx = fixture as unknown as { map_updates: MapUpdate[]; sectors: SectorNow[]; clues: Clue[]; proposals: Proposal[] };

describe("clue shifts", () => {
  const shifts = clueShifts(base, fx.map_updates, fx.sectors, fx.clues);

  it("names the clues that raised the story's sector, with the shares before and after", () => {
    const own = shifts.get(STORY_SECTOR)!;
    expect(own.length).toBeGreaterThan(0);
    const line = clueLine(own)!;
    // the lake sighting is in C2: it raises it most
    expect(line).toMatch(/^c001 \(hiker at the lot saw a red jacket near the lake around 11:30\) raised C2 from \d\.\d % to \d\.\d %/);
    expect(fx.proposals.find((p) => p.id === STORY_PROPOSAL)!.target.sector).toBe(STORY_SECTOR);
  });

  it("the water bottle at the creek crossing raises C3; a corner gets no line (it only fell)", () => {
    expect(clueLine(shifts.get("C3"))).toContain("c003 (blue water bottle by the creek crossing) raised C3");
    expect(clueLine(shifts.get("A1"))).toBeNull();
    expect(clueLine(undefined)).toBeNull();
  });

  it("drops the line when the reason already names its clues; keeps it for an older reason", () => {
    const story = fx.proposals.find((p) => p.id === STORY_PROPOSAL)!;
    const line = clueLine(shifts.get(STORY_SECTOR));
    expect(reasonNamesClues(story.reason)).toBe(true); // the planner's evidence format: "c001 (hiker at the lot saw…) … raised it"
    expect(clueNoteFor(story.reason, line)).toBeNull();
    const old = "Sector C2 holds 5.5 % of the probability; 48% under tree cover.";
    expect(reasonNamesClues(old)).toBe(false); // "C2" is a sector, not a clue
    expect(clueNoteFor(old, line)).toBe(line);
    expect(clueNoteFor(old, null)).toBeNull();
  });

  it("ground searches and frames move the map but are not clues", () => {
    const steps = fx.map_updates.filter((u) => u.source !== "clue");
    expect(clueShifts(base, steps, fx.sectors).size).toBe(0);
  });
});
