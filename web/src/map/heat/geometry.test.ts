import { describe, expect, it } from "vitest";
import {
  buildCellFeatures,
  canopyLabel,
  cellCenter,
  coveredCells,
  edgeLat,
  edgeLon,
  heatOpacity,
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
  it("opacity is 0.75 at the max, linear, and 0 below 2% of the max", () => {
    expect(heatOpacity(0.01, 0.01)).toBeCloseTo(0.75);
    expect(heatOpacity(0.005, 0.01)).toBeCloseTo(0.375);
    expect(heatOpacity(0.00019, 0.01)).toBe(0);
    expect(heatOpacity(0, 0)).toBe(0);
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
