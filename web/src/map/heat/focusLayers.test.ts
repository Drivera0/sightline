// A new assignment's route (V3 §2): which assignments are new, where the team sets off, the way into the
// sector, and the route as it grows.
import { describe, expect, it } from "vitest";
import type { Proposal } from "../../contract";
import { newAssignments } from "./focusLayers";
import { entryPoint, inside, partialPath, pathLength, routeStart, routeTo, sweepLines } from "../base/teamRoute";

const sq = (w: number, s: number, e: number, n: number): [number, number][] => [[w, n], [e, n], [e, s], [w, s], [w, n]];
const C2 = sq(-122.946, 49.368, -122.942, 49.371);
const B1 = sq(-122.95, 49.372, -122.946, 49.375);
const prop = (id: string, status: Proposal["status"], team = "T1", sector = "C2", edits: Record<string, string> | null = null): Proposal => ({
  id, kind: "assign_sector", summary: "", reason: "", briefing: null, target: { team, sector }, evidence: [], status,
  created_by: "agent", created_at: "", decided_at: null, decided_by: null, decision_reason: null, edits,
});

describe("newAssignments", () => {
  it("an approval (with the team an edit chose) and a task newly assigned; nothing on the first look", () => {
    const tasks0 = [{ sector_id: "B1", state: "proposed", team_id: null }];
    expect(newAssignments(null, { proposals: [prop("p1", "pending")], tasks: tasks0 })).toEqual([]);
    const before = { proposals: [prop("p1", "pending"), prop("p2", "pending", "T2", "B3")], tasks: tasks0 };
    const now = { proposals: [prop("p1", "approved", "T1", "C2", { team: "T3" }), prop("p2", "pending", "T2", "B3")], tasks: [{ sector_id: "B1", state: "assigned", team_id: "T4" }] };
    expect(newAssignments(before, now)).toEqual([{ team: "T3", sector: "C2" }, { team: "T4", sector: "B1" }]);
    // the same state again is not new
    expect(newAssignments(now, now)).toEqual([]);
  });
});

describe("teamRoute", () => {
  it("sets off from where the team is, else its last sector, else base camp", () => {
    const base = { lat: 49.373, lon: -122.949 };
    const sectors = [{ sector_id: "B1", polygon: B1 }, { sector_id: "C2", polygon: C2 }];
    expect(routeStart({ id: "T1", position: { lat: 49.37, lon: -122.95 } }, "C2", [], sectors, base)).toEqual([-122.95, 49.37]);
    const last = routeStart({ id: "T1" }, "C2", [{ sector_id: "B1", state: "searched", team_id: "T1" }], sectors, base)!;
    expect(last[0]).toBeCloseTo(-122.948);
    expect(last[1]).toBeCloseTo(49.3735);
    expect(routeStart({ id: "T1" }, "C2", [], sectors, base)).toEqual([-122.949, 49.373]);
  });

  it("walks to the nearest point of the sector's outline", () => {
    const from: [number, number] = [-122.949, 49.3695];
    const e = entryPoint(from, C2);
    expect(e[0]).toBeCloseTo(-122.946);
    expect(e[1]).toBeCloseTo(49.3695);
    expect(inside([-122.944, 49.369], C2)).toBe(true);
    expect(routeTo([-122.944, 49.369], C2)).toHaveLength(1); // already inside
  });

  it("grows along the path by length, and sweeps the sector in rows", () => {
    const path: [number, number][] = [[0, 0], [0, 0.001], [0.001, 0.001]];
    expect(partialPath(path, 0)).toEqual([[0, 0], [0, 0]]);
    expect(partialPath(path, 1)).toEqual(path);
    const half = partialPath(path, 0.5);
    expect(half.at(-1)![1]).toBeGreaterThan(0.0009);
    expect(pathLength(half)).toBeCloseTo(pathLength(path) / 2, 0);
    const rows = sweepLines(C2, 4, [-122.949, 49.3685]);
    expect(rows).toHaveLength(8);
    expect(rows[0]![1]).toBeLessThan(49.3695); // starts on the south side, nearest the way in
  });
});
