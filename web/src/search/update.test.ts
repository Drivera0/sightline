import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MapFile } from "../contract";
import { applyReviewNotPerson, applyStep, cellsWithinRadius, replay, type MapState } from "./update";

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
