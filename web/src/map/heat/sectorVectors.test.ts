// LANE_C §6 test 1: sectors.ts and sightline/search/sectors.py give the same layouts (ids, labels,
// rectangles to 1e-6 m, every cell's sector) on the shared vectors, the demo flight included.
import { describe, expect, it } from "vitest";
import type { MapFile } from "../../contract";
import vectors from "./__fixtures__/sector_vectors.json";
import { buildSectors, type SurveyFrameLike } from "./sectors";

interface Case {
  name: string;
  grid: MapFile["grid"];
  frames: SurveyFrameLike[];
  kind: "flight" | "lattice";
  sectors: { id: string; label: string; kind: string; steps: [number, number] | null; rect: Record<"west" | "east" | "north" | "south", number> }[];
  cell_sector_rle: [number, number][];
}

const unrle = (rle: [number, number][]) => rle.flatMap(([v, n]) => Array<number>(n).fill(v));

describe("sectors.ts matches sectors.py", () => {
  it.each((vectors.cases as unknown as Case[]).map((c) => [c.name, c] as const))("%s", (_, c) => {
    const got = buildSectors(c.grid, c.frames);
    expect(got.kind).toBe(c.kind);
    expect(got.sectors.map((s) => [s.id, s.label, s.kind, s.steps ?? null])).toEqual(c.sectors.map((s) => [s.id, s.label, s.kind, s.steps]));
    got.sectors.forEach((s, i) => {
      for (const k of ["west", "east", "north", "south"] as const) expect(s.rect[k]).toBeCloseTo(c.sectors[i]!.rect[k], 6);
    });
    expect(Array.from(got.cellSector)).toEqual(unrle(c.cell_sector_rle));
  });

  it("covers both layouts and the demo flight", () => {
    const cases = vectors.cases as unknown as Case[];
    expect(new Set(cases.map((c) => c.kind))).toEqual(new Set(["flight", "lattice"]));
    expect(cases.some((c) => c.name.startsWith("demo cache"))).toBe(true);
  });
});
