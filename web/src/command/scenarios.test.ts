import { describe, expect, it } from "vitest";
import type { MapBase, Mission, Proposal, SectorTask } from "../contract";
import { EMPTY } from "../lib/mission";
import type { DemoFull } from "./missionTime";
import { DEFAULT_SEED, deriveScenario, presetFor, PRESETS, scenarioMission } from "./scenarios";

const N = 40;
const GRID = { origin_nw: { lat: 49.374492, lon: -122.951898 }, cell_m: 5, rows: N, cols: N };
const square = (r: number, c: number): [number, number][] => {
  const lat = (row: number) => GRID.origin_nw.lat - (row * 5) / 111_320;
  const lon = (col: number) => GRID.origin_nw.lon + (col * 5) / (111_320 * Math.cos((GRID.origin_nw.lat * Math.PI) / 180));
  return [[lon(c), lat(r)], [lon(c + 20), lat(r)], [lon(c + 20), lat(r + 20)], [lon(c), lat(r + 20)], [lon(c), lat(r)]];
};
const sectors = [
  { sector_id: "A1", label: "A1", poa: 0.25, drone_coverage: 0, polygon: square(0, 0) },
  { sector_id: "B1", label: "B1", poa: 0.25, drone_coverage: 0, polygon: square(0, 20) },
  { sector_id: "A2", label: "A2", poa: 0.25, drone_coverage: 0, polygon: square(20, 0) },
  { sector_id: "B2", label: "B2", poa: 0.25, drone_coverage: 0, polygon: square(20, 20) },
];
const mapBase = { contract_version: "1.2", grid: GRID, lkp: { lat: 49.3735, lon: -122.9505 }, params: {}, prior: { p: new Array(N * N).fill(0.5 / (N * N)), outside: 0.5 }, canopy: new Array(N * N).fill(null) } as unknown as MapBase;
const full: DemoFull = {
  now: "2026-10-24T22:00:00Z",
  data: {
    ...EMPTY,
    mission: { mission_id: "demo", name: "Demo", area: { name: "x", lkp: mapBase.lkp }, subject: "adult" } as Mission,
    mapBase,
    sectors,
    clues: [{ id: "c001", kind: "other", text: "x", lat: 49.373, lon: -122.95, radius_m: 30, reported_by: "command", source: "form", confirmed: true, at: "2026-10-24T21:10:00Z" }],
    mapUpdates: [{ seq: 1, kind: "reweight", source: "clue", ref: "c001", cells: [[0, 1.7]], at: "2026-10-24T21:10:00Z" }],
    proposals: [{ id: "p003", kind: "assign_sector", target: { team: "T1", sector: "A1" }, summary: "Assign sector A1 to Team One", reason: "A1 holds 25 %", status: "approved", created_at: "2026-10-24T21:42:00Z" } as unknown as Proposal],
    tasks: [{ sector_id: "A1", state: "in_progress", team_id: "T1" } as SectorTask],
  },
};

describe("scenarios", () => {
  it("has the four presets, and any other seed is a shuffle: the same seed, the same scenario", () => {
    expect(PRESETS.map((p) => p.name)).toEqual(["Overdue hiker", "Missing child", "Despondent", "Dementia walk-away"]);
    expect(presetFor(null).seed).toBe(DEFAULT_SEED);
    expect(presetFor("s1a2b")).toEqual(presetFor("s1a2b"));
    expect(presetFor("s1a2b").name).toMatch(/^Shuffled/);
  });

  it("the overdue hiker is the demo mission as it is", async () => {
    const s = await scenarioMission(full, null);
    expect(s.data.mapBase).toBe(mapBase);
    expect(s.data.mission?.scenario_seed).toBe(DEFAULT_SEED);
  });

  it("another scenario moves the last known point and base camp, places its own clues, and sends the assignment to the likeliest open sector", () => {
    const s = deriveScenario(full, presetFor("missing-child"));
    const m = s.data.mission!;
    expect(m.subject).toMatch(/child/);
    expect(m.area.lkp).not.toEqual(mapBase.lkp);
    expect(m.base_camp).toBeTruthy();
    expect(s.data.clues![0]!.text).toMatch(/picnic/);
    expect(s.data.mapUpdates![0]!.cells.length).toBeGreaterThan(1); // reweighted around where it was found
    const p = s.data.proposals![0]!;
    const best = [...s.data.sectors!].sort((a, b) => b.poa - a.poa)[0]!.sector_id;
    expect(p.target.sector).toBe(best);
    expect(s.data.tasks![0]!.sector_id).toBe(best); // the task follows its proposal
    expect(p.reason).toMatch(/derived for this scenario/);
  });
});
