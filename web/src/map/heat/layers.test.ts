import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { Map } from "maplibre-gl";
import { MAP_LAYER_IDS } from "../base/layerIds";
import { replayFeatures, setFlightPathVisible } from "./layers";

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

describe("setFlightPathVisible", () => {
  it("hides and shows lane B's path and chevrons, and skips layers not drawn yet", () => {
    const setLayoutProperty = vi.fn();
    const drawn = new Set<string>([MAP_LAYER_IDS.flightPath]);
    const map = { getLayer: (id: string) => (drawn.has(id) ? {} : undefined), setLayoutProperty } as unknown as Map;
    setFlightPathVisible(map, false);
    expect(setLayoutProperty).toHaveBeenCalledTimes(1);
    expect(setLayoutProperty).toHaveBeenCalledWith(MAP_LAYER_IDS.flightPath, "visibility", "none");
    drawn.add(MAP_LAYER_IDS.flightDirection);
    setFlightPathVisible(map, true);
    expect(setLayoutProperty).toHaveBeenCalledWith(MAP_LAYER_IDS.flightDirection, "visibility", "visible");
  });
});
