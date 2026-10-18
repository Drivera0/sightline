import { describe, expect, it } from "vitest";
import type { CacheBundle } from "../contract";
import { CLEAR_MS, HIT_MS, REJECT_MS, scanDurationMs, scanStops } from "./scan";

function cache(nFrames: number, hitFrames: Record<number, number[]>): Pick<CacheBundle, "survey" | "detections"> {
  // Frames listed out of flight order on purpose: the scan must sort them.
  const frames = Array.from({ length: nFrames }, (_, i) => ({
    id: `f${nFrames - i}`,
    flight_index: nFrames - i,
  }));
  const detections: Record<string, { id: string; conf: number }[]> = {};
  for (const [index, confs] of Object.entries(hitFrames)) {
    detections[`f${index}`] = confs.map((conf, k) => ({ id: `f${index}-d${k}`, conf }));
  }
  return {
    survey: { frames } as unknown as CacheBundle["survey"],
    detections: { candidate_threshold: 0.3, frames: detections } as unknown as CacheBundle["detections"],
  };
}

describe("scanStops", () => {
  it("keeps every frame with a candidate, in flight order", () => {
    const stops = scanStops(cache(100, { 40: [0.9], 7: [0.5, 0.1] }), 0);
    expect(stops.map((s) => s.frame.id)).toEqual(["f7", "f40"]);
    expect(stops[0]!.position).toBe(6);
    // Detections below the candidate threshold are not hits.
    expect(stops[0]!.hits.map((d) => d.id)).toEqual(["f7-d0"]);
  });

  it("shows a frame whose detections are all below the threshold as rejected, not as a hit", () => {
    const stops = scanStops(cache(10, { 3: [0.1] }), 0);
    expect(stops).toHaveLength(1);
    expect(stops[0]!.hits).toEqual([]);
    expect(stops[0]!.rejected.map((d) => d.conf)).toEqual([0.1]);
  });

  it("never shows a rejected box on a frame that has a candidate", () => {
    const stops = scanStops(cache(10, { 4: [0.9, 0.1] }), 0);
    expect(stops[0]!.rejected).toEqual([]);
  });

  it("keeps the highest-scoring rejected frames", () => {
    const stops = scanStops(cache(10, { 2: [0.05], 5: [0.2], 8: [0.12] }), 0, 8, 2);
    expect(stops.map((s) => s.frame.id)).toEqual(["f5", "f8"]);
  });

  it("spreads the clear frames over the whole flight", () => {
    const stops = scanStops(cache(100, {}), 4);
    expect(stops.map((s) => s.position)).toEqual([0, 25, 50, 75]);
    expect(stops.every((s) => s.hits.length === 0)).toBe(true);
  });

  it("stops on the most confident hits when there are more than maxHits", () => {
    const stops = scanStops(cache(10, { 2: [0.4], 5: [0.9], 8: [0.6] }), 0, 2);
    expect(stops.map((s) => s.frame.id)).toEqual(["f5", "f8"]);
  });

  it("never asks for more clear frames than exist", () => {
    expect(scanStops(cache(3, { 2: [0.8] }), 30)).toHaveLength(3);
  });
});

describe("scanDurationMs", () => {
  it("rests longer on hits than on clear photos", () => {
    const stops = scanStops(cache(10, { 2: [0.8], 6: [0.1] }), 2);
    expect(scanDurationMs(stops)).toBe(HIT_MS + REJECT_MS + 2 * CLEAR_MS);
  });
});
