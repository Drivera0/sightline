import { describe, expect, it, vi } from "vitest";
import type { Map } from "maplibre-gl";
import { MAP_LAYER_IDS } from "../base/layerIds";
import { HEAT_CEIL, HEAT_FLOOR } from "./geometry";
import {
  ensureHeatLayers,
  HEAT_LAYER_IDS,
  replayFeatures,
  REVIEW_OPACITY,
  setFlightPathVisible,
  UNSEEN_OPACITY,
  type HeatColors,
} from "./layers";

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

describe("ensureHeatLayers paint", () => {
  const colors: HeatColors = { accent: "#acc", warm: "#warm", outline: "#out", veil: "#bg", review: "#rev" };
  const grid = { origin_nw: { lat: 49.37, lon: -122.95 }, cell_m: 20, rows: 1, cols: 2 };
  function install() {
    const layers: { id: string; paint?: Record<string, unknown> }[] = [];
    const sources = new Set<string>();
    const map = {
      getSource: (id: string) => (sources.has(id) ? {} : undefined),
      addSource: (id: string) => sources.add(id),
      getLayer: (id: string) => layers.find((l) => l.id === id),
      addLayer: (layer: { id: string; paint?: Record<string, unknown> }) => layers.push(layer),
    } as unknown as Map;
    ensureHeatLayers(map, { type: "FeatureCollection", features: [] }, grid, new Uint8Array(2), colors);
    return (id: string) => layers.find((l) => l.id === id)!.paint!;
  }

  it("veils not-yet-searched cells (feature state u) in the background colour at the veil opacity", () => {
    const paint = install()(HEAT_LAYER_IDS.unsearched);
    expect(paint["fill-color"]).toBe("#bg");
    expect(paint["fill-opacity"]).toEqual(["case", ["==", ["coalesce", ["feature-state", "u"], 0], 1], UNSEEN_OPACITY, 0]);
  });

  it("ramps the heat from warm to the accent over the stretched opacity o", () => {
    const paint = install()(HEAT_LAYER_IDS.cells);
    const o = ["coalesce", ["feature-state", "o"], 0];
    expect(paint["fill-color"]).toEqual(["interpolate", ["linear"], o, HEAT_FLOOR, "#warm", HEAT_CEIL, "#acc"]);
  });

  it("gives held cells (feature state h) a warn fill and a dashed warn outline", () => {
    const get = install();
    const h = ["==", ["coalesce", ["feature-state", "h"], 0], 1];
    expect(get(HEAT_LAYER_IDS.review)["fill-opacity"]).toEqual(["case", h, REVIEW_OPACITY, 0]);
    const outline = get(HEAT_LAYER_IDS.reviewOutline);
    expect(outline["line-color"]).toBe("#rev");
    expect(outline["line-opacity"]).toEqual(["case", h, 0.9, 0]);
    expect(outline["line-dasharray"]).toBeDefined();
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
