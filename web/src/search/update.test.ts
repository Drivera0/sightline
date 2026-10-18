import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MapFile } from "../contract";
import {
  applyReviewNotPerson,
  applyReviewPerson,
  applyStep,
  candidateShares,
  cellsWithinRadius,
  mergeSightings,
  replay,
  type MapState,
} from "./update";

type Grid = MapFile["grid"];
interface StateJson {
  p: number[];
  outside: number;
}
interface Vectors {
  step_cases: { name: string; prior: StateJson; steps: { cells: [number, number][] }[]; after: StateJson[] }[];
  radius_cases: { name: string; grid: Grid; lat: number; lon: number; radius_m: number; expected: number[] }[];
  review_cases: {
    name: string;
    grid: Grid;
    state: StateJson;
    lat: number;
    lon: number;
    radius_m: number;
    review_pod: number;
    pod_cap: number;
    expected: StateJson;
  }[];
}

// vitest runs from web/
const vectors = JSON.parse(
  readFileSync(join(process.cwd(), "src/search/__fixtures__/update_vectors.json"), "utf8"),
) as Vectors;

const toState = (s: StateJson): MapState => ({ p: Float64Array.from(s.p), outside: s.outside });

// Largest absolute TS-vs-Python difference seen, reported at the end.
let maxDiff = 0;

function expectClose(actual: MapState, expected: StateJson, tol: number, label: string): void {
  expect(actual.p.length, label).toBe(expected.p.length);
  let worst = Math.abs(actual.outside - expected.outside);
  expected.p.forEach((v, i) => {
    worst = Math.max(worst, Math.abs((actual.p[i] as number) - v));
  });
  maxDiff = Math.max(maxDiff, worst);
  expect(worst, label).toBeLessThanOrEqual(tol);
}

describe("update.ts matches the Python vectors", () => {
  it.each(vectors.step_cases.map((c) => [c.name, c] as const))("applyStep and replay: %s", (_, c) => {
    const prior = toState(c.prior);
    const priorCopy = Float64Array.from(prior.p);
    const stepsCopy = JSON.stringify(c.steps);

    let s = prior;
    c.steps.forEach((step, k) => {
      s = applyStep(s, step.cells);
      expectClose(s, c.after[k] as StateJson, 1e-9, `${c.name} step ${k + 1}`);
    });
    for (let upTo = 1; upTo <= c.steps.length; upTo++) {
      expectClose(replay(prior, c.steps, upTo), c.after[upTo - 1] as StateJson, 1e-9, `${c.name} upTo ${upTo}`);
    }
    // upTo is clamped
    expectClose(replay(prior, c.steps, 0), c.prior, 0, `${c.name} upTo 0`);
    expectClose(replay(prior, c.steps, -3), c.prior, 0, `${c.name} upTo -3`);
    expectClose(replay(prior, c.steps, 999), c.after[c.after.length - 1] as StateJson, 1e-9, `${c.name} upTo 999`);

    expect(prior.p).toEqual(priorCopy);
    expect(prior.outside).toBe(c.prior.outside);
    expect(JSON.stringify(c.steps)).toBe(stepsCopy);
  });

  it.each(vectors.radius_cases.map((c) => [c.name, c] as const))("cellsWithinRadius: %s", (_, c) => {
    expect(cellsWithinRadius(c.grid, c.lat, c.lon, c.radius_m)).toEqual(c.expected);
  });

  it.each(vectors.review_cases.map((c) => [c.name, c] as const))("applyReviewNotPerson: %s", (_, c) => {
    const s = toState(c.state);
    const copy = Float64Array.from(s.p);
    const out = applyReviewNotPerson(s, c.grid, c.lat, c.lon, c.radius_m, c.review_pod, c.pod_cap);
    expectClose(out, c.expected, 1e-9, c.name);
    expect(s.p).toEqual(copy);
    expect(out.p).not.toBe(s.p);
  });

  it("reports the largest difference", () => {
    console.info(`update.ts vs Python: largest absolute difference ${maxDiff}`);
    expect(maxDiff).toBeLessThanOrEqual(1e-9);
  });
});

describe("cellsWithinRadius tolerance", () => {
  // The 50x50 1 km grid of the fixture. At a cell centre, radius exactly 10 m must give the
  // cell and its 4 edge neighbours, as in Python.
  const grid = (vectors.radius_cases.find((c) => c.name.startsWith("50x50")) as { grid: Grid }).grid;
  const centreOf = (idx: number): [number, number] => {
    const row = Math.floor(idx / grid.cols);
    const col = idx % grid.cols;
    const mPerDegLon = 111_320 * Math.cos((grid.origin_nw.lat * Math.PI) / 180);
    return [
      grid.origin_nw.lat - ((row + 0.5) * grid.cell_m) / 111_320,
      grid.origin_nw.lon + ((col + 0.5) * grid.cell_m) / mPerDegLon,
    ];
  };

  it.each([51, 777, 1234, 1275, 1301])("r = 10 m at the centre of cell %i gives 5 cells", (idx) => {
    const [lat, lon] = centreOf(idx);
    const cols = grid.cols;
    expect(cellsWithinRadius(grid, lat, lon, 10)).toEqual(
      [idx - cols, idx - 1, idx, idx + 1, idx + cols].sort((a, b) => a - b),
    );
  });
});

describe("applyStep guards", () => {
  const s: MapState = { p: Float64Array.from([0.5, 0.5]), outside: 0 };

  it("rejects a pod outside [0, 1]", () => {
    expect(() => applyStep(s, [[0, 1.5]])).toThrow();
    expect(() => applyStep(s, [[0, -0.1]])).toThrow();
  });

  it("rejects a denominator <= 0", () => {
    expect(() => applyStep(s, [[0, 1], [1, 1]])).toThrow();
  });

  it("an empty step returns a copy", () => {
    const out = applyStep(s, []);
    expect(out.p).toEqual(s.p);
    expect(out.p).not.toBe(s.p);
  });
});

describe("sample map.json", () => {
  it("replaying every step on the prior gives final within 1e-6", () => {
    const map = JSON.parse(
      readFileSync(join(process.cwd(), "public/cache/sample/map.json"), "utf8"),
    ) as MapFile;
    const prior: MapState = { p: Float64Array.from(map.prior.p), outside: map.prior.outside };
    const out = replay(prior, map.steps, map.steps.length);
    expectClose(out, map.final, 1e-6, "sample final");
  });
});

describe("candidate sightings", () => {
  // 3 × 3 grid of 20 m cells; the point is the centre of cell 4 (the middle), radius 1 m: just cell 4.
  const grid: Grid = { origin_nw: { lat: 49.37, lon: -122.95 }, cell_m: 20, rows: 3, cols: 3 };
  const lat = 49.37 - 30 / 111_320;
  const lon = -122.95 + 30 / (111_320 * Math.cos((49.37 * Math.PI) / 180));
  const prior: MapState = { p: Float64Array.from([0.1, 0.05, 0.1, 0.05, 0.1, 0.05, 0.1, 0.05, 0.1]), outside: 0.3 };
  const photo = { cells: [[0, 0.5], [3, 0.6], [4, 0.8], [5, 0.4]] as [number, number][] };
  const later = { cells: [[1, 0.7], [4, 0.3], [8, 0.9]] as [number, number][] };

  it("applyReviewPerson undoes exactly that photo's look at the cells in the radius", () => {
    expect(cellsWithinRadius(grid, lat, lon, 1)).toEqual([4]);
    const flown = replay(prior, [photo, later], 2);
    const undone = applyReviewPerson(flown, grid, lat, lon, 1, photo);
    // The same as flying without that photo's look at cell 4 (updates commute).
    const without = replay(prior, [{ cells: photo.cells.filter(([i]) => i !== 4) }, later], 2);
    undone.p.forEach((v, i) => expect(v).toBeCloseTo(without.p[i] as number, 12));
    expect(undone.outside).toBeCloseTo(without.outside, 12);
    expect(undone.p.reduce((a, b) => a + b, 0) + undone.outside).toBeCloseTo(1, 12);
    // The sighted cell goes up; the later photo's look at it stays.
    expect(undone.p[4]!).toBeGreaterThan(flown.p[4]!);
  });

  it("applyReviewPerson changes nothing before the photo is flown, or where the photo had pod 0", () => {
    const flown = replay(prior, [photo], 1);
    const notYet = applyReviewPerson(flown, grid, lat, lon, 1, null);
    expect(Array.from(notYet.p)).toEqual(Array.from(flown.p));
    expect(notYet.p).not.toBe(flown.p);
    const held = applyReviewPerson(flown, grid, lat, lon, 1, { cells: [[0, 0.5]] });
    expect(Array.from(held.p)).toEqual(Array.from(flown.p));
  });

  it("mergeSightings joins sightings whose cells overlap and keeps the rest apart", () => {
    const areas = mergeSightings([
      { detectionId: "a", cells: [1, 2] },
      { detectionId: "b", cells: [7] },
      { detectionId: "c", cells: [2, 3] },
    ]);
    expect(areas).toEqual([
      { detectionIds: ["a", "c"], cells: [1, 2, 3] },
      { detectionIds: ["b"], cells: [7] },
    ]);
    // A chain a–c–d merges into one even when a and d do not touch.
    const chain = mergeSightings([
      { detectionId: "a", cells: [1] },
      { detectionId: "d", cells: [3] },
      { detectionId: "c", cells: [1, 3] },
    ]);
    expect(chain).toHaveLength(1);
  });

  it("candidateShares: P(S_i) / sum P(S_j); one area gets 100 %", () => {
    const one = candidateShares(prior, [{ detectionIds: ["a"], cells: [0, 1] }]);
    expect(one[0]!.share).toBe(1);
    expect(one[0]!.poa).toBeCloseTo(0.15, 12);
    const two = candidateShares(prior, [
      { detectionIds: ["a"], cells: [0] },
      { detectionIds: ["b"], cells: [1, 3, 5] },
    ]);
    expect(two[0]!.share).toBeCloseTo(0.1 / 0.25, 12);
    expect(two[1]!.share).toBeCloseTo(0.15 / 0.25, 12);
    const zero = candidateShares({ p: new Float64Array(9), outside: 1 }, [
      { detectionIds: ["a"], cells: [0] },
      { detectionIds: ["b"], cells: [1] },
    ]);
    expect(zero.map((z) => z.share)).toEqual([0.5, 0.5]);
  });
});
