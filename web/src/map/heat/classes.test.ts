import { describe, expect, it } from "vitest";
import {
  CELL,
  cellKinds,
  classShares,
  contourMask,
  maskBoundary,
  maskOf,
  maskRectangles,
  massThresholds,
  surfaceData,
  withoutSpecks,
} from "./classes";
import { edgeLat, edgeLon } from "./geometry";

const all = (n: number) => new Uint8Array(n).fill(1);
const none = (n: number) => new Uint8Array(n);

describe("mass classes", () => {
  it("puts the fewest likeliest cells holding 50 %, then 80 %, then 90 % of the mass in the three classes", () => {
    // Ten cells: 0.40, 0.20, 0.15, 0.10, 0.05 and five of 0.02.
    const p = Float64Array.from([0.4, 0.2, 0.15, 0.1, 0.05, 0.02, 0.02, 0.02, 0.02, 0.02]);
    const kinds = cellKinds(p, all(10), none(10));
    // 0.40 alone < 50 %; with 0.20 it is 60 %: the top class. 0.15 brings 75 %, 0.10 85 % (≥ 80 %).
    // 0.05 brings 90 %: the last class. The 0.02 cells hold the last 10 %: no fill.
    expect(Array.from(kinds)).toEqual([1, 1, 2, 2, 3, 0, 0, 0, 0, 0]);
    const [top, mid, low] = classShares(p, kinds);
    expect(top).toBeCloseTo(0.6, 9);
    expect(top + mid).toBeCloseTo(0.85, 9);
    expect(top + mid + low).toBeCloseTo(0.9, 9);
  });

  it("never splits tied cells: a flat area is all in the class its first cell reaches", () => {
    const p = new Float64Array(8).fill(0.125);
    expect(Array.from(cellKinds(p, all(8), none(8)))).toEqual(new Array(8).fill(CELL.top));
    expect(massThresholds(p, all(8))).toEqual([0.125, 0.125, 0.125]);
  });

  it("does not depend on the cell order or the overall scale (only shares count)", () => {
    const p = Float64Array.from([0.02, 0.4, 0.02, 0.2, 0.05, 0.1, 0.15]);
    const scaled = p.map((v) => v * 1e-6);
    expect(Array.from(cellKinds(scaled, all(7), none(7)))).toEqual(Array.from(cellKinds(p, all(7), none(7))));
  });

  it("veils unphotographed cells, keeps held cells neutral, and leaves both out of the mass", () => {
    const p = Float64Array.from([0.9, 0.05, 0.03, 0.02]);
    // Cell 0 (most of the mass) is not photographed; cell 1 is awaiting review.
    const kinds = cellKinds(p, Uint8Array.from([0, 1, 1, 1]), Uint8Array.from([0, 1, 0, 0]));
    expect(kinds[0]).toBe(CELL.veil);
    expect(kinds[1]).toBe(CELL.held);
    // Among cells 2 and 3 alone: 0.03 is 60 % of their mass, the top class.
    expect(kinds[2]).toBe(CELL.top);
    expect(kinds[3]).toBe(CELL.mid);
  });

  it("has no class at all when no photographed cell has mass", () => {
    expect(massThresholds(new Float64Array(3), all(3))).toBeNull();
    expect(Array.from(cellKinds(new Float64Array(3), all(3), none(3)))).toEqual([0, 0, 0]);
  });
});

const grid = { origin_nw: { lat: 49.37, lon: -122.95 }, cell_m: 5, rows: 4, cols: 4 };

describe("fill shapes", () => {
  it("covers exactly the cells of a kind with rectangles, merging runs down the rows", () => {
    // A 2 × 2 block in the top-left and one cell at the bottom-right.
    const kinds = Uint8Array.from([1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    const rects = maskRectangles(grid, kinds, (k) => k === 1);
    expect(rects).toHaveLength(2);
    const [block, single] = rects as unknown as [[number, number][][], [number, number][][]];
    // The block: west edge of column 0 to east edge of column 2, north of row 0 to south of row 2.
    const xs = block[0]!.map((c) => c[0]);
    const ys = block[0]!.map((c) => c[1]);
    expect(Math.min(...xs)).toBe(edgeLon(grid, 0));
    expect(Math.max(...xs)).toBe(edgeLon(grid, 2));
    expect(Math.max(...ys)).toBe(edgeLat(grid, 0));
    expect(Math.min(...ys)).toBe(edgeLat(grid, 2));
    expect(single[0]![0]).toEqual([edgeLon(grid, 3), edgeLat(grid, 3)]);
    // Closed rings.
    for (const r of rects) expect(r[0]!.at(-1)).toEqual(r[0]![0]);
  });

  it("puts one MultiPolygon per fill kind and one MultiLineString per contour level", () => {
    const kinds = Uint8Array.from([5, 5, 5, 5, 5, 1, 1, 5, 5, 2, 3, 5, 5, 0, 4, 5]);
    const { fills, contours } = surfaceData(grid, kinds, 1);
    expect(fills.features.map((f) => f.properties.kind).sort()).toEqual([CELL.top, CELL.mid, CELL.low, CELL.held, CELL.veil].sort());
    expect(fills.features.every((f) => f.geometry.type === "MultiPolygon")).toBe(true);
    expect(contours.features.map((f) => f.properties.level)).toEqual([90, 50]);
    // Nothing at all: no features (the sources are emptied, not left with stale shapes).
    expect(surfaceData(grid, new Uint8Array(16)).fills.features).toEqual([]);
  });
});

describe("contours", () => {
  it("traces a region's edge as straight lines along the grid lines", () => {
    // The 2 × 2 block in the middle of the 4 × 4 grid: four sides, each one line two cells long.
    const mask = Uint8Array.from([0, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 0]);
    const lines = maskBoundary(grid, mask);
    expect(lines).toHaveLength(4);
    const north = lines.find((l) => l[0]![1] === edgeLat(grid, 1) && l[1]![1] === edgeLat(grid, 1))!;
    expect(north).toEqual([
      [edgeLon(grid, 1), edgeLat(grid, 1)],
      [edgeLon(grid, 3), edgeLat(grid, 1)],
    ]);
  });

  it("follows the 50 % region for level 50 and the whole 90 % region for level 90", () => {
    // Three rows of: two columns top, two mid, one low, two with no class.
    const row = [1, 1, 2, 2, 3, 0, 0];
    const kinds = Uint8Array.from([...row, ...row, ...row]);
    const g = { ...grid, rows: 3, cols: 7 };
    const { contours } = surfaceData(g, kinds, 1);
    const at = (level: number) => contours.features.find((f) => f.properties.level === level)!.geometry.coordinates as number[][][];
    const east = (lines: number[][][]) => Math.max(...lines.flat().map((c) => c[0] as number));
    expect(east(at(50))).toBe(edgeLon(g, 2));
    expect(east(at(90))).toBe(edgeLon(g, 5));
  });

  it("drops specks and fills pinholes smaller than the minimum, never a gap open to the grid edge", () => {
    const g = { rows: 5, cols: 5 };
    // A 3 × 3 block with a one-cell hole, a lone cell far away, and a one-cell notch at the grid edge.
    // prettier-ignore
    const mask = Uint8Array.from([
      1, 0, 1, 0, 0,
      1, 0, 1, 0, 0,
      1, 1, 1, 0, 0,
      0, 0, 0, 0, 0,
      0, 0, 0, 0, 1,
    ]);
    // The one-cell gap at (0, 1) and (1, 1) touches the north edge: not a hole.
    const out = withoutSpecks(g, mask, 3);
    expect(out[24]).toBe(0); // the lone cell is gone
    expect(out[1]).toBe(0); // the notch open to the edge stays outside
    expect(out[0]).toBe(1);
    const holed = Uint8Array.from([1, 1, 1, 0, 0, 1, 0, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(withoutSpecks(g, holed, 3)[6]).toBe(1); // the enclosed hole is filled
    expect(Array.from(withoutSpecks(g, mask, 1))).toEqual(Array.from(mask));
  });

  it("smooths spurs and gaps one cell wide out of the line, keeping the region", () => {
    const g = { rows: 6, cols: 6 };
    // A 4 × 4 block with a one-cell spur sticking out of its east side.
    const mask = new Uint8Array(36);
    for (let r = 1; r <= 4; r++) for (let c = 0; c <= 3; c++) mask[r * 6 + c] = 1;
    mask[2 * 6 + 4] = 1;
    const out = contourMask(g, mask, 4);
    expect(out[2 * 6 + 4]).toBe(0);
    for (let r = 1; r <= 4; r++) for (let c = 0; c <= 3; c++) expect(out[r * 6 + c]).toBe(1);
    expect(maskOf(Uint8Array.from([0, 1, 2, 3]), (k) => k >= 2)).toEqual(Uint8Array.from([0, 0, 1, 1]));
  });
});
