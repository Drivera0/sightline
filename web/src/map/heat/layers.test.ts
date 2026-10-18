import { describe, expect, it } from "vitest";
import { maxCovered, replayFeatures } from "./layers";

const path: [number, number][] = [
  [0, 0],
  [1, 0],
  [2, 0],
];

describe("replayFeatures", () => {
  it("draws nothing before the first frame", () => {
    const { trail, drone } = replayFeatures(path, 0);
    expect(trail).toEqual({ type: "FeatureCollection", features: [] });
    expect(drone).toEqual({ type: "FeatureCollection", features: [] });
  });

  it("puts the drone on the first frame with no trail yet", () => {
    const { trail, drone } = replayFeatures(path, 1);
    expect(trail).toEqual({ type: "FeatureCollection", features: [] });
    expect(drone).toMatchObject({ geometry: { type: "Point", coordinates: [0, 0] } });
  });

  it("trails the frames flown so far and puts the drone on the latest", () => {
    const { trail, drone } = replayFeatures(path, 2);
    expect(trail).toMatchObject({ geometry: { type: "LineString", coordinates: [[0, 0], [1, 0]] } });
    expect(drone).toMatchObject({ geometry: { coordinates: [1, 0] } });
  });

  it("clamps a step past the end to the last frame", () => {
    expect(replayFeatures(path, 9).drone).toMatchObject({ geometry: { coordinates: [2, 0] } });
  });
});

describe("maxCovered", () => {
  it("ignores unphotographed cells, so they cannot wash out the heat", () => {
    expect(maxCovered(Float64Array.from([0.9, 0.2, 0.3]), Uint8Array.from([0, 1, 1]))).toBe(0.3);
  });
});
