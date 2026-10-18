import { describe, expect, it, vi } from "vitest";
import type { Map } from "maplibre-gl";
import { MAP_LAYER_IDS } from "../base/layerIds";
import {
  bearingDeg,
  ensureHeatLayers,
  HEAT_LAYER_IDS,
  HEAT_SOURCE_ID,
  refreshHeatSource,
  replayFeatures,
  rippleFrame,
  RIPPLE_FROM_PX,
  RIPPLE_TO_PX,
  sectorFeatures,
  setFlightPathVisible,
  type HeatColors,
  BREATH_AMPLITUDE,
  BREATH_PERIOD_MS,
  breathFactor,
  HEAT_BASE_OPACITY,
  HOTSPOT_OPACITY,
  hotspotFeatures,
  pushHotspots,
  setBreath,
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
  const colors: HeatColors = { accent: "#acc", outline: "#out", veil: "#bg", review: "#rev", ok: "#ok" };
  const grid = { origin_nw: { lat: 49.37, lon: -122.95 }, cell_m: 20, rows: 1, cols: 2 };
  const canvas = { width: 2, height: 1 } as unknown as HTMLCanvasElement;
  function install(variant: "search" | "review" = "search") {
    const layers: { id: string; type: string; paint?: Record<string, unknown>; layout?: Record<string, unknown> }[] = [];
    const sources = new globalThis.Map<string, Record<string, unknown>>();
    const map = {
      getSource: (id: string) => sources.get(id),
      addSource: (id: string, spec: Record<string, unknown>) => sources.set(id, spec),
      getLayer: (id: string) => layers.find((l) => l.id === id),
      addLayer: (layer: (typeof layers)[number]) => layers.push(layer),
    } as unknown as Map;
    ensureHeatLayers(map, { canvas }, grid, new Uint8Array(2), colors, variant);
    return { layer: (id: string) => layers.find((l) => l.id === id), sources, layers };
  }

  it("draws the cells as one canvas raster over the grid, crisp (nearest) and never blurred", () => {
    const { layer, sources } = install();
    const source = sources.get(HEAT_SOURCE_ID)!;
    expect(source).toMatchObject({ type: "canvas", canvas, animate: false });
    // NW, NE, SE, SW corners of the grid.
    const corners = source.coordinates as [number, number][];
    expect(corners[0]).toEqual([-122.95, 49.37]);
    expect(corners[2]![0]).toBeGreaterThan(-122.95);
    expect(corners[2]![1]).toBeLessThan(49.37);
    const cells = layer(HEAT_LAYER_IDS.cells)!;
    expect(cells.type).toBe("raster");
    expect(cells.paint!["raster-resampling"]).toBe("nearest");
  });

  it("outlines held cells with a dashed warn line from their merged boundary", () => {
    const outline = install().layer(HEAT_LAYER_IDS.reviewOutline)!;
    expect(outline.paint!["line-color"]).toBe("#rev");
    expect(outline.paint!["line-dasharray"]).toBeDefined();
  });

  it("draws the replay drone as a rotated symbol only on Search next", () => {
    const drone = install().layer(HEAT_LAYER_IDS.drone)!;
    expect(drone.type).toBe("symbol");
    expect(drone.layout!["icon-rotate"]).toEqual(["get", "bearing"]);
    expect(drone.layout!["icon-rotation-alignment"]).toBe("map");
    const review = install("review");
    expect(review.layer(HEAT_LAYER_IDS.drone)).toBeUndefined();
    expect(review.layer(HEAT_LAYER_IDS.hotspots)).toBeUndefined();
    expect(review.layer(HEAT_LAYER_IDS.cells)!.paint!["raster-opacity"]).toBeLessThan(
      install().layer(HEAT_LAYER_IDS.cells)!.paint!["raster-opacity"] as number,
    );
    expect(review.layer(HEAT_LAYER_IDS.ripple)).toBeDefined();
  });
});

describe("refreshHeatSource", () => {
  it("re-uploads every frame while playing and uploads once then stops otherwise", () => {
    const play = vi.fn();
    const pause = vi.fn();
    const map = { getSource: (id: string) => (id === HEAT_SOURCE_ID ? { play, pause } : undefined) } as unknown as Map;
    refreshHeatSource(map, true);
    expect(play).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();
    refreshHeatSource(map, false);
    expect(pause).toHaveBeenCalledTimes(1);
    // Before the source exists, or before it has loaded (no play yet): nothing happens.
    expect(() => refreshHeatSource({ getSource: () => ({}) } as unknown as Map, false)).not.toThrow();
  });
});

describe("ripple and heading", () => {
  it("grows and fades the ripple from start to end", () => {
    expect(rippleFrame(0)).toEqual({ radius: RIPPLE_FROM_PX, opacity: 0.95 });
    expect(rippleFrame(1).radius).toBeCloseTo(RIPPLE_TO_PX, 9);
    expect(rippleFrame(1).opacity).toBe(0);
    expect(rippleFrame(0.5).radius).toBeGreaterThan(RIPPLE_FROM_PX);
  });

  it("gives compass bearings (0 north, 90 east)", () => {
    expect(bearingDeg([0, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(bearingDeg([0, 0], [1, 0])).toBeCloseTo(90, 6);
    expect(bearingDeg([0, 0], [0, -1])).toBeCloseTo(180, 6);
    expect(bearingDeg([0, 0], [-1, 0])).toBeCloseTo(270, 6);
  });

  it("points the drone along the leg it just flew", () => {
    const { drone } = replayFeatures(path, 2);
    expect(drone).toMatchObject({ properties: { bearing: 90 } });
  });
});

describe("sectorFeatures", () => {
  it("marks the current and hovered sectors and puts the state in their labels only", () => {
    const grid = { origin_nw: { lat: 49.37, lon: -122.95 }, cell_m: 250, rows: 4, cols: 4 };
    const sector = (id: string, kind: "flight" | "outer") => ({
      id,
      label: id,
      kind,
      rect: { west: 0, east: 500, north: 0, south: 250 },
    });
    const statuses = [
      { sector: sector("1", "flight"), poa: 0.1, coverage: 1, cells: 2, state: "searched" as const },
      { sector: sector("N", "outer"), poa: 0.2, coverage: 0, cells: 2, state: "not_searched" as const },
      { sector: sector("S", "outer"), poa: 0.2, coverage: 0, cells: 2, state: "not_searched" as const },
    ];
    const { areas, labels } = sectorFeatures(grid, statuses, "1", "N");
    const a = (areas as { features: { properties: Record<string, unknown> }[] }).features;
    expect(a.map((f) => [f.properties.current, f.properties.hover])).toEqual([
      [true, false],
      [false, true],
      [false, false],
    ]);
    const l = (labels as { features: { properties: Record<string, unknown> }[] }).features;
    expect(l[0]!.properties.text).toBe(["SECTOR 1", "Drone here"].join(String.fromCharCode(10)));
    expect(l[1]!.properties.text).toBe(["SECTOR N", "Not yet searched"].join(String.fromCharCode(10)));
    expect(l[2]!.properties.text).toBe("SECTOR S");
    // A flight strip is labelled outside its west edge; N just above the photographed area's
    // north-west corner, S just below its south-west corner.
    expect(l[0]!.properties.anchor).toBe("right");
    expect(l[1]!.properties.anchor).toBe("bottom-left");
    expect(l[2]!.properties.anchor).toBe("top-left");
  });

  it("uses the next candidate when the first does not fit, and leaves out a label none fits", () => {
    const grid = { origin_nw: { lat: 49.37, lon: -122.95 }, cell_m: 250, rows: 4, cols: 4 };
    const flight = {
      sector: { id: "S1", label: "1", kind: "flight" as const, rect: { west: 250, east: 750, north: 250, south: 500 } },
      poa: 0.1,
      coverage: 1,
      cells: 2,
      state: "searched" as const,
    };
    const outer = { ...flight, sector: { ...flight.sector, id: "E", label: "E", kind: "outer" as const } };
    // The outside-west spot is "covered" (e.g. by the sectors panel): fall back inside the strip.
    const { labels } = sectorFeatures(grid, [flight, outer], null, null, (candidates) =>
      candidates[0]!.anchor === "right" ? (candidates[1] ?? null) : null,
    );
    const l = (labels as { features: { properties: Record<string, unknown> }[] }).features;
    expect(l).toHaveLength(1);
    expect(l[0]!.properties.anchor).toBe("left");
    expect(l[0]!.properties.justify).toBe("left");
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

describe("breathing", () => {
  it("stays within ±BREATH_AMPLITUDE and repeats every BREATH_PERIOD_MS", () => {
    for (let t = 0; t < 2 * BREATH_PERIOD_MS; t += 137) {
      const f = breathFactor(t);
      expect(f).toBeGreaterThanOrEqual(1 - BREATH_AMPLITUDE - 1e-9);
      expect(f).toBeLessThanOrEqual(1 + BREATH_AMPLITUDE + 1e-9);
      expect(breathFactor(t + BREATH_PERIOD_MS)).toBeCloseTo(f, 9);
    }
    expect(breathFactor(BREATH_PERIOD_MS / 4)).toBeCloseTo(1 + BREATH_AMPLITUDE, 9);
  });

  it("scales the heat and the hotspot outline together, and skips layers not drawn yet", () => {
    const setPaintProperty = vi.fn();
    const drawn = new Set<string>([HEAT_LAYER_IDS.cells, HEAT_LAYER_IDS.hotspots]);
    const map = { getLayer: (id: string) => (drawn.has(id) ? {} : undefined), setPaintProperty } as unknown as Map;
    setBreath(map, 1 + BREATH_AMPLITUDE);
    const heat = setPaintProperty.mock.calls.find((c) => c[0] === HEAT_LAYER_IDS.cells)!;
    expect(heat[1]).toBe("raster-opacity");
    expect(heat[2]).toBeCloseTo(Math.min(1, HEAT_BASE_OPACITY.search * (1 + BREATH_AMPLITUDE)), 9);
    const glow = setPaintProperty.mock.calls.find((c) => c[0] === HEAT_LAYER_IDS.hotspots && c[1] === "circle-stroke-opacity")!;
    expect(glow[2]).toBeCloseTo(HOTSPOT_OPACITY.high, 9);
    setPaintProperty.mockClear();
    drawn.clear();
    setBreath(map, 1);
    expect(setPaintProperty).not.toHaveBeenCalled();
  });

  it("puts a ring at the centre of each Search next cell, in rank order", () => {
    const grid = { origin_nw: { lat: 49.37, lon: -122.95 }, cell_m: 10, rows: 100, cols: 100 };
    const data = hotspotFeatures(grid, [0, 5050]) as {
      features: { properties: { rank: number }; geometry: { type: string; coordinates: number[] } }[];
    };
    expect(data.features.map((f) => f.properties.rank)).toEqual([1, 2]);
    const [lon, lat] = data.features[0]!.geometry.coordinates as [number, number];
    expect(data.features[0]!.geometry.type).toBe("Point");
    // Cell 0 is the north-west cell: its centre is just south-east of the grid origin.
    expect(lat).toBeLessThan(grid.origin_nw.lat);
    expect(lon).toBeGreaterThan(grid.origin_nw.lon);
  });

  it("draws however many cells exist (a small survey can have fewer than 5, or none)", () => {
    const grid = { origin_nw: { lat: 49.37, lon: -122.95 }, cell_m: 20, rows: 50, cols: 50 };
    const few = hotspotFeatures(grid, [7, 3]) as { features: unknown[] };
    expect(few.features).toHaveLength(2);
    const none = hotspotFeatures(grid, []) as { type: string; features: unknown[] };
    expect(none).toEqual({ type: "FeatureCollection", features: [] });
    // Before the layers are installed there is no source: pushing does nothing and does not throw.
    const map = { getSource: () => undefined } as unknown as Map;
    expect(() => pushHotspots(map, grid, [1, 2, 3])).not.toThrow();
  });
});
