import { describe, expect, it } from "vitest";
import type { MapFile } from "../../contract";
import { clipConvex, type Point, polygonArea, summedOverlap, toLocalM } from "./coverage";

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
