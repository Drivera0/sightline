import { describe, expect, it } from "vitest";
import { CELL } from "./classes";
import { evenOdd, marchingRings, outline, simplifyRing, smoothKinds, smoothSurface, wholeGridKinds } from "./smooth";

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
