import { describe, expect, it } from "vitest";
import {
  buildCellFeatures,
  canopyLabel,
  cellCenter,
  coveredCells,
  edgeLat,
  edgeLon,
  fixedHeatLevels,
  heatScaleMax,
  HEAT_FLOOR,
  HEAT_CEIL,
  topCellIndices,
  percentile,
  relativeHeatOpacities,
  probabilityShares,
  surveyedBoundary,
} from "./geometry";

const grid = { origin_nw: { lat: 49.374492, lon: -122.951898 }, cell_m: 20, rows: 3, cols: 3 };

describe("cell geometry", () => {
  it("cell 0's centre is 10 m south and 10 m east of origin_nw", () => {
    const c = cellCenter(grid, 0);
    expect((grid.origin_nw.lat - c.lat) * 111320).toBeCloseTo(10, 9);
    const mPerDegLon = 111320 * Math.cos((grid.origin_nw.lat * Math.PI) / 180);
    expect((c.lon - grid.origin_nw.lon) * mPerDegLon).toBeCloseTo(10, 9);
  });

  it("builds one closed [lon, lat] polygon per cell with an idx property", () => {
    const fc = buildCellFeatures(grid);
    expect(fc.features).toHaveLength(9);
    const ring = fc.features[4]!.geometry.coordinates[0]!;
    expect(fc.features[4]!.properties.idx).toBe(4);
    expect(ring[0]).toEqual([edgeLon(grid, 1), edgeLat(grid, 1)]);
    expect(ring[2]).toEqual([edgeLon(grid, 2), edgeLat(grid, 2)]);
    expect(ring[4]).toEqual(ring[0]);
  });
});

describe("surveyedBoundary", () => {
  it("one covered cell has 4 sides", () => {
    const covered = new Uint8Array(9);
    covered[4] = 1;
    expect(surveyedBoundary(grid, covered)).toHaveLength(4);
  });

  it("two adjacent covered cells share no inner edge: 6 sides", () => {
    const covered = new Uint8Array(9);
    covered[0] = 1;
    covered[1] = 1;
    const segs = surveyedBoundary(grid, covered);
    expect(segs).toHaveLength(6);
    // The shared side x = edgeLon(1) between rows 0 and 1 is not in the outline.
    const shared = segs.filter((s) => s[0]![0] === edgeLon(grid, 1) && s[1]![0] === edgeLon(grid, 1));
    expect(shared).toHaveLength(0);
  });

  it("the whole grid covered gives only the outer border", () => {
    expect(surveyedBoundary(grid, new Uint8Array(9).fill(1))).toHaveLength(12);
  });

  it("covered = cells in any step or with a canopy value", () => {
    const covered = coveredCells({
      grid,
      steps: [{ frame_id: "f0001", cells: [[2, 0.5]] }],
      canopy: [null, null, null, 0.3, null, null, null, null, null],
    });
    expect(Array.from(covered)).toEqual([0, 0, 1, 1, 0, 0, 0, 0, 0]);
  });
});

describe("panel maths", () => {
  it("percentile interpolates linearly", () => {
    expect(percentile([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 1)).toBe(5);
    expect(percentile([0, 10], 0.25)).toBeCloseTo(2.5);
  });

  it("stretches photographed cells from the floor to the ceiling and hides the rest", () => {
    // 21 photographed cells, p = 0..20 (1e-4 steps); two unphotographed cells with huge p.
    const p = new Float64Array(23);
    const covered = new Uint8Array(23);
    for (let i = 0; i < 21; i++) {
      p[i] = i * 1e-4;
      covered[i] = 1;
    }
    p[21] = 0.5;
    p[22] = 0.9;
    const o = relativeHeatOpacities(p, covered);
    expect(o[21]).toBe(0);
    expect(o[22]).toBe(0);
    // 5th and 95th percentile are cells 1 and 19; outside them the value is clamped.
    expect(o[0]).toBeCloseTo(HEAT_FLOOR);
    expect(o[1]).toBeCloseTo(HEAT_FLOOR);
    expect(o[19]).toBeCloseTo(HEAT_CEIL);
    expect(o[20]).toBeCloseTo(HEAT_CEIL);
    expect(o[10]).toBeCloseTo((HEAT_FLOOR + HEAT_CEIL) / 2);
  });

  it("is not flattened by tiny, close values (p / max would be)", () => {
    const p = Float64Array.from([1e-4, 1.1e-4, 1.2e-4, 0.01]);
    const covered = Uint8Array.from([1, 1, 1, 0]);
    const o = relativeHeatOpacities(p, covered);
    expect(o[2]! - o[0]!).toBeGreaterThan(0.5);
  });

  it("gives photographed cells one mid value when they all share the same p", () => {
    const o = relativeHeatOpacities(Float64Array.from([2e-4, 2e-4, 5e-4]), Uint8Array.from([1, 1, 0]));
    expect(o[0]).toBeCloseTo((HEAT_FLOOR + HEAT_CEIL) / 2);
    expect(o[1]).toBe(o[0]);
    expect(o[2]).toBe(0);
  });

  it("is all zero when nothing is photographed", () => {
    const o = relativeHeatOpacities(Float64Array.from([1, 2]), Uint8Array.from([0, 0]));
    expect(Array.from(o)).toEqual([0, 0]);
  });

  it("an open-ground cell (lower p) is dimmer than a forest cell (higher p)", () => {
    // Seen open ground was cleared (p dropped); seen forest kept more of its prior.
    const p = Float64Array.from([4e-4, 3e-5, 4e-4, 2e-5, 3.5e-4, 9e-3]);
    const covered = Uint8Array.from([1, 1, 1, 1, 1, 0]);
    const o = relativeHeatOpacities(p, covered);
    expect(o[1]).toBeLessThan(o[0]!);
    expect(o[3]).toBeLessThan(o[4]!);
  });

  it("canopy labels", () => {
    expect(canopyLabel(0.5)).toBe("dense forest");
    expect(canopyLabel(0.49)).toBe("open");
    expect(canopyLabel(null)).toBe("not photographed");
  });

  it("shares sum to 1", () => {
    const s = probabilityShares({ p: Float64Array.from([0.2, 0.1, 0.3]), outside: 0.4 }, Uint8Array.from([1, 0, 0]));
    expect(s.surveyed).toBeCloseTo(0.2);
    expect(s.restOfGrid).toBeCloseTo(0.4);
    expect(s.outside).toBeCloseTo(0.4);
  });
});

describe("relativeHeatOpacities with held cells", () => {
  it("keeps held cells out of the stretch bounds and gives them no heat", () => {
    const p = Float64Array.from([1, 2, 3, 4, 1000]);
    const covered = Uint8Array.from([1, 1, 1, 1, 1]);
    const held = Uint8Array.from([0, 0, 0, 0, 1]);
    const o = relativeHeatOpacities(p, covered, held);
    expect(o[4]).toBe(0);
    // Without the held cell the stretch is over 1..4: the top cell reaches the ceiling.
    expect(o[3]).toBeCloseTo(HEAT_CEIL, 9);
    expect(o[0]).toBeCloseTo(HEAT_FLOOR, 9);
  });

  it("gives the same result as before when nothing is held", () => {
    const p = Float64Array.from([1, 2, 3, 4]);
    const covered = Uint8Array.from([1, 1, 1, 0]);
    expect(Array.from(relativeHeatOpacities(p, covered, new Uint8Array(4)))).toEqual(
      Array.from(relativeHeatOpacities(p, covered)),
    );
  });
});

describe("fixedHeatLevels", () => {
  it("divides by the prior's top cell, clamps, and gives 0 to unphotographed and held cells", () => {
    const max = heatScaleMax(Float64Array.from([0.1, 0.4, 0.2]));
    expect(max).toBe(0.4);
    const p = Float64Array.from([0.1, 0.2, 0.5, 0.3]);
    const levels = fixedHeatLevels(p, Uint8Array.from([1, 1, 1, 0]), max, Uint8Array.from([0, 1, 0, 0]));
    expect(Array.from(levels)).toEqual([0.25, 0, 1, 0]);
  });

  it("does not depend on which other cells are photographed", () => {
    const p = Float64Array.from([0.1, 0.3]);
    expect(fixedHeatLevels(p, Uint8Array.from([1, 0]), 0.4)[0]).toBe(fixedHeatLevels(p, Uint8Array.from([1, 1]), 0.4)[0]);
    expect(Array.from(fixedHeatLevels(p, Uint8Array.from([1, 1]), 0))).toEqual([0, 0]);
  });
});

describe("topCellIndices", () => {
  /** The plain definition: sort every allowed cell, most likely first, ties by lower index. */
  const bySort = (p: Float64Array, n: number, only?: Uint8Array) =>
    Array.from(p.keys())
      .filter((i) => only === undefined || only[i] === 1)
      .sort((a, b) => (p[b] as number) - (p[a] as number) || a - b)
      .slice(0, n);

  it("matches a full sort, ties included, with and without a mask", () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let trial = 0; trial < 50; trial++) {
      // Few distinct values, so ties are common.
      const p = Float64Array.from({ length: 300 }, () => Math.floor(rand() * 6) / 6);
      const only = Uint8Array.from({ length: 300 }, () => (rand() < 0.6 ? 1 : 0));
      for (const n of [0, 1, 5, 12]) {
        expect(topCellIndices(p, n)).toEqual(bySort(p, n));
        expect(topCellIndices(p, n, only)).toEqual(bySort(p, n, only));
      }
    }
    expect(topCellIndices(Float64Array.from([0.1, 0.2]), 5)).toEqual([1, 0]);
  });
});
