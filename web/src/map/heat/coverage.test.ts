import { describe, expect, it } from "vitest";
import type { MapFile } from "../../contract";
import {
  buildOverlapIndex,
  clipConvex,
  eligibleCells,
  frameOverlaps,
  MIN_OVERLAP,
  overlapAtStep,
  photographedCells,
  type Point,
  polygonArea,
  summedOverlap,
  toLocalM,
} from "./coverage";

type Grid = MapFile["grid"];
type Footprint = [[number, number], [number, number], [number, number], [number, number]];

const grid: Grid = { origin_nw: { lat: 49.374492, lon: -122.951898 }, cell_m: 20, rows: 5, cols: 5 };
const M_LAT = 111_320;
const M_LON = M_LAT * Math.cos((grid.origin_nw.lat * Math.PI) / 180);

/** Axis-aligned footprint with centre (east, south) metres from the NW corner, as [lon, lat]. */
function box(eastM: number, southM: number, widthM: number, heightM: number): Footprint {
  const pt = (e: number, s: number): [number, number] => [
    grid.origin_nw.lon + e / M_LON,
    grid.origin_nw.lat - s / M_LAT,
  ];
  const [w, e, n, s] = [eastM - widthM / 2, eastM + widthM / 2, southM - heightM / 2, southM + heightM / 2];
  return [pt(e, n), pt(e, s), pt(w, s), pt(w, n)];
}

const total = (values: Float64Array) => values.reduce((a, b) => a + b, 0);

describe("toLocalM", () => {
  it("uses the contract grid formulas", () => {
    const [east, south] = toLocalM(grid, [grid.origin_nw.lon + 40 / M_LON, grid.origin_nw.lat - 30 / M_LAT]);
    expect(east).toBeCloseTo(40, 6);
    expect(south).toBeCloseTo(30, 6);
  });
});

describe("clipConvex and polygonArea", () => {
  it("clips a square against a square", () => {
    const sq: Point[] = [[5, 5], [25, 5], [25, 25], [5, 25]];
    expect(polygonArea(clipConvex(sq, 0, 0, 10, 10))).toBeCloseTo(25, 9);
  });

  it("returns an empty polygon when they are apart", () => {
    const sq: Point[] = [[50, 50], [60, 50], [60, 60], [50, 60]];
    expect(clipConvex(sq, 0, 0, 10, 10)).toHaveLength(0);
  });

  it("works with either winding order", () => {
    const sq: Point[] = [[0, 0], [0, 10], [10, 10], [10, 0]];
    expect(polygonArea(sq)).toBeCloseTo(100, 9);
    expect(polygonArea(clipConvex(sq, 0, 0, 5, 5))).toBeCloseTo(25, 9);
  });
});

describe("summedOverlap", () => {
  it("gives 0.75 for a 20 x 15 m footprint centred on a cell", () => {
    const o = summedOverlap(grid, [box(50, 50, 20, 15)]); // centre of row 2, col 2
    expect(o[2 * 5 + 2]).toBeCloseTo(0.75, 6);
    expect(total(o)).toBeCloseTo(0.75, 6);
  });

  it("splits a footprint on a shared corner over 4 cells", () => {
    const o = summedOverlap(grid, [box(40, 40, 20, 15)]);
    for (const idx of [1 * 5 + 1, 1 * 5 + 2, 2 * 5 + 1, 2 * 5 + 2]) expect(o[idx]).toBeCloseTo(0.1875, 6);
  });

  it("sums to the footprint area inside the grid, and adds up over frames", () => {
    const fp = box(37, 53, 31, 23);
    const one = summedOverlap(grid, [fp]);
    expect(total(one) * 400).toBeCloseTo(31 * 23, 4);
    const two = summedOverlap(grid, [fp, fp]);
    expect(two[2 * 5 + 2]).toBeCloseTo(2 * (one[2 * 5 + 2] as number), 9);
  });

  it("gives zeros for a footprint outside the grid and clips one on the edge", () => {
    expect(total(summedOverlap(grid, [box(500, 500, 20, 15)]))).toBe(0);
    expect(total(summedOverlap(grid, [box(0, 50, 20, 20)]))).toBeCloseTo(0.5, 6); // half outside the west edge
  });
});

describe("step-aware overlap", () => {
  // Frame 0 covers cells 0 and 1 (row 0), frame 1 covers cell 1 again and cell 2, frame 2 covers row 3.
  const footprints = [box(20, 10, 38, 18), box(40, 10, 38, 18), box(50, 70, 18, 18)];
  const n = grid.rows * grid.cols;

  it("frameOverlaps lists only the cells each footprint touches", () => {
    const frames = frameOverlaps(grid, footprints);
    expect(frames).toHaveLength(3);
    expect(frames[0]!.map(([i]) => i).sort((a, b) => a - b)).toEqual([0, 1]);
    for (const [, v] of frames[0]!) expect(v).toBeGreaterThan(0.8);
  });

  it("is empty at step 0 and equals summedOverlap at the last step", () => {
    const index = buildOverlapIndex(frameOverlaps(grid, footprints), n);
    expect(Array.from(overlapAtStep(index, 0))).toEqual(new Array(n).fill(0));
    expect(Array.from(overlapAtStep(index, 3))).toEqual(Array.from(summedOverlap(grid, footprints)));
  });

  it("sums the first k frames only, in any scrub order, across checkpoints", () => {
    const many = Array.from({ length: 60 }, (_, k) => box(10 + (k % 5) * 20, 10 + Math.floor(k / 12) * 20, 18, 18));
    const index = buildOverlapIndex(frameOverlaps(grid, many), n);
    for (const k of [60, 7, 59, 25, 26, 0, 50, 24]) {
      expect(Array.from(overlapAtStep(index, k))).toEqual(Array.from(summedOverlap(grid, many.slice(0, k))));
    }
    expect(Array.from(overlapAtStep(index, 999))).toEqual(Array.from(summedOverlap(grid, many)));
    expect(Array.from(overlapAtStep(index, -3))).toEqual(new Array(n).fill(0));
  });

  it("does not change an earlier result when a later step is asked for", () => {
    const index = buildOverlapIndex(frameOverlaps(grid, footprints), n);
    const a = overlapAtStep(index, 1);
    const copy = Array.from(a);
    overlapAtStep(index, 3);
    expect(Array.from(a)).toEqual(copy);
  });

  it("photographed means overlap above 0; eligible means at least MIN_OVERLAP and not held", () => {
    const overlap = Float64Array.from([0, 0.1, MIN_OVERLAP, 1.4]);
    expect(Array.from(photographedCells(overlap))).toEqual([0, 1, 1, 1]);
    expect(Array.from(eligibleCells(overlap))).toEqual([0, 0, 1, 1]);
    expect(Array.from(eligibleCells(overlap, Uint8Array.from([0, 0, 0, 1])))).toEqual([0, 0, 1, 0]);
  });
});
