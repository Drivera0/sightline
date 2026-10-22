import { describe, expect, it } from "vitest";
import type { Clue, MapBase, MapUpdate } from "../../contract";
import { cluesToFlash, flashFeatures, seenOf } from "./clueFlash";

const clue = (id: string, confirmed = true): Clue =>
  ({ id, kind: "object", text: "a bottle", lat: 49.37, lon: -122.945, radius_m: 40, reported_by: "T1", source: "radio", at: "2026-10-24T21:54:00Z", confirmed }) as Clue;

describe("the clue flash", () => {
  it("flashes a clue that is new or just confirmed, and none on the first look", () => {
    const a = clue("c001");
    const b = clue("c002", false);
    expect(cluesToFlash(null, [a, b])).toEqual([]);
    const before = seenOf([a, b]);
    expect(cluesToFlash(before, [a, b])).toEqual([]);
    const c = clue("c003");
    expect(cluesToFlash(before, [a, b, c]).map((x) => x.id)).toEqual(["c003"]);
    expect(cluesToFlash(before, [a, { ...b, confirmed: true }]).map((x) => x.id)).toEqual(["c002"]);
  });

  it("draws the clue's circle and the cells its own map update touched", () => {
    const base = { grid: { origin_nw: { lat: 49.375, lon: -122.952 }, cell_m: 5, rows: 200, cols: 200 } } as unknown as MapBase;
    const updates = [
      { seq: 1, kind: "step", source: "clue", ref: "c003", cells: [[10, 0.5], [11, 0.5]], canopy: null, at: "x" },
      { seq: 2, kind: "step", source: "frame", ref: "f0001", cells: [[12, 0.5]], canopy: null, at: "x" },
    ] as unknown as MapUpdate[];
    const fs = flashFeatures(base, [clue("c003")], updates);
    expect(fs.map((f) => f.properties.kind)).toEqual(["circle", "cell", "cell"]);
    expect(fs[1]!.geometry.coordinates[0]).toHaveLength(5); // a closed square
  });
});
