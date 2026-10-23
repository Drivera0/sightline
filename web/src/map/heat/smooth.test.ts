import { describe, expect, it } from "vitest";
import { CELL } from "./classes";
import { evenOdd, evidenceless, marchingRings, outline, searchedMask, simplifyRing, smoothKinds, smoothSurface, wholeGridKinds } from "./smooth";

const N = 40;
const GRID = { origin_nw: { lat: 49.37, lon: -122.95 }, cell_m: 5, rows: N, cols: N };
const disc = (cx: number, cy: number, r: number) => {
  const m = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) m[y * N + x] = 1;
  return m;
};
const area = (ring: [number, number][]) => Math.abs(ring.reduce((a, p, i) => { const q = ring[(i + 1) % ring.length]!; return a + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;

describe("the dissolved heat", () => {
  it("traces a region as one closed, simplified ring: no per-cell staircase", () => {
    const rings = outline(disc(20, 20, 10), N, N);
    expect(rings).toHaveLength(1);
    expect(area(rings[0]!)).toBeGreaterThan(Math.PI * 9.5 ** 2 * 0.9);
    expect(area(rings[0]!)).toBeLessThan(Math.PI * 10.5 ** 2 * 1.1);
    // a staircase around a 10-cell disc has ~80 corners; the traced, simplified line far fewer
    expect(rings[0]!.length).toBeLessThan(40);
  });

  it("leaves specks out", () => {
    const m = disc(20, 20, 10);
    m[2 * N + 2] = 1;
    expect(outline(m, N, N)).toHaveLength(1);
  });

  it("fills a band as the even-odd area between two nested levels (a hole where the inner level is)", () => {
    const inner = marchingRings(Float32Array.from(disc(20, 20, 5)), N, N);
    const outer = marchingRings(Float32Array.from(disc(20, 20, 12)), N, N);
    const polys = evenOdd([...outer, ...inner]);
    expect(polys).toHaveLength(1);
    expect(polys[0]).toHaveLength(2); // the outer ring and one hole
    expect(simplifyRing(polys[0]![0]!, 0.3).length).toBeLessThanOrEqual(polys[0]![0]!.length);
  });

  it("draws no classes on a flat map (the prior before anything is known)", () => {
    const kinds = wholeGridKinds(new Float64Array(N * N).fill(1 / (N * N)));
    expect(kinds.every((k) => k === CELL.none)).toBe(true);
  });

  it("draws nothing on a prior within 5 % of flat, even with a few odd cells (the demo's grid corners)", () => {
    const p = new Float64Array(N * N).fill(1);
    p[0] = p[N - 1] = 0.5; // two corner cells in the next ring out
    for (let i = 0; i < N; i++) p[N * N - 1 - i] = 1.04; // within 5 %
    expect(wholeGridKinds(p).every((k) => k === CELL.none)).toBe(true);
  });

  it("classes the probability above an even spread: rings around the last known point, likeliest in the middle", () => {
    // 1/r around the centre (a ring prior spread by distance): the classes nest outward
    const p = new Float64Array(N * N);
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) p[y * N + x] = 1 / Math.max(1, Math.hypot(x - 20, y - 20));
    const kinds = wholeGridKinds(p);
    const at = (x: number, y: number) => kinds[y * N + x];
    expect(at(20, 20)).toBe(CELL.top);
    expect(at(39, 20)).toBe(CELL.none); // the far edge is below an even spread: no fill
    // three classes, each further out than the last
    const radius = (k: number) => Math.max(...[...kinds.keys()].filter((i) => kinds[i] === k).map((i) => Math.hypot((i % N) - 20, Math.floor(i / N) - 20)));
    expect(radius(CELL.top)).toBeLessThan(radius(CELL.mid));
    expect(radius(CELL.mid)).toBeLessThan(radius(CELL.low));
  });

  it("marks ground a search lowered, never ground a clue raised or lowered", () => {
    const updates = [
      { kind: "step", cells: [[0, 0.6], [1, 0.05]] as [number, number][] },
      { kind: "step", cells: [[1, 0.06]] as [number, number][] },
      { kind: "reweight", cells: [[2, 0.2], [3, 4]] as [number, number][] },
    ];
    const m = searchedMask(4, updates);
    expect([...m]).toEqual([1, 1, 0, 0]); // cell 1: 0.95 × 0.94 < 0.9
    const p = Float64Array.from([0.5, 0.9, 1, 3]);
    const kinds = wholeGridKinds(p, null, m);
    expect(kinds[0]).toBe(CELL.searched);
    expect(kinds[3]).toBe(CELL.top);
    expect(evidenceless(kinds)).toBe(false);
    expect(evidenceless(wholeGridKinds(new Float64Array(16).fill(1)))).toBe(true);
    // the searched band is drawn under the classes
    const half = Uint8Array.from({ length: N * N }, (_, i) => (i % N < N / 2 ? 1 : 0));
    const s = smoothSurface(GRID, wholeGridKinds(new Float64Array(N * N).fill(1), null, half), null, undefined, half);
    expect(s.fills.features.map((f) => f.properties.kind)).toEqual([CELL.searched]);
  });

  it("classes the whole grid, photographed or not, and hatches what no photo has seen", () => {
    const p = new Float64Array(N * N).fill(0);
    for (let i = 0; i < N * N; i++) p[i] = disc(20, 20, 8)[i] ? 2 : 0.1;
    const kinds = wholeGridKinds(p);
    expect(kinds[20 * N + 20]).toBe(CELL.top);
    expect(kinds.some((k) => k === CELL.veil)).toBe(false); // the classes ignore what was photographed
    const photographed = disc(10, 10, 6);
    const s = smoothSurface(GRID, kinds, photographed);
    const kindsDrawn = s.fills.features.map((f) => f.properties.kind);
    expect(kindsDrawn).toContain(CELL.top);
    expect(kindsDrawn).toContain(CELL.veil); // the hatch over unphotographed ground
    expect(s.contours.features.map((f) => f.properties.level).sort()).toEqual([50, 90]);
    const sk = smoothKinds(GRID, kinds);
    expect(sk[20 * N + 20]).toBe(CELL.top);
  });
});
