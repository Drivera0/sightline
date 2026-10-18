import { describe, expect, it } from "vitest";
import {
  expectedFirstPositive,
  expectedLastPositive,
  lastPositiveCdf,
  lastPositiveQuantile,
  randomOrderBaseline,
} from "./randomOrder";

/** Every placement of k positives among n frames, by brute force (small n only). */
function allLastPositions(n: number, k: number): number[] {
  const out: number[] = [];
  const pick = (start: number, left: number, last: number) => {
    if (left === 0) {
      out.push(last);
      return;
    }
    for (let p = start; p <= n; p++) pick(p + 1, left - 1, p);
  };
  pick(1, k, 0);
  return out;
}

/** A small seeded PRNG (mulberry32) for the Monte Carlo cross-check. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("expectedLastPositive", () => {
  it("is k(N+1)/(k+1): N=500, k=6 gives about 429", () => {
    expect(expectedLastPositive(500, 6)).toBeCloseTo(3006 / 7, 10);
    expect(Math.round(expectedLastPositive(500, 6))).toBe(429);
  });

  it("matches the brute-force mean over every placement", () => {
    for (const [n, k] of [
      [5, 1],
      [6, 2],
      [9, 3],
      [10, 10],
    ] as const) {
      const last = allLastPositions(n, k);
      const mean = last.reduce((s, x) => s + x, 0) / last.length;
      expect(expectedLastPositive(n, k)).toBeCloseTo(mean, 10);
    }
  });

  it("mirrors the first positive's (N+1)/(k+1), which metrics.json already reports", () => {
    expect(expectedFirstPositive(500, 6)).toBeCloseTo(71.571, 3);
    expect(expectedFirstPositive(500, 6) + expectedLastPositive(500, 6)).toBeCloseTo(501, 10);
  });

  it("rejects impossible counts", () => {
    expect(() => expectedLastPositive(5, 0)).toThrow(RangeError);
    expect(() => expectedLastPositive(5, 6)).toThrow(RangeError);
  });
});

describe("lastPositiveCdf and lastPositiveQuantile", () => {
  it("match the brute-force distribution exactly", () => {
    const n = 9;
    const k = 3;
    const last = allLastPositions(n, k);
    for (let m = 0; m <= n; m++) {
      const share = last.filter((x) => x <= m).length / last.length;
      expect(lastPositiveCdf(n, k, m)).toBeCloseTo(share, 12);
    }
    const sorted = [...last].sort((a, b) => a - b);
    for (const q of [0.1, 0.25, 0.5, 0.9, 1]) {
      // Smallest m with at least q of all placements at or below it.
      const expected = sorted[Math.ceil(q * sorted.length) - 1];
      expect(lastPositiveQuantile(n, k, q)).toBe(expected);
    }
  });

  it("gives the 10th-90th percentile spread for the demo survey, consistent with a seeded simulation", () => {
    const p10 = lastPositiveQuantile(500, 6, 0.1);
    const p90 = lastPositiveQuantile(500, 6, 0.9);
    expect(lastPositiveCdf(500, 6, p10)).toBeGreaterThanOrEqual(0.1);
    expect(lastPositiveCdf(500, 6, p10 - 1)).toBeLessThan(0.1);
    expect(lastPositiveCdf(500, 6, p90)).toBeGreaterThanOrEqual(0.9);
    expect(lastPositiveCdf(500, 6, p90 - 1)).toBeLessThan(0.9);

    // Monte Carlo cross-check: 20,000 seeded shuffles land within a few positions.
    const rand = rng(7);
    const trials = 20_000;
    const lasts: number[] = [];
    for (let t = 0; t < trials; t++) {
      const chosen = new Set<number>();
      while (chosen.size < 6) chosen.add(1 + Math.floor(rand() * 500));
      lasts.push(Math.max(...chosen));
    }
    lasts.sort((a, b) => a - b);
    expect(Math.abs(lasts[Math.ceil(0.1 * trials) - 1]! - p10)).toBeLessThanOrEqual(5);
    expect(Math.abs(lasts[Math.ceil(0.9 * trials) - 1]! - p90)).toBeLessThanOrEqual(3);
    const mean = lasts.reduce((s, x) => s + x, 0) / trials;
    expect(Math.abs(mean - expectedLastPositive(500, 6))).toBeLessThan(2);
  });
});

describe("randomOrderBaseline", () => {
  it("bundles the expectation and spread, and is null when there is nothing to reorder", () => {
    const b = randomOrderBaseline(500, 6)!;
    expect(b.expectedAll).toBeCloseTo(429.43, 2);
    expect(b.p10All).toBeLessThan(b.expectedAll);
    expect(b.p90All).toBeGreaterThan(b.expectedAll);
    expect(randomOrderBaseline(10, 10)).toBeNull();
    expect(randomOrderBaseline(10, 0)).toBeNull();
  });
});
